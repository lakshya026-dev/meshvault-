import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
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
    assert.strictEqual(op.status, 'APPLIED');
    assert.strictEqual(op.sequenceNumber, 1);
    assert.ok(op.checksum);

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
    assert.strictEqual(updateOp.status, 'APPLIED');
    assert.ok(updateOp.checksum);

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
    assert.strictEqual(deleteOp.status, 'APPLIED');
    assert.ok(deleteOp.checksum);

    // Record should no longer exist
    assert.strictEqual(opManager.getRecord('task-001'), null);

    // Operation log should still have both operations
    const allOps = opManager.getAllOperations();
    assert.strictEqual(allOps.length, 2);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('retrieves operations by ID and status', () => {
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
    assert.strictEqual(retrieved.status, 'APPLIED');

    const applied = opManager.getAppliedOperations();
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].operationId, op1.operationId);

    const pending = opManager.getPendingOperations();
    assert.strictEqual(pending.length, 0);

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

  it('guarantees transaction atomicity: rolls back operation if state application fails', () => {
    const dbPath = getUniqueTestDbPath('op_atomicity');
    const { db, opManager } = createTestNode(dbPath);

    // Initial state: 0 operations, 0 records
    assert.strictEqual(opManager.getAllOperations().length, 0);
    assert.strictEqual(opManager.getAllRecords().length, 0);

    // Attempt an invalid UPDATE on non-existent entity
    assert.throws(() => {
      opManager.createOperation({
        operationType: 'UPDATE',
        entityType: 'task',
        entityId: 'non-existent',
        payload: { title: 'Fail' },
      });
    });

    // Verify: neither operation log nor records were modified
    assert.strictEqual(opManager.getAllOperations().length, 0);
    assert.strictEqual(opManager.getAllRecords().length, 0);
    assert.strictEqual(opManager.getCurrentSequenceNumber(), 0);

    // Create a valid record
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-atomic',
      payload: { count: 1 },
    });
    assert.strictEqual(opManager.getAllOperations().length, 1);
    assert.strictEqual(opManager.getAllRecords().length, 1);

    // Attempt a second CREATE with same ID (will fail with EntityAlreadyExistsError)
    assert.throws(() => {
      opManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-atomic',
        payload: { count: 2 },
      });
    });

    // Verify: operations count is STILL 1, sequence number is STILL 1
    assert.strictEqual(opManager.getAllOperations().length, 1);
    assert.strictEqual(opManager.getCurrentSequenceNumber(), 1);
    const rec = opManager.getRecord('task-atomic');
    assert.deepStrictEqual(rec?.data, { count: 1 });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('guarantees idempotency across UPDATE and DELETE operations', () => {
    const dbPath = getUniqueTestDbPath('op_idemp_all');
    const { db, opManager } = createTestNode(dbPath);

    // 1. Create task
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-multi-idemp',
      payload: { status: 'initial' },
    });

    // 2. Update task
    const updateOp = opManager.createOperation({
      operationType: 'UPDATE',
      entityType: 'task',
      entityId: 'task-multi-idemp',
      payload: { status: 'updated' },
    });

    const recordBefore = opManager.getRecord('task-multi-idemp');
    assert.strictEqual(recordBefore?.data.status, 'updated');

    // Re-apply the update operation directly
    opManager.applyOperation(updateOp);

    const recordAfter = opManager.getRecord('task-multi-idemp');
    assert.deepStrictEqual(recordAfter, recordBefore);

    // 3. Delete task
    const deleteOp = opManager.createOperation({
      operationType: 'DELETE',
      entityType: 'task',
      entityId: 'task-multi-idemp',
      payload: {},
    });

    assert.strictEqual(opManager.getRecord('task-multi-idemp'), null);

    // Re-apply the delete operation directly
    assert.doesNotThrow(() => {
      opManager.applyOperation(deleteOp);
    });

    assert.strictEqual(opManager.getRecord('task-multi-idemp'), null);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('records standalone applied operations in operation log and enforces idempotency', () => {
    const dbPath = getUniqueTestDbPath('op_standalone');
    const { db, opManager } = createTestNode(dbPath);

    // Create a standalone operation that was NOT generated via createOperation
    const createdAt = new Date().toISOString();
    const checksum = computeOperationChecksum({
      operationId: 'op-standalone-001',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-standalone',
      payload: { title: 'External / Synced Op' },
      createdAt,
    });

    const standaloneOp = {
      operationId: 'op-standalone-001',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-standalone',
      payload: { title: 'External / Synced Op' },
      status: 'PENDING' as const,
      createdAt,
      appliedAt: null,
      checksum,
    };

    // Apply standalone operation
    opManager.applyOperation(standaloneOp);

    // Verify: recorded in operations table AND records table
    const storedOp = opManager.getOperation('op-standalone-001');
    assert.ok(storedOp, 'Standalone operation must be stored in log');
    assert.ok(storedOp.appliedAt, 'appliedAt timestamp must be set');

    const storedRec = opManager.getRecord('task-standalone');
    assert.ok(storedRec, 'Record must exist in records table');
    assert.deepStrictEqual(storedRec.data, { title: 'External / Synced Op' });

    // Apply a second time (idempotency)
    assert.doesNotThrow(() => {
      opManager.applyOperation(standaloneOp);
    });

    // Verify operations table still has only 1 entry
    assert.strictEqual(opManager.getAllOperations().length, 1);
    assert.strictEqual(opManager.getAllRecords().length, 1);

    db.close();
    cleanupTestFile(dbPath);
  });
});
