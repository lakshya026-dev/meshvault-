import { randomUUID } from 'node:crypto';
import { DatabaseManager } from '../database/db.js';
import { NodeConfig } from '../config/node.js';
import {
  Operation,
  CreateOperationInput,
  RecordEntity,
  OperationType,
  OperationStatus,
  CURRENT_SCHEMA_VERSION,
  isSupportedSchemaVersion,
} from './types.js';
import {
  InvalidOperationError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  DuplicateOperationError,
  OperationIntegrityError,
} from '../errors.js';
import { OperationValidator } from './validator.js';
import { computeOperationChecksum, verifyOperationIntegrity } from './integrity.js';

interface RawOperationRow {
  operation_id: string;
  node_id: string;
  sequence_number: number;
  operation_type: string;
  entity_type: string;
  entity_id: string;
  payload: string;
  status: string;
  created_at: string;
  applied_at: string | null;
  checksum: string;
  error_message: string | null;
  schema_version: number;
}

interface RawRecordRow {
  id: string;
  entity_type: string;
  data: string;
  created_at: string;
  updated_at: string;
}

export class OperationManager {
  private dbManager: DatabaseManager;
  private nodeConfig: NodeConfig;

  constructor(dbManager: DatabaseManager, nodeConfig: NodeConfig) {
    this.dbManager = dbManager;
    this.nodeConfig = nodeConfig;
  }

  public getNodeId(): string {
    return this.nodeConfig.getNodeId();
  }

  public getCurrentSequenceNumber(nodeId?: string): number {
    const rawDb = this.dbManager.getRawDb();
    const targetNodeId = nodeId ?? this.getNodeId();
    const result = (rawDb
      .prepare(
        'SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM operations WHERE node_id = ?'
      )
      .get(targetNodeId) as unknown) as { max_seq: number } | undefined;

    return result ? Number(result.max_seq) : 0;
  }

  public getNextSequenceNumber(nodeId?: string): number {
    return this.getCurrentSequenceNumber(nodeId) + 1;
  }

  public getSequenceVector(): Record<string, number> {
    const rawDb = this.dbManager.getRawDb();
    const rows = rawDb
      .prepare(
        'SELECT node_id, MAX(sequence_number) AS max_sequence_number FROM operations GROUP BY node_id'
      )
      .all() as { node_id: string; max_sequence_number: number }[];

    return Object.fromEntries(
      rows.map((row) => [row.node_id, Number(row.max_sequence_number)])
    );
  }

