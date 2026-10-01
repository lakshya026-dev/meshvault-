import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

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

    db.close();
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
