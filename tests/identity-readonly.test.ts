import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { DatabaseError, EntityNotFoundError } from '../src/errors.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('entity identity, migrations, and read-only behavior', () => {
  it('scopes record identity by entity type', () => {
    const dbPath = getUniqueTestDbPath('identity');
    const db = new DatabaseManager({ dbPath });
    const manager = new OperationManager(db, new NodeConfig(db, 'node-identity'));

    manager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'shared-id',
      payload: { title: 'Task' },
    });
    manager.createOperation({
      operationType: 'CREATE',
      entityType: 'user',
      entityId: 'shared-id',
      payload: { name: 'User' },
    });

    assert.deepStrictEqual(manager.getRecord('shared-id', 'task')?.data, { title: 'Task' });
    assert.deepStrictEqual(manager.getRecord('shared-id', 'user')?.data, { name: 'User' });
    assert.strictEqual(manager.getRecord('shared-id'), null);
    assert.throws(
      () =>
        manager.createOperation({
          operationType: 'UPDATE',
          entityType: 'missing',
          entityId: 'shared-id',
          payload: { value: true },
        }),
      EntityNotFoundError
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('preserves existing data while migrating record identity', () => {
    const dbPath = getUniqueTestDbPath('identity-migration');
    const seed = new DatabaseManager({ dbPath });
    seed.getRawDb().exec('DROP TABLE records;');
    seed.getRawDb().exec(`
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO records VALUES ('legacy-id', 'task', '{}', '2026-01-01', '2026-01-01');
    `);
    seed.close();

    const migrated = new DatabaseManager({ dbPath });
    const row = migrated
      .getRawDb()
      .prepare('SELECT entity_type, id FROM records WHERE id = ?')
      .get('legacy-id') as { entity_type: string; id: string };
    assert.strictEqual(row.entity_type, 'task');
    assert.strictEqual(row.id, 'legacy-id');
    migrated.close();
    cleanupTestFile(dbPath);
  });

  it('fails explicitly when migration cannot complete', () => {
    const dbPath = getUniqueTestDbPath('migration-failure');
    const directory = dbPath.slice(0, dbPath.lastIndexOf('\\'));
    fs.mkdirSync(directory, { recursive: true });
    const seed = new DatabaseManager({ dbPath });
    seed.getRawDb().exec('DROP TABLE records;');
    seed.getRawDb().exec(`
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    seed.close();

    assert.throws(() => new DatabaseManager({ dbPath }), DatabaseError);
    cleanupTestFile(dbPath);
  });

  it('rejects writes explicitly for a read-only database', () => {
    const dbPath = getUniqueTestDbPath('readonly');
    const writable = new DatabaseManager({ dbPath });
    new NodeConfig(writable, 'node-readonly');
    writable.close();

    const readonly = new DatabaseManager({ dbPath, readonly: true });
    const manager = new OperationManager(readonly, new NodeConfig(readonly));
    assert.throws(
      () =>
        manager.createOperation({
          operationType: 'CREATE',
          entityType: 'task',
          entityId: 'read-only',
          payload: {},
        }),
      DatabaseError
    );
    readonly.close();
    cleanupTestFile(dbPath);
  });

  it('rethrows unrelated transaction errors unchanged on a read-only database', () => {
    const dbPath = getUniqueTestDbPath('readonly-transaction-error');
    const writable = new DatabaseManager({ dbPath });
    writable.close();

    const readonly = new DatabaseManager({ dbPath, readonly: true });
    const expectedError = new Error('boom');

    assert.throws(
      () =>
        readonly.transaction(() => {
          throw expectedError;
        }),
      (error) => error === expectedError
    );

    readonly.close();
    cleanupTestFile(dbPath);
  });
});