  public createOperation<T extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateOperationInput<T>
  ): Operation<T> {
    OperationValidator.validateCreateInput(input);

    return this.dbManager.transaction(() => {
      const rawDb = this.dbManager.getRawDb();

      // Check if explicit operationId already exists
      if (input.operationId) {
        const existingOp = rawDb
          .prepare('SELECT operation_id FROM operations WHERE operation_id = ?')
          .get(input.operationId);
        if (existingOp) {
          throw new DuplicateOperationError(input.operationId);
        }
      }

      // Validate entity state before creating operation
      const existingRecord = this.getRecord(input.entityId, input.entityType);
      if (input.operationType === 'CREATE' && existingRecord) {
        throw new EntityAlreadyExistsError(input.entityType, input.entityId);
      }
      if (input.operationType === 'UPDATE' && !existingRecord) {
        throw new EntityNotFoundError(input.entityType, input.entityId);
      }
      if (input.operationType === 'DELETE' && !existingRecord) {
        throw new EntityNotFoundError(input.entityType, input.entityId);
      }

      const nodeId = this.getNodeId();
      const sequenceNumber = this.getNextSequenceNumber(nodeId);
      const operationId =
        input.operationId ??
        `op-${String(sequenceNumber).padStart(3, '0')}-${randomUUID().slice(0, 6)}`;
      const createdAt = new Date().toISOString();

      // Normalize schemaVersion: use input value if supplied, otherwise default to CURRENT_SCHEMA_VERSION.
      // Legacy/unversioned input (schemaVersion omitted) gets CURRENT_SCHEMA_VERSION for newly created ops.
      const schemaVersion: number =
        typeof input.schemaVersion === 'number' ? input.schemaVersion : CURRENT_SCHEMA_VERSION;

      // Compute deterministic SHA-256 integrity checksum.
      // schemaVersion participates in the canonical hash for v2+ operations
      // (9-field formula). v1 operations use the original 8-field formula.
      const checksum = computeOperationChecksum({
        operationId,
        nodeId,
        sequenceNumber,
        operationType: input.operationType,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload,
        createdAt,
        schemaVersion,
      });

      const operation: Operation<T> = {
        operationId,
        nodeId,
        sequenceNumber,
        operationType: input.operationType,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload,
        status: 'PENDING',
        createdAt,
        appliedAt: null,
        checksum,
        errorMessage: null,
        schemaVersion,
      };

      // Validate the constructed operation
      OperationValidator.validateOperation(operation);

      // 1. Store operation in SQLite operations table with status 'PENDING'
      rawDb
        .prepare(
          `INSERT INTO operations (
            operation_id, node_id, sequence_number, operation_type,
            entity_type, entity_id, payload, status, created_at, applied_at,
            checksum, error_message, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          operation.operationId,
          operation.nodeId,
          operation.sequenceNumber,
          operation.operationType,
          operation.entityType,
          operation.entityId,
          JSON.stringify(operation.payload),
          operation.status,
          operation.createdAt,
          null,
          operation.checksum,
          null,
          operation.schemaVersion
        );

      // 2. Apply operation to local state and transition PENDING -> APPLIED
      return this.applyOperation(operation);
    });
  }

  public applyOperation<T extends Record<string, unknown> = Record<string, unknown>>(
    operation: Operation<T>
  ): Operation<T> {
    OperationValidator.validateOperation(operation);

    // Verify operation integrity before touching state
    if (!verifyOperationIntegrity(operation)) {
      throw new OperationIntegrityError(
        `Operation '${operation.operationId}' failed integrity verification. Checksum mismatch.`
      );
    }

    const rawDb = this.dbManager.getRawDb();
    const now = new Date().toISOString();

    return this.dbManager.transaction(() => {
      // Check if operation is already recorded in the operations log
      const existingOpRow = (rawDb
        .prepare('SELECT * FROM operations WHERE operation_id = ?')
        .get(operation.operationId) as unknown) as RawOperationRow | undefined;

      if (existingOpRow) {
        // Reject if existing operation has a different checksum (tampering / conflict)
        if (existingOpRow.checksum !== operation.checksum) {
          throw new OperationIntegrityError(
            `Operation with ID '${operation.operationId}' already exists in the log with a different checksum. Stored: ${existingOpRow.checksum}, Incoming: ${operation.checksum}`
          );
        }

        // Case: Operation exists and is already APPLIED -> Deterministic no-op
        if (existingOpRow.status === 'APPLIED') {
          return this.mapRowToOperation<T>(existingOpRow);
        }

        // Case: Operation exists as PENDING or FAILED (retry) -> Proceed to apply
      } else {
        // Verify sequence number uniqueness per node
        const existingSeq = (rawDb
          .prepare('SELECT operation_id FROM operations WHERE node_id = ? AND sequence_number = ?')
          .get(operation.nodeId, operation.sequenceNumber) as unknown) as { operation_id: string } | undefined;

        if (existingSeq && existingSeq.operation_id !== operation.operationId) {
          throw new InvalidOperationError(
            `Sequence number ${operation.sequenceNumber} is already assigned to operation '${existingSeq.operation_id}' on node '${operation.nodeId}'.`
          );
        }

        // Operation not yet logged: insert as PENDING first
        rawDb
          .prepare(
            `INSERT INTO operations (
              operation_id, node_id, sequence_number, operation_type,
              entity_type, entity_id, payload, status, created_at, applied_at,
              checksum, error_message, schema_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            operation.operationId,
            operation.nodeId,
            operation.sequenceNumber,
            operation.operationType,
            operation.entityType,
            operation.entityId,
            JSON.stringify(operation.payload),
            'PENDING',
            operation.createdAt,
            null,
            operation.checksum,
            null,
            operation.schemaVersion
          );
      }

      // Apply changes to records table
      const existingRecord = this.getRecord(operation.entityId, operation.entityType);

      switch (operation.operationType) {
        case 'CREATE': {
          if (!existingRecord) {
            rawDb
              .prepare(
                `INSERT INTO records (id, entity_type, data, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .run(
                operation.entityId,
                operation.entityType,
                JSON.stringify(operation.payload),
                operation.createdAt,
                operation.createdAt
              );
          }
          break;
        }

        case 'UPDATE': {
          if (existingRecord) {
            const mergedData = {
              ...existingRecord.data,
              ...operation.payload,
            };

            rawDb
              .prepare(
                `UPDATE records
                 SET data = ?, updated_at = ?
                WHERE entity_type = ? AND id = ?`
              )
              .run(JSON.stringify(mergedData), now, operation.entityType, operation.entityId);
          }
          break;
        }

        case 'DELETE': {
          if (existingRecord) {
              rawDb
                .prepare('DELETE FROM records WHERE entity_type = ? AND id = ?')
                .run(operation.entityType, operation.entityId);
          }
          break;
        }

        default:
          throw new InvalidOperationError(
            `Unsupported operation type: ${(operation as { operationType: string }).operationType}`
          );
      }

      // Transition operation status: PENDING -> APPLIED
      rawDb
        .prepare(
          `UPDATE operations
           SET status = 'APPLIED', applied_at = ?, error_message = NULL
           WHERE operation_id = ?`
        )
        .run(now, operation.operationId);

      operation.status = 'APPLIED';
      operation.appliedAt = now;
      operation.errorMessage = null;

      return operation;
    });
  }

  public getOperation(operationId: string): Operation | null {
    const rawDb = this.dbManager.getRawDb();
    const row = (rawDb
      .prepare('SELECT * FROM operations WHERE operation_id = ?')
      .get(operationId) as unknown) as RawOperationRow | undefined;

    return row ? this.mapRowToOperation(row) : null;
  }

  public getOperationBySequence(nodeId: string, sequenceNumber: number): Operation | null {
    const rawDb = this.dbManager.getRawDb();
    const row = (rawDb
      .prepare('SELECT * FROM operations WHERE node_id = ? AND sequence_number = ?')
      .get(nodeId, sequenceNumber) as unknown) as RawOperationRow | undefined;

    return row ? this.mapRowToOperation(row) : null;
  }

  public getOperationsByNode(nodeId: string): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare('SELECT * FROM operations WHERE node_id = ? ORDER BY sequence_number ASC')
      .all(nodeId) as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public getOperationsByStatus(status: OperationStatus): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare('SELECT * FROM operations WHERE status = ? ORDER BY created_at ASC, sequence_number ASC')
      .all(status) as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public getOperationsByEntity(entityType: string, entityId: string): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare(
        'SELECT * FROM operations WHERE entity_type = ? AND entity_id = ? ORDER BY sequence_number ASC'
      )
      .all(entityType, entityId) as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public getPendingOperations(): Operation[] {
    return this.getOperationsByStatus('PENDING');
  }

  public getAppliedOperations(): Operation[] {
    return this.getOperationsByStatus('APPLIED');
  }

  public getFailedOperations(): Operation[] {
    return this.getOperationsByStatus('FAILED');
  }

  public getOperationsAfterSequence(nodeId: string, sequenceNumber: number): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare(
        'SELECT * FROM operations WHERE node_id = ? AND sequence_number > ? ORDER BY sequence_number ASC'
      )
      .all(nodeId, sequenceNumber) as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public getAllOperations(): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare('SELECT * FROM operations ORDER BY sequence_number ASC')
      .all() as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public verifyOperation(operationId: string): { valid: boolean; checksum: string; error?: string } {
    const op = this.getOperation(operationId);
    if (!op) {
      return { valid: false, checksum: '', error: `Operation '${operationId}' not found.` };
    }

    const isValid = verifyOperationIntegrity(op);
    return {
      valid: isValid,
      checksum: op.checksum,
      error: isValid ? undefined : 'Checksum does not match canonical operation content.',
    };
  }

  public getRecord<T extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    entityType?: string
  ): RecordEntity<T> | null {
    const rawDb = this.dbManager.getRawDb();
    let row: RawRecordRow | undefined;
    if (entityType) {
      row = rawDb
        .prepare('SELECT * FROM records WHERE entity_type = ? AND id = ?')
        .get(entityType, id) as RawRecordRow | undefined;
    } else {
      const matches = rawDb
        .prepare('SELECT * FROM records WHERE id = ?')
        .all(id) as unknown as RawRecordRow[];
      row = matches.length === 1 ? matches[0] : undefined;
    }

    return row ? this.mapRowToRecord<T>(row) : null;
  }

  public getAllRecords<T extends Record<string, unknown> = Record<string, unknown>>(
    entityType?: string
  ): RecordEntity<T>[] {
    const rawDb = this.dbManager.getRawDb();
    let rows: RawRecordRow[];

    if (entityType) {
      rows = (rawDb
        .prepare('SELECT * FROM records WHERE entity_type = ? ORDER BY id ASC')
        .all(entityType) as unknown) as RawRecordRow[];
    } else {
      rows = (rawDb
        .prepare('SELECT * FROM records ORDER BY entity_type ASC, id ASC')
        .all() as unknown) as RawRecordRow[];
    }

    return rows.map((r) => this.mapRowToRecord<T>(r));
  }

  private mapRowToOperation<T = Record<string, unknown>>(
    row: RawOperationRow
  ): Operation<T> {
    if (!isSupportedSchemaVersion(row.schema_version)) {
      throw new InvalidOperationError(
        `Operation '${row.operation_id}' has an unsupported or missing schema version.`
      );
    }
    const schemaVersion = row.schema_version;

    return {
      operationId: row.operation_id,
      nodeId: row.node_id,
      sequenceNumber: row.sequence_number,
      operationType: row.operation_type as OperationType,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: JSON.parse(row.payload) as T,
      status: row.status as OperationStatus,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
      checksum: row.checksum,
      errorMessage: row.error_message,
      schemaVersion,
    };
  }

  private mapRowToRecord<T = Record<string, unknown>>(
    row: RawRecordRow
  ): RecordEntity<T> {
    return {
      id: row.id,
      entityType: row.entity_type,
      data: JSON.parse(row.data) as T,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
