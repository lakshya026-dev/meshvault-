import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
} from '../src/operations/types.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

function createTestNode(dbPath: string, nodeId = 'node-sv') {
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, nodeId);
  const opManager = new OperationManager(db, nodeConfig);
  return { db, opManager };
}

describe('Phase 5 Step 3 — Operation Versioning', () => {
  // ─── A. New operations use CURRENT_SCHEMA_VERSION ───────────────────────────

  it('newly created operation has schemaVersion = CURRENT_SCHEMA_VERSION (v2)', () => {
    const dbPath = getUniqueTestDbPath('sv_new_op');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-sv-1',
      payload: { title: 'Versioned Task' },
    });

    assert.strictEqual(
      op.schemaVersion,
      CURRENT_SCHEMA_VERSION,
      `Expected schemaVersion ${CURRENT_SCHEMA_VERSION} (CURRENT_SCHEMA_VERSION) on new operation, got ${op.schemaVersion}`
    );
    assert.strictEqual(CURRENT_SCHEMA_VERSION, 2);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('newly created operation without schemaVersion in input defaults to CURRENT_SCHEMA_VERSION', () => {
    const dbPath = getUniqueTestDbPath('sv_no_version_input');
    const { db, opManager } = createTestNode(dbPath);

    // Explicitly omit schemaVersion from CreateOperationInput (legacy/unversioned caller)
    const input = {
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-sv-2',
      payload: { note: 'no schemaVersion field in input' },
    };
    assert.ok(!('schemaVersion' in input), 'Test precondition: schemaVersion must be absent from input');

    const op = opManager.createOperation(input);

    assert.strictEqual(op.schemaVersion, CURRENT_SCHEMA_VERSION);

    db.close();
    cleanupTestFile(dbPath);
  });

  // ─── B. Explicitly supplied schemaVersion is preserved ──────────────────────

  it('explicitly supplying schemaVersion = 1 on createOperation preserves it', () => {
    const dbPath = getUniqueTestDbPath('sv_explicit_v1');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-sv-3',
      payload: { legacy: true },
      schemaVersion: 1,
    });

    assert.strictEqual(op.schemaVersion, 1);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('explicitly supplying schemaVersion = 2 on createOperation preserves it', () => {
    const dbPath = getUniqueTestDbPath('sv_explicit_v2');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'item',
      entityId: 'item-sv-1',
      payload: { versioned: true },
      schemaVersion: 2,
    });

    assert.strictEqual(op.schemaVersion, 2);

    db.close();
    cleanupTestFile(dbPath);
  });

  // ─── C. applyOperation rejects operations without schemaVersion ─────────────

  it('applyOperation rejects missing schemaVersion instead of guessing v1', () => {
    const dbPath = getUniqueTestDbPath('sv_apply_legacy');
    const { db, opManager } = createTestNode(dbPath, 'node-remote');

    const createdAt = new Date().toISOString();
    const legacyOp = {
      operationId: 'op-legacy-no-version',
      nodeId: 'node-remote',
      sequenceNumber: 1,
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-legacy-sv',
      payload: { name: 'Legacy Op' },
      status: 'PENDING' as const,
      createdAt,
      appliedAt: null,
      checksum: '',
      // schemaVersion intentionally absent — simulates pre-versioning or legacy peer
    };
    legacyOp.checksum = computeOperationChecksum({ ...legacyOp, schemaVersion: 1 });

    assert.ok(
      !('schemaVersion' in legacyOp),
      'Test precondition: legacyOp must not have schemaVersion before applyOperation'
    );

    assert.throws(
      () => opManager.applyOperation(legacyOp as Parameters<typeof opManager.applyOperation>[0]),
      /Unsupported operation schema version/
    );
    assert.strictEqual(MIN_SUPPORTED_SCHEMA_VERSION, 1);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('applyOperation preserves an explicit schemaVersion on incoming operation', () => {
    const dbPath = getUniqueTestDbPath('sv_apply_versioned');
    const { db, opManager } = createTestNode(dbPath, 'node-versioned');

    const createdAt = new Date().toISOString();
    const versionedOp = {
      operationId: 'op-versioned-apply',
      nodeId: 'node-versioned',
      sequenceNumber: 1,
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-versioned-apply',
      payload: { label: 'versioned' },
      status: 'PENDING' as const,
      createdAt,
      appliedAt: null,
      checksum: '',
      schemaVersion: 2,
    };
    versionedOp.checksum = computeOperationChecksum(versionedOp);

    const applied = opManager.applyOperation(versionedOp);

    assert.strictEqual(applied.schemaVersion, 2);

    db.close();
    cleanupTestFile(dbPath);
  });

  // ─── D. Normalized Operation always exposes an explicit schemaVersion ────────

  it('getOperation always returns an explicit numeric schemaVersion', () => {
    const dbPath = getUniqueTestDbPath('sv_getop');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-sv-getop',
      payload: { idx: 1 },
    });

    const fetched = opManager.getOperation(op.operationId);

    assert.ok(fetched, 'Operation must be retrievable after creation');
    assert.strictEqual(typeof fetched.schemaVersion, 'number');
    assert.strictEqual(
      fetched.schemaVersion,
      CURRENT_SCHEMA_VERSION,
      `Expected schemaVersion = CURRENT_SCHEMA_VERSION (${CURRENT_SCHEMA_VERSION}), got ${fetched.schemaVersion}`
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('getAllOperations always returns explicit numeric schemaVersion on every entry', () => {
    const dbPath = getUniqueTestDbPath('sv_getall');
    const { db, opManager } = createTestNode(dbPath);

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-all-1',
      payload: { n: 1 },
    });
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-all-2',
      payload: { n: 2 },
    });

    const ops = opManager.getAllOperations();
    assert.ok(ops.length >= 2);

    for (const op of ops) {
      assert.strictEqual(
        typeof op.schemaVersion,
        'number',
        `schemaVersion must be a number on every operation, got ${typeof op.schemaVersion} for ${op.operationId}`
      );
    }

    db.close();
    cleanupTestFile(dbPath);
  });

  // ─── E. Idempotency remains unchanged ───────────────────────────────────────

  it('idempotency: replaying the same versioned operation is a safe no-op', () => {
    const dbPath = getUniqueTestDbPath('sv_idempotent');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-idem-sv',
      payload: { x: 42 },
    });

    assert.strictEqual(op.status, 'APPLIED');
    assert.strictEqual(op.schemaVersion, CURRENT_SCHEMA_VERSION);

    // Replay: must be a deterministic no-op
    const replayed = opManager.applyOperation(op);

    assert.strictEqual(replayed.status, 'APPLIED');
    assert.strictEqual(replayed.operationId, op.operationId);
    assert.strictEqual(typeof replayed.schemaVersion, 'number');

    db.close();
    cleanupTestFile(dbPath);
  });

  // ─── F. Existing operation fields remain unchanged ──────────────────────────

  it('createOperation still sets all existing fields correctly alongside schemaVersion', () => {
    const dbPath = getUniqueTestDbPath('sv_fields');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'document',
      entityId: 'doc-fields-1',
      payload: { content: 'Hello' },
    });

    // All pre-versioning fields must remain intact
    assert.strictEqual(typeof op.operationId, 'string');
    assert.ok(op.operationId.length > 0);
    assert.strictEqual(op.nodeId, opManager.getNodeId());
    assert.strictEqual(op.sequenceNumber, 1);
    assert.strictEqual(op.operationType, 'CREATE');
    assert.strictEqual(op.entityType, 'document');
    assert.strictEqual(op.entityId, 'doc-fields-1');
    assert.deepStrictEqual(op.payload, { content: 'Hello' });
    assert.strictEqual(op.status, 'APPLIED');
    assert.ok(op.createdAt);
    assert.ok(op.appliedAt);
    assert.strictEqual(typeof op.checksum, 'string');
    assert.strictEqual(op.checksum.length, 64);

    // New field
    assert.strictEqual(op.schemaVersion, CURRENT_SCHEMA_VERSION);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('UPDATE and DELETE operations carry the correct schemaVersion', () => {
    const dbPath = getUniqueTestDbPath('sv_update_delete');
    const { db, opManager } = createTestNode(dbPath);

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-upd-del',
      payload: { status: 'open' },
    });

    const updated = opManager.createOperation({
      operationType: 'UPDATE',
      entityType: 'task',
      entityId: 'task-upd-del',
      payload: { status: 'closed' },
    });
    assert.strictEqual(updated.schemaVersion, CURRENT_SCHEMA_VERSION);

    const deleted = opManager.createOperation({
      operationType: 'DELETE',
      entityType: 'task',
      entityId: 'task-upd-del',
      payload: {},
    });
    assert.strictEqual(deleted.schemaVersion, CURRENT_SCHEMA_VERSION);

    db.close();
    cleanupTestFile(dbPath);
  });
});
