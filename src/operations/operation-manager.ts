import { randomUUID } from 'node:crypto';
import { DatabaseManager } from '../database/db.js';
import { NodeConfig } from '../config/node.js';
import {
  Operation,
  CreateOperationInput,
  RecordEntity,
  OperationType,
} from './types.js';
import {
  InvalidOperationError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  DuplicateOperationError,
} from '../errors.js';

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

  public getCurrentSequenceNumber(): number {
    const rawDb = this.dbManager.getRawDb();
    const result = (rawDb
      .prepare(
        'SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM operations WHERE node_id = ?'
      )
      .get(this.getNodeId()) as unknown) as { max_seq: number } | undefined;

    return result ? Number(result.max_seq) : 0;
  }

  public getNextSequenceNumber(): number {
    return this.getCurrentSequenceNumber() + 1;
  }

  public createOperation<T extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateOperationInput<T>
  ): Operation<T> {
    this.validateOperationInput(input);

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
      const existingRecord = this.getRecord(input.entityId);
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
      const sequenceNumber = this.getNextSequenceNumber();
      const operationId =
        input.operationId ??
        `op-${String(sequenceNumber).padStart(3, '0')}-${randomUUID().slice(0, 6)}`;
      const createdAt = new Date().toISOString();

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
      };

      // 1. Store operation in SQLite operations table
      rawDb
        .prepare(
          `INSERT INTO operations (
            operation_id, node_id, sequence_number, operation_type,
            entity_type, entity_id, payload, status, created_at, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          null
        );

      // 2. Apply operation to local state
      this.applyOperation(operation);

      return operation;
    });
  }

  public applyOperation<T extends Record<string, unknown> = Record<string, unknown>>(
    operation: Operation<T>
  ): void {
    const rawDb = this.dbManager.getRawDb();
    const now = new Date().toISOString();

    this.dbManager.transaction(() => {
      // Check if already applied to ensure local idempotency
      const opRow = (rawDb
        .prepare('SELECT applied_at FROM operations WHERE operation_id = ?')
        .get(operation.operationId) as unknown) as { applied_at: string | null } | undefined;

      if (opRow && opRow.applied_at) {
        // Operation has already been applied locally; deterministic no-op
        return;
      }

      if (!opRow) {
        // Ensure operation is stored in operations table if applyOperation is called standalone
        rawDb
          .prepare(
            `INSERT INTO operations (
              operation_id, node_id, sequence_number, operation_type,
              entity_type, entity_id, payload, status, created_at, applied_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            null
          );
      }

      const existingRecord = this.getRecord(operation.entityId);

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
                 WHERE id = ?`
              )
              .run(JSON.stringify(mergedData), now, operation.entityId);
          }
          break;
        }

        case 'DELETE': {
          if (existingRecord) {
            rawDb
              .prepare('DELETE FROM records WHERE id = ?')
              .run(operation.entityId);
          }
          break;
        }

        default:
          throw new InvalidOperationError(
            `Unsupported operation type: ${(operation as { operationType: string }).operationType}`
          );
      }

      // Durably mark operation as applied locally
      rawDb
        .prepare('UPDATE operations SET applied_at = ? WHERE operation_id = ?')
        .run(now, operation.operationId);
      operation.appliedAt = now;
    });
  }

  public getOperation(operationId: string): Operation | null {
    const rawDb = this.dbManager.getRawDb();
    const row = (rawDb
      .prepare('SELECT * FROM operations WHERE operation_id = ?')
      .get(operationId) as unknown) as RawOperationRow | undefined;

    return row ? this.mapRowToOperation(row) : null;
  }

  public getPendingOperations(): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare(
        'SELECT * FROM operations WHERE status = ? ORDER BY sequence_number ASC'
      )
      .all('PENDING') as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public getAllOperations(): Operation[] {
    const rawDb = this.dbManager.getRawDb();
    const rows = (rawDb
      .prepare('SELECT * FROM operations ORDER BY sequence_number ASC')
      .all() as unknown) as RawOperationRow[];

    return rows.map((r) => this.mapRowToOperation(r));
  }

  public getRecord<T extends Record<string, unknown> = Record<string, unknown>>(
    id: string
  ): RecordEntity<T> | null {
    const rawDb = this.dbManager.getRawDb();
    const row = (rawDb
      .prepare('SELECT * FROM records WHERE id = ?')
      .get(id) as unknown) as RawRecordRow | undefined;

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

  private validateOperationInput(input: CreateOperationInput): void {
    const validTypes: OperationType[] = ['CREATE', 'UPDATE', 'DELETE'];
    if (!validTypes.includes(input.operationType)) {
      throw new InvalidOperationError(
        `Invalid operation type: '${input.operationType}'. Expected CREATE, UPDATE, or DELETE.`
      );
    }

    if (!input.entityType || typeof input.entityType !== 'string' || input.entityType.trim() === '') {
      throw new InvalidOperationError('Entity type must be a non-empty string.');
    }

    if (!input.entityId || typeof input.entityId !== 'string' || input.entityId.trim() === '') {
      throw new InvalidOperationError('Entity ID must be a non-empty string.');
    }

    if (
      input.payload === null ||
      typeof input.payload !== 'object' ||
      Array.isArray(input.payload)
    ) {
      throw new InvalidOperationError('Payload must be a valid JSON object.');
    }
  }

  private mapRowToOperation<T = Record<string, unknown>>(
    row: RawOperationRow
  ): Operation<T> {
    return {
      operationId: row.operation_id,
      nodeId: row.node_id,
      sequenceNumber: row.sequence_number,
      operationType: row.operation_type as OperationType,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: JSON.parse(row.payload) as T,
      status: 'PENDING',
      createdAt: row.created_at,
      appliedAt: row.applied_at,
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
