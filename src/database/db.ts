import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { INITIAL_SCHEMA } from './schema.js';
import { DatabaseError, MeshVaultError } from '../errors.js';
import { computeOperationChecksum } from '../operations/integrity.js';
import { isSupportedSchemaVersion } from '../operations/types.js';

export interface DatabaseOptions {
  dbPath?: string;
  readonly?: boolean;
  historicalOperationSchemaVersion?: number;
}

export class DatabaseManager {
  private db: DatabaseSync;
  private inTransaction = false;
  private readonly readOnly: boolean;
  private readonly historicalOperationSchemaVersion?: number;

  constructor(options: DatabaseOptions = {}) {
    try {
      const dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'meshvault.db');
      this.readOnly = options.readonly ?? false;
      this.historicalOperationSchemaVersion = options.historicalOperationSchemaVersion;

      if (dbPath !== ':memory:' && !this.readOnly) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new DatabaseSync(dbPath, {
        readOnly: options.readonly ?? false,
      });

      this.initPragmas(dbPath);
      if (!this.readOnly) {
        this.initSchema();
      }
    } catch (err) {
      throw new DatabaseError(`Failed to initialize database: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }

  private initPragmas(dbPath: string): void {
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private initSchema(): void {
    this.db.exec(this.readOnly ? 'BEGIN;' : 'BEGIN IMMEDIATE;');
    try {
      this.db.exec(INITIAL_SCHEMA);
      this.migrateSchema();
      this.migrateRecordsIdentity();
      this.db.exec('COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Preserve the original migration error.
      }
      throw new DatabaseError(
        `Failed to initialize or migrate database: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  private migrateSchema(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(operations)')
      .all() as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('checksum')) {
      this.db.exec("ALTER TABLE operations ADD COLUMN checksum TEXT NOT NULL DEFAULT '';");
    }

    if (!columnNames.has('error_message')) {
      this.db.exec('ALTER TABLE operations ADD COLUMN error_message TEXT;');
    }

    if (!columnNames.has('schema_version')) {
      this.db.exec('ALTER TABLE operations ADD COLUMN schema_version INTEGER;');
    }

    // Add new causal_dependencies column if missing (Phase 6.2)
    if (!columnNames.has('causal_dependencies')) {
      this.db.exec('ALTER TABLE operations ADD COLUMN causal_dependencies TEXT;');
    }

    const unresolvedRows = this.db
      .prepare('SELECT * FROM operations WHERE schema_version IS NULL')
      .all() as Array<{
      operation_id: string;
      node_id: string;
      sequence_number: number;
      operation_type: string;
      entity_type: string;
      entity_id: string;
      payload: string;
      created_at: string;
      checksum: string;
    }>;

    if (unresolvedRows.length > 0) {
      const explicitVersion = this.historicalOperationSchemaVersion;
      if (!isSupportedSchemaVersion(explicitVersion)) {
        throw new DatabaseError(
          'Operation schema migration requires an explicit supported historicalOperationSchemaVersion for unresolved rows.'
        );
      }

      for (const row of unresolvedRows) {
        const expectedChecksum = computeOperationChecksum({
          operationId: row.operation_id,
          nodeId: row.node_id,
          sequenceNumber: row.sequence_number,
          operationType: row.operation_type,
          entityType: row.entity_type,
          entityId: row.entity_id,
          payload: JSON.parse(row.payload) as unknown,
          createdAt: row.created_at,
          schemaVersion: explicitVersion,
        });
        if (row.checksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
          throw new DatabaseError(
            `Historical operation '${row.operation_id}' does not match the explicitly declared schema version ${explicitVersion}.`
          );
        }
        this.db
          .prepare('UPDATE operations SET schema_version = ? WHERE operation_id = ?')
          .run(explicitVersion, row.operation_id);
      }
    }

    const migratedColumns = this.db
      .prepare('PRAGMA table_info(operations)')
      .all() as Array<{ name: string; notnull: number }>;
    const migratedVersionColumn = migratedColumns.find(
      (column) => column.name === 'schema_version'
    );
    if (migratedVersionColumn && migratedVersionColumn.notnull === 0) {
      this.rebuildOperationsTableWithRequiredSchemaVersion();
    }
  }

  private rebuildOperationsTableWithRequiredSchemaVersion(): void {
    this.db.exec(`
      CREATE TABLE operations_versioned (
        operation_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        operation_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TEXT NOT NULL,
        applied_at TEXT,
        checksum TEXT NOT NULL DEFAULT '',
        error_message TEXT,
        schema_version INTEGER NOT NULL,
        causal_dependencies TEXT
      );
      INSERT INTO operations_versioned (
        operation_id, node_id, sequence_number, operation_type,
        entity_type, entity_id, payload, status, created_at, applied_at,
        checksum, error_message, schema_version, causal_dependencies
      )
      SELECT operation_id, node_id, sequence_number, operation_type,
        entity_type, entity_id, payload, status, created_at, applied_at,
        checksum, error_message, schema_version, causal_dependencies
      FROM operations;
      DROP TABLE operations;
      ALTER TABLE operations_versioned RENAME TO operations;
      CREATE UNIQUE INDEX idx_operations_node_seq ON operations(node_id, sequence_number);
      CREATE INDEX idx_operations_status ON operations(status);
      CREATE INDEX idx_operations_entity ON operations(entity_type, entity_id);
      CREATE INDEX idx_operations_node_status ON operations(node_id, status);
      CREATE INDEX idx_operations_node_seq_range ON operations(node_id, sequence_number ASC);
    `);
  }


  private migrateRecordsIdentity(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(records)')
      .all() as { name: string; pk: number }[];
    const primaryKeyColumns = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);

    if (
      primaryKeyColumns.length === 2 &&
      primaryKeyColumns[0] === 'entity_type' &&
      primaryKeyColumns[1] === 'id'
    ) {
      return;
    }

    this.db.exec(`
      ALTER TABLE records RENAME TO records_legacy;
      CREATE TABLE records (
        id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity_type, id)
      );
      INSERT INTO records (id, entity_type, data, created_at, updated_at)
        SELECT id, entity_type, data, created_at, updated_at FROM records_legacy;
      DROP TABLE records_legacy;
      CREATE UNIQUE INDEX idx_records_entity_id_type ON records(entity_type, id);
    `);
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  public transaction<T>(callback: () => T): T {
    if (this.inTransaction) {
      return callback();
    }

    this.inTransaction = true;
    this.db.exec(this.readOnly ? 'BEGIN;' : 'BEGIN IMMEDIATE;');
    try {
      const result = callback();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Suppress rollback errors if transaction was already aborted
      }
      if (
        this.readOnly &&
        !(error instanceof MeshVaultError) &&
        error instanceof Error &&
        /read-?only/i.test(error.message)
      ) {
        throw new DatabaseError(
          `Write failed because the database is read-only: ${error.message}`,
          error
        );
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  public close(): void {
    this.db.close();
  }
}
