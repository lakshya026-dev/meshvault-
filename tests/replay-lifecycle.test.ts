import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { OperationIntegrityError, InvalidOperationError } from '../src/errors.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('Operation Replay & Lifecycle State Machine', () => {
  function createTestNode(dbPath: string, nodeId = 'node-A') {
    const db = new DatabaseManager({ dbPath });
    const config = new NodeConfig(db, nodeId);
    const opManager = new OperationManager(db, config);
    return { db, config, opManager };
  }

  it('performs deterministic no-op when replaying an already APPLIED operation', () => {
    const dbPath = getUniqueTestDbPath('replay_applied');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-replay',
      payload: { value: 100 },
    });
    assert.strictEqual(op.status, 'APPLIED');
    const originalAppliedAt = op.appliedAt;

    // Replay the exact same operation
    const replayed = opManager.applyOperation(op);

    // Verify it is a no-op
    assert.strictEqual(replayed.operationId, op.operationId);
    assert.strictEqual(replayed.status, 'APPLIED');
    assert.strictEqual(replayed.appliedAt, originalAppliedAt);

    // State remains unmodified
    const record = opManager.getRecord('task-replay');
    assert.deepStrictEqual(record?.data, { value: 100 });

    // Operations count is still 1
    assert.strictEqual(opManager.getAllOperations().length, 1);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects duplicate operation with modified content/checksum (never overwrites)', () => {
    const dbPath = getUniqueTestDbPath('replay_modified');
    const { db, opManager } = createTestNode(dbPath);

    const originalOp = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-orig',
      payload: { amount: 50 },
    });

    // Create a modified operation with SAME operationId but DIFFERENT payload and checksum
    const modifiedChecksum = computeOperationChecksum({
      operationId: originalOp.operationId,
      nodeId: originalOp.nodeId,
      sequenceNumber: originalOp.sequenceNumber,
      operationType: originalOp.operationType,
      entityType: originalOp.entityType,
      entityId: originalOp.entityId,
      payload: { amount: 999999 }, // modified!
      createdAt: originalOp.createdAt,
    });

    const modifiedOp = {
      ...originalOp,
      payload: { amount: 999999 },
      checksum: modifiedChecksum,
    };

    assert.throws(
      () => {
        opManager.applyOperation(modifiedOp);
      },
      (err: unknown) => {
        return (
          err instanceof OperationIntegrityError &&
          err.message.includes('already exists in the log with a different checksum')
        );
      }
    );

    // Verify: local state still has original value { amount: 50 }
    const record = opManager.getRecord('task-orig');
    assert.deepStrictEqual(record?.data, { amount: 50 });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('reconciles existing PENDING operations: transitions PENDING -> APPLIED', () => {
    const dbPath = getUniqueTestDbPath('replay_pending');
    const { db, opManager } = createTestNode(dbPath);

    // Manually insert a PENDING operation into the SQLite operations table
    const createdAt = new Date().toISOString();
    const checksum = computeOperationChecksum({
      operationId: 'op-resume-1',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-resumed',
      payload: { status: 'reconciled' },
      createdAt,
    });

    db.getRawDb()
      .prepare(
        `INSERT INTO operations (
          operation_id, node_id, sequence_number, operation_type,
          entity_type, entity_id, payload, status, created_at, checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'op-resume-1',
        'node-A',
        1,
        'CREATE',
        'task',
        'task-resumed',
        JSON.stringify({ status: 'reconciled' }),
        'PENDING',
        createdAt,
        checksum
      );

    // Verify it is currently PENDING in DB
    const beforeOp = opManager.getOperation('op-resume-1');
    assert.strictEqual(beforeOp?.status, 'PENDING');
    assert.strictEqual(beforeOp?.appliedAt, null);
    assert.strictEqual(opManager.getRecord('task-resumed'), null);

    // Apply / reconcile it
    const appliedOp = opManager.applyOperation(beforeOp!);

    assert.strictEqual(appliedOp.status, 'APPLIED');
    assert.ok(appliedOp.appliedAt);

    // Verify record now exists in local state
    const record = opManager.getRecord('task-resumed');
    assert.ok(record);
    assert.deepStrictEqual(record?.data, { status: 'reconciled' });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects duplicate sequence number on the same node with different operation ID', () => {
    const dbPath = getUniqueTestDbPath('replay_dup_seq');
    const { db, opManager } = createTestNode(dbPath, 'node-A');

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-1',
      payload: { index: 1 },
    }); // assigned sequenceNumber = 1

    // Attempt to apply a DIFFERENT operation that attempts to reuse sequenceNumber = 1 on node-A
    const createdAt = new Date().toISOString();
    const dupSeqOp = {
      operationId: 'op-diff-id',
      nodeId: 'node-A',
      sequenceNumber: 1, // duplicate sequence!
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-conflict',
      payload: { index: 1 },
      status: 'PENDING' as const,
      createdAt,
      appliedAt: null,
      checksum: '',
    };
    dupSeqOp.checksum = computeOperationChecksum(dupSeqOp);

    assert.throws(
      () => {
        opManager.applyOperation(dupSeqOp);
      },
      (err: unknown) => {
        return err instanceof InvalidOperationError && err.message.includes('already assigned');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('verifies operation cryptographic integrity via verifyOperation', () => {
    const dbPath = getUniqueTestDbPath('replay_verify_cmd');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-v',
      payload: { ok: true },
    });

    const reportValid = opManager.verifyOperation(op.operationId);
    assert.strictEqual(reportValid.valid, true);
    assert.strictEqual(reportValid.checksum, op.checksum);
    assert.strictEqual(reportValid.error, undefined);

    // Simulate database row corruption directly on the stored row
    db.getRawDb()
      .prepare("UPDATE operations SET payload = '{\"ok\":false}' WHERE operation_id = ?")
      .run(op.operationId);

    const reportCorrupt = opManager.verifyOperation(op.operationId);
    assert.strictEqual(reportCorrupt.valid, false);
    assert.ok(reportCorrupt.error?.includes('does not match canonical operation content'));

    db.close();
    cleanupTestFile(dbPath);
  });
});
