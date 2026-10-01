import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { INITIAL_SCHEMA } from './schema.js';
import { DatabaseError } from '../errors.js';

export interface DatabaseOptions {
  dbPath?: string;
  readonly?: boolean;
}

export class DatabaseManager {
  private db: DatabaseSync;
  private inTransaction = false;

  constructor(options: DatabaseOptions = {}) {
    try {
      const dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'meshvault.db');

      if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new DatabaseSync(dbPath, {
        readOnly: options.readonly ?? false,
      });

      this.initPragmas(dbPath);
      this.initSchema();
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
    this.db.exec(INITIAL_SCHEMA);
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  public transaction<T>(callback: () => T): T {
    if (this.inTransaction) {
      return callback();
    }

    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE;');
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
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  public close(): void {
    this.db.close();
  }
}
