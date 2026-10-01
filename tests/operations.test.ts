import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('OperationManager', () => {
  function createTestNode(dbPath: string, nodeId = 'node-A') {
    const db = new DatabaseManager({ dbPath });
    const config = new NodeConfig(db, nodeId);
    const opManager = new OperationManager(db, config);
    return { db, config, opManager };
  }

  it('assigns monotonically increasing sequence numbers', () => {
    const dbPath = getUniqueTestDbPath('op_seq');
    const { db, opManager } = createTestNode(dbPath);

    assert.strictEqual(opManager.getCurrentSequenceNumber(), 0);
    assert.strictEqual(opManager.getNextSequenceNumber(), 1);

    const op1 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'First Task' },
    });
    assert.strictEqual(op1.sequenceNumber, 1);
    assert.strictEqual(opManager.getCurrentSequenceNumber(), 1);
    assert.strictEqual(opManager.getNextSequenceNumber(), 2);

    const op2 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-002',
      payload: { title: 'Second Task' },
    });
    assert.strictEqual(op2.sequenceNumber, 2);
    assert.strictEqual(opManager.getCurrentSequenceNumber(), 2);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('creates and applies CREATE operation to local state', () => {
    const dbPath = getUniqueTestDbPath('op_create');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Learn Distributed Systems', priority: 'high' },
    });

    assert.strictEqual(op.operationType, 'CREATE');
    assert.strictEqual(op.entityId, 'task-001');
    assert.strictEqual(op.status, 'PENDING');
    assert.strictEqual(op.sequenceNumber, 1);

    // Verify local record
    const record = opManager.getRecord('task-001');
    assert.ok(record, 'Record should exist in local state');
    assert.strictEqual(record.id, 'task-001');
    assert.strictEqual(record.entityType, 'task');
    assert.deepStrictEqual(record.data, {
      title: 'Learn Distributed Systems',
      priority: 'high',
    });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('creates and applies UPDATE operation to local state', () => {
    const dbPath = getUniqueTestDbPath('op_update');
    const { db, opManager } = createTestNode(dbPath);

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Learn Distributed Systems', status: 'pending' },
    });

    const updateOp = opManager.createOperation({
      operationType: 'UPDATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { status: 'completed' },
    });

    assert.strictEqual(updateOp.sequenceNumber, 2);
    assert.strictEqual(updateOp.operationType, 'UPDATE');
    assert.strictEqual(updateOp.status, 'PENDING');

    const updatedRecord = opManager.getRecord('task-001');
    assert.ok(updatedRecord);
    assert.deepStrictEqual(updatedRecord.data, {
      title: 'Learn Distributed Systems',
      status: 'completed',
    });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('creates and applies DELETE operation to local state', () => {
    const dbPath = getUniqueTestDbPath('op_delete');
    const { db, opManager } = createTestNode(dbPath);

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'To Be Deleted' },
    });

    assert.ok(opManager.getRecord('task-001') !== null);

    const deleteOp = opManager.createOperation({
      operationType: 'DELETE',
      entityType: 'task',
      entityId: 'task-001',
      payload: {},
    });

    assert.strictEqual(deleteOp.sequenceNumber, 2);
    assert.strictEqual(deleteOp.status, 'PENDING');

    // Record should no longer exist
    assert.strictEqual(opManager.getRecord('task-001'), null);

    // Operation log should still have both operations
    const allOps = opManager.getAllOperations();
    assert.strictEqual(allOps.length, 2);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('retrieves operations by ID and pending operations', () => {
    const dbPath = getUniqueTestDbPath('op_retrieve');
    const { db, opManager } = createTestNode(dbPath);

    const op1 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Task 1' },
    });

    const retrieved = opManager.getOperation(op1.operationId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.operationId, op1.operationId);
    assert.strictEqual(retrieved.status, 'PENDING');

    const pending = opManager.getPendingOperations();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].operationId, op1.operationId);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('demonstrates restart persistence of operations, sequence counter, and local state', () => {
    const dbPath = getUniqueTestDbPath('op_restart');

    // Session 1: Create 3 operations
    const session1 = createTestNode(dbPath, 'node-A');
    session1.opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Task 1' },
    });
    session1.opManager.createOperation({
      operationType: 'UPDATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Task 1 Updated' },
    });
    session1.opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-002',
      payload: { title: 'Task 2' },
    });

    assert.strictEqual(session1.opManager.getCurrentSequenceNumber(), 3);
    session1.db.close();

    // Session 2 (Restart): Reconnect to existing database
    const session2 = createTestNode(dbPath);
    assert.strictEqual(session2.config.getNodeId(), 'node-A');
    assert.strictEqual(session2.opManager.getCurrentSequenceNumber(), 3);
    assert.strictEqual(session2.opManager.getNextSequenceNumber(), 4);

    const opsAfterRestart = session2.opManager.getAllOperations();
    assert.strictEqual(opsAfterRestart.length, 3);
    assert.strictEqual(opsAfterRestart[0].sequenceNumber, 1);
    assert.strictEqual(opsAfterRestart[1].sequenceNumber, 2);
    assert.strictEqual(opsAfterRestart[2].sequenceNumber, 3);

    const record1 = session2.opManager.getRecord('task-001');
    assert.ok(record1);
    assert.deepStrictEqual(record1.data, { title: 'Task 1 Updated' });

    const record2 = session2.opManager.getRecord('task-002');
    assert.ok(record2);
    assert.deepStrictEqual(record2.data, { title: 'Task 2' });

    // Fourth operation after restart continues sequence at 4
    const op4 = session2.opManager.createOperation({
      operationType: 'DELETE',
      entityType: 'task',
      entityId: 'task-002',
      payload: {},
    });
    assert.strictEqual(op4.sequenceNumber, 4);

    session2.db.close();
    cleanupTestFile(dbPath);
  });

  it('safely handles duplicate application of the same operation (idempotency)', () => {
    const dbPath = getUniqueTestDbPath('op_idempotency');
    const { db, opManager } = createTestNode(dbPath);

    const op = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-idempotent',
      payload: { title: 'Idempotency Test' },
    });

    const recordBefore = opManager.getRecord('task-idempotent');
    assert.ok(recordBefore);

    // Apply the exact same operation a second time
    assert.doesNotThrow(() => {
      opManager.applyOperation(op);
    });

    const recordAfter = opManager.getRecord('task-idempotent');
    assert.ok(recordAfter);
    assert.strictEqual(recordAfter.id, recordBefore.id);

    // Ensure no duplicate rows were created in records
    const allRecords = opManager.getAllRecords('task');
    assert.strictEqual(allRecords.length, 1);

    db.close();
    cleanupTestFile(dbPath);
  });
});
