import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseManager as AppDatabaseManager } from '../src/database/db.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

function computeLegacyChecksum(params: {
  operationId: string;
  nodeId: string;
  sequenceNumber: number;
  operationType: string;
  entityType: string;
  entityId: string;
  payload: any;
  createdAt: string;
  schemaVersion: number;
}): string {
  // Use the v2-like checksum for pre-phase with explicit version 2
  return computeOperationChecksum({
    operationId: params.operationId,
    nodeId: params.nodeId,
    sequenceNumber: params.sequenceNumber,
    operationType: params.operationType as any,
    entityType: params.entityType,
    entityId: params.entityId,
    payload: params.payload,
    createdAt: params.createdAt,
    schemaVersion: params.schemaVersion,
  });
}

async function createPrePhaseDb(dbPath: string): Promise<void> {
  const preSql = `
    CREATE TABLE IF NOT EXISTS node_info (
      node_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_records_entity_id_type ON records(entity_type, id);

    -- Older operations schema (no causal_dependencies column; schema_version exists but nullable here for test)
    CREATE TABLE IF NOT EXISTS operations (
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
      schema_version INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_node_seq ON operations(node_id, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
    CREATE INDEX IF NOT EXISTS idx_operations_entity ON operations(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_operations_node_status ON operations(node_id, status);
    CREATE INDEX IF NOT EXISTS idx_operations_node_seq_range ON operations(node_id, sequence_number ASC);
  `;
  const db = new DatabaseSync(dbPath, { readOnly: false });
  db.exec(preSql);
  // Insert a representative legacy operation row with NULL schema_version to simulate pre-migration unresolved row
  const operationId = 'legacy-op-1';
  const nodeId = 'node-legacy';
  const sequenceNumber = 1;
  const operationType = 'CREATE';
  const entityType = 'task';
  const entityId = 'legacy-1';
  const payload = { title: 'legacy' };
  const createdAt = '2020-01-01T00:00:00.000Z';
  const checksum = computeLegacyChecksum({
    operationId, nodeId, sequenceNumber, operationType, entityType, entityId, payload, createdAt, schemaVersion: 2,
  });
  // Insert a row with NULL schema_version to trigger migration precondition
  db.exec(`
    INSERT INTO operations (
      operation_id, node_id, sequence_number, operation_type,
      entity_type, entity_id, payload, status, created_at, applied_at,
      checksum, error_message, schema_version
    ) VALUES ('${operationId}','${nodeId}',${sequenceNumber},'${operationType}','${entityType}','${entityId}','${JSON.stringify(payload).replace(/'/g, "''")}','APPLIED','${createdAt}','${createdAt}','${checksum}',NULL,NULL);
  `);
  db.close();
}

describe('Migration: pre-Phase 6.2 persistence', () => {
  it('migrates from pre-phase schema by adding causal_dependencies without altering legacy data', async () => {
    const dbPath = getUniqueTestDbPath('prephase6mgr');
    await createPrePhaseDb(dbPath);
    // First attempt should fail due to missing historicalOperationSchemaVersion for unresolved rows
    try {
      // Do not provide historicalOperationSchemaVersion yet to trigger precondition failure
      // Importing DatabaseManager triggers migration in constructor
      // We expect an error here
      // Attempt initial migration without explicit historical version should fail (precondition)
      // @ts-ignore
      new AppDatabaseManager({ dbPath });
      assert.fail('Migration should have failed due to unresolved rows.');
    } catch (err) {
      // Expect an error due to explicit precondition
      assert.ok(err instanceof Error);
      // Verify rollback: causal_dependencies column was NOT added and legacy data intact
      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const cols = checkDb.prepare("PRAGMA table_info(operations)").all() as any[];
        const hasCausal = cols.some((c: any) => c.name === 'causal_dependencies');
        assert.ok(!hasCausal, 'causal_dependencies column must not exist after rollback');
        // Legacy operation row unchanged
        const op = checkDb.prepare("SELECT * FROM operations WHERE operation_id = ?").get('legacy-op-1') as any;
        assert.ok(op, 'Legacy operation must exist after rollback');
        assert.strictEqual(op.entity_id, 'legacy-1');
        assert.strictEqual(op.status, 'APPLIED');
        assert.strictEqual(op.schema_version, null);
        // Records table still empty (unchanged)
        const recordCount = checkDb.prepare("SELECT COUNT(*) AS cnt FROM records").get() as any;
        assert.strictEqual(recordCount.cnt, 0);
      } finally {
        checkDb.close();
      }
    } finally {
      // Retry with valid historical version to perform migration
      const dbPath2 = dbPath;
      const db2 = new AppDatabaseManager({ dbPath: dbPath2, historicalOperationSchemaVersion: 2 });
      // Verify column added
      const raw = db2.getRawDb().prepare("PRAGMA table_info(operations)").all() as any[];
      const hasCausal = raw.find((r) => r.name === 'causal_dependencies') !== undefined;
      assert.ok(hasCausal, 'causal_dependencies column should exist after migration');
      // Verify legacy data intact
      const op = db2.getRawDb().prepare("SELECT * FROM operations WHERE operation_id = ?").get('legacy-op-1') as any;
      assert.ok(op);
      // payload should be intact
      const payload = JSON.parse(op.payload);
      assert.deepStrictEqual(payload, { title: 'legacy' });
      assert.strictEqual(op.status, 'APPLIED');
      assert.strictEqual(op.entity_id, 'legacy-1');
      db2.close();
      cleanupTestFile(dbPath2);
    }
  });
});
