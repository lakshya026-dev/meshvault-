import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { INITIAL_SCHEMA } from './schema.js';
import { DatabaseError, MeshVaultError } from '../errors.js';

export interface DatabaseOptions {
  dbPath?: string;
  readonly?: boolean;
}

export class DatabaseManager {
  private db: DatabaseSync;
  private inTransaction = false;
  private readonly readOnly: boolean;

  constructor(options: DatabaseOptions = {}) {
    try {
      const dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'meshvault.db');
      this.readOnly = options.readonly ?? false;

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
