import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';
import { DatabaseSync } from 'node:sqlite';
import { computeOperationChecksum } from '../src/operations/integrity.js';

describe('DatabaseManager', () => {
  it('initializes tables and indexes correctly', () => {
    const testDbPath = getUniqueTestDbPath('db_init');
    const db = new DatabaseManager({ dbPath: testDbPath });
    const raw = db.getRawDb();

    // Verify tables exist
    const tables = (raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as unknown) as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    assert.ok(tableNames.includes('node_info'), 'node_info table should exist');
    assert.ok(tableNames.includes('records'), 'records table should exist');
    assert.ok(tableNames.includes('operations'), 'operations table should exist');
    const operationColumns = raw
      .prepare('PRAGMA table_info(operations)')
      .all() as Array<{ name: string; notnull: number }>;
    const schemaVersionColumn = operationColumns.find((column) => column.name === 'schema_version');
    assert.ok(schemaVersionColumn);
    assert.strictEqual(schemaVersionColumn.notnull, 1);

    db.close();
    cleanupTestFile(testDbPath);
  });

  it('migrates legacy operations only with an explicit matching policy and preserves checksums', () => {
    const testDbPath = getUniqueTestDbPath('db_operation_version_migration');
    const legacyDb = new DatabaseSync(testDbPath);
    legacyDb.exec(`
      CREATE TABLE operations (
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
        error_message TEXT
      );
      CREATE TABLE records (
        id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      );
    `);
    const operation = {
      operationId: 'legacy-op',
      nodeId: 'legacy-node',
      sequenceNumber: 1,
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'legacy-task',
      payload: { title: 'legacy' },
      createdAt: new Date().toISOString(),
      schemaVersion: 1 as const,
    };
    const checksum = computeOperationChecksum(operation);
    legacyDb.prepare(`
      INSERT INTO operations (
        operation_id, node_id, sequence_number, operation_type, entity_type,
        entity_id, payload, status, created_at, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation.operationId,
      operation.nodeId,
      operation.sequenceNumber,
      operation.operationType,
      operation.entityType,
      operation.entityId,
      JSON.stringify(operation.payload),
      'APPLIED',
      operation.createdAt,
      checksum
    );
    legacyDb.close();

    const db = new DatabaseManager({
      dbPath: testDbPath,
      historicalOperationSchemaVersion: 1,
    });
    const row = db.getRawDb()
      .prepare('SELECT checksum, schema_version FROM operations WHERE operation_id = ?')
      .get(operation.operationId) as { checksum: string; schema_version: number };
    assert.strictEqual(row.checksum, checksum);
    assert.strictEqual(row.schema_version, 1);
    db.close();

    const restarted = new DatabaseManager({ dbPath: testDbPath });
    assert.strictEqual(
      (restarted.getRawDb().prepare('SELECT schema_version FROM operations').get() as { schema_version: number }).schema_version,
      1
    );
    restarted.close();
    cleanupTestFile(testDbPath);
  });

  it('refuses unresolved historical operations and rolls back the temporary migration column', () => {
    const testDbPath = getUniqueTestDbPath('db_operation_version_refusal');
    const legacyDb = new DatabaseSync(testDbPath);
    legacyDb.exec(`
      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, sequence_number INTEGER NOT NULL,
        operation_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL,
        applied_at TEXT, checksum TEXT NOT NULL DEFAULT '', error_message TEXT
      );
      CREATE TABLE records (
        id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id)
      );
    `);
    legacyDb.prepare(`
      INSERT INTO operations (
        operation_id, node_id, sequence_number, operation_type, entity_type,
        entity_id, payload, status, created_at, checksum
      ) VALUES ('legacy-op', 'legacy-node', 1, 'CREATE', 'task', 'legacy-task', '{}', 'PENDING', ?, 'not-a-checksum')
    `).run(new Date().toISOString());
    legacyDb.close();

    assert.throws(
      () => new DatabaseManager({ dbPath: testDbPath }),
      /requires an explicit supported historicalOperationSchemaVersion/
    );

    const verifyDb = new DatabaseSync(testDbPath);
    const columns = verifyDb.prepare('PRAGMA table_info(operations)').all() as Array<{ name: string }>;
    assert.strictEqual(columns.some((column) => column.name === 'schema_version'), false);
    verifyDb.close();
    cleanupTestFile(testDbPath);
  });

  it('supports transactions with commit and rollback', () => {
    const testDbPath = getUniqueTestDbPath('db_tx');
    const db = new DatabaseManager({ dbPath: testDbPath });

    // Committed transaction
    db.transaction(() => {
      db.getRawDb()
        .prepare('INSERT INTO node_info (node_id, created_at) VALUES (?, ?)')
        .run('node-commit-test', new Date().toISOString());
    });

    const row = db
      .getRawDb()
      .prepare('SELECT node_id FROM node_info WHERE node_id = ?')
      .get('node-commit-test');
    assert.ok(row, 'Committed data should be present');

    // Rolled back transaction
    assert.throws(() => {
      db.transaction(() => {
        db.getRawDb()
          .prepare('INSERT INTO node_info (node_id, created_at) VALUES (?, ?)')
          .run('node-rollback-test', new Date().toISOString());
        throw new Error('Simulated failure');
      });
    }, /Simulated failure/);

    const rollbackRow = db
      .getRawDb()
      .prepare('SELECT node_id FROM node_info WHERE node_id = ?')
      .get('node-rollback-test');
    assert.strictEqual(rollbackRow, undefined, 'Rolled back data should not exist');

    db.close();
    cleanupTestFile(testDbPath);
  });
});
