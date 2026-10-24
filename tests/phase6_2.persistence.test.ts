import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';
import { InvalidOperationError } from '../src/errors.js';

// Helper to create a fresh node environment
function createNode(dbPath: string, nodeId: string) {
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, nodeId);
  return { db, operationManager: new OperationManager(db, nodeConfig) };
}

describe('Phase 6.2 Persistence - basic tests for v2/v3 handling', () => {
  it('persists v2 operations by default for no-causal-dependencies', () => {
    const dbPath = getUniqueTestDbPath('pv2-default');
    const { db, operationManager } = createNode(dbPath, 'pv2-node');
    try {
      const op = operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-default',
        payload: { title: 'default' }
      });
      // Default should be schemaVersion 2
      assert.strictEqual(op.schemaVersion, 2);
      const retrieved = operationManager.getOperation(op.operationId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved?.schemaVersion, 2);
    } finally {
      db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('persists v3 when causalDependencies are supplied', () => {
    const dbPath = getUniqueTestDbPath('pv3-dep');
    const { db, operationManager } = createNode(dbPath, 'pv3-node');
    try {
      const op = operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-with-dep',
        payload: { title: 'dep' },
        causalDependencies: ['dep-1'],
        schemaVersion: 3
      });
      assert.strictEqual(op.schemaVersion, 3);
      assert.deepStrictEqual(op.causalDependencies, ['dep-1']);

      const retrieved = operationManager.getOperation(op.operationId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved?.schemaVersion, 3);
      assert.deepStrictEqual(retrieved?.causalDependencies, ['dep-1']);
      // checksum should verify
      const verify = operationManager.verifyOperation(op.operationId);
      assert.ok(verify.valid);
      assert.strictEqual(verify.checksum, retrieved?.checksum);
    } finally {
      db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('rejects non-3 schemaVersion when causalDependencies are provided', () => {
    const dbPath = getUniqueTestDbPath('pv3-invalid');
    const { db, operationManager } = createNode(dbPath, 'pv3-node-invalid');
    try {
      // This should throw during createOperation
      assert.throws(() => {
        operationManager.createOperation({
          operationType: 'CREATE',
          entityType: 'task',
          entityId: 'task-invalid',
          payload: { title: 'bad' },
          causalDependencies: ['x'],
          schemaVersion: 2
        });
      }, (err: unknown) => err instanceof InvalidOperationError);
    } finally {
      db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('throws on malformed causal_dependencies (non-JSON text) loaded from DB', () => {
    const dbPath = getUniqueTestDbPath('pv3-bad-json');
    const { db, operationManager } = createNode(dbPath, 'mal-node');
    try {
      const raw = db.getRawDb();
      // Bypass the API to inject corrupted data directly
      raw.exec(`
        INSERT INTO operations (operation_id, node_id, sequence_number, operation_type, entity_type, entity_id, payload, status, created_at, checksum, schema_version, causal_dependencies)
        VALUES ('mal-json','mal-node',1,'CREATE','task','mal-1','{}','APPLIED','2020-01-01T00:00:00.000Z','x',3,'not-valid-json')
      `);
      assert.throws(() => {
        operationManager.getOperation('mal-json');
      }, (err: unknown) => err instanceof InvalidOperationError);
    } finally {
      db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('throws on malformed causal_dependencies (JSON array of non-strings) loaded from DB', () => {
    const dbPath = getUniqueTestDbPath('pv3-bad-arr');
    const { db, operationManager } = createNode(dbPath, 'mal-node2');
    try {
      const raw = db.getRawDb();
      const badDeps = JSON.stringify([1, 2, 3]);
      raw.exec(`
        INSERT INTO operations (operation_id, node_id, sequence_number, operation_type, entity_type, entity_id, payload, status, created_at, checksum, schema_version, causal_dependencies)
        VALUES ('mal-arr','mal-node2',1,'CREATE','task','mal-2','{}','APPLIED','2020-01-01T00:00:00.000Z','x',3,'${badDeps}')
      `);
      assert.throws(() => {
        operationManager.getOperation('mal-arr');
      }, (err: unknown) => err instanceof InvalidOperationError);
    } finally {
      db.close();
      cleanupTestFile(dbPath);
    }
  });
});
