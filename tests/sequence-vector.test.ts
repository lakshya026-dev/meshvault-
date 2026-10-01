import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

function createTestNode(dbPath: string, nodeId = 'node-local') {
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, nodeId);
  const opManager = new OperationManager(db, nodeConfig);
  return { db, opManager };
}

function createRemoteOperation(
  operationId: string,
  nodeId: string,
  sequenceNumber: number,
  entityId: string,
  payload: Record<string, unknown>
) {
  const createdAt = new Date().toISOString();
  const operation = {
    operationId,
    nodeId,
    sequenceNumber,
    operationType: 'CREATE' as const,
    entityType: 'task',
    entityId,
    payload,
    status: 'PENDING' as const,
    createdAt,
    appliedAt: null,
    checksum: '',
  };
  operation.checksum = computeOperationChecksum(operation);
  return operation;
}

describe('Operation sequence vector', () => {
  it('returns an empty vector for an empty database', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-empty');
    const { db, opManager } = createTestNode(dbPath);

    assert.deepStrictEqual(opManager.getSequenceVector(), {});

    db.close();
    cleanupTestFile(dbPath);
  });

  it('returns the highest local sequence for one node', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-local');
    const { db, opManager } = createTestNode(dbPath, 'node-local');

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'local-1',
      payload: { index: 1 },
    });
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'local-2',
      payload: { index: 2 },
    });
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'local-3',
      payload: { index: 3 },
    });

    assert.deepStrictEqual(opManager.getSequenceVector(), { 'node-local': 3 });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('keeps remote origins separate from the local sequence entry', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-remote');
    const { db, opManager } = createTestNode(dbPath, 'node-local');

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'local-1',
      payload: { source: 'local' },
    });

    const remoteOperation = createRemoteOperation(
      'remote-op-1',
      'node-remote',
      7,
      'remote-1',
      { source: 'remote' }
    );
    opManager.applyOperation(remoteOperation);

    assert.deepStrictEqual(opManager.getSequenceVector(), {
      'node-local': 1,
      'node-remote': 7,
    });
    assert.strictEqual(opManager.getCurrentSequenceNumber('node-local'), 1);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('returns separate entries for two remote origins', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-origins');
    const { db, opManager } = createTestNode(dbPath);

    opManager.applyOperation(
      createRemoteOperation('remote-op-a', 'node-a', 4, 'remote-a', { source: 'a' })
    );
    opManager.applyOperation(
      createRemoteOperation('remote-op-b', 'node-b', 2, 'remote-b', { source: 'b' })
    );

    assert.deepStrictEqual(opManager.getSequenceVector(), {
      'node-a': 4,
      'node-b': 2,
    });

    db.close();
    cleanupTestFile(dbPath);
  });

  it('survives closing and reopening the database', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-restart');
    const first = createTestNode(dbPath, 'node-local');
    first.opManager.applyOperation(
      createRemoteOperation('remote-op-restart', 'node-remote', 5, 'remote-restart', {
        persisted: true,
      })
    );
    assert.deepStrictEqual(first.opManager.getSequenceVector(), { 'node-remote': 5 });
    first.db.close();

    const reopened = createTestNode(dbPath, 'node-local');
    assert.deepStrictEqual(reopened.opManager.getSequenceVector(), { 'node-remote': 5 });
    reopened.db.close();
    cleanupTestFile(dbPath);
  });

  it('preserves remote operation identity fields exactly', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-identity');
    const { db, opManager } = createTestNode(dbPath);
    const remoteOperation = createRemoteOperation(
      'remote-op-identity',
      'node-origin',
      9,
      'remote-identity',
      { preserved: true }
    );

    opManager.applyOperation(remoteOperation);
    const stored = opManager.getOperation(remoteOperation.operationId);

    assert.ok(stored);
    assert.strictEqual(stored?.operationId, remoteOperation.operationId);
    assert.strictEqual(stored?.nodeId, remoteOperation.nodeId);
    assert.strictEqual(stored?.sequenceNumber, remoteOperation.sequenceNumber);
    assert.strictEqual(stored?.checksum, remoteOperation.checksum);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('does not mutate state or the vector when replaying a remote operation', () => {
    const dbPath = getUniqueTestDbPath('sequence-vector-replay');
    const { db, opManager } = createTestNode(dbPath);
    const remoteOperation = createRemoteOperation(
      'remote-op-replay',
      'node-remote',
      3,
      'remote-replay',
      { value: 1 }
    );

    const first = opManager.applyOperation(remoteOperation);
    const firstRecord = opManager.getRecord('remote-replay', 'task');
    const firstVector = opManager.getSequenceVector();
    const replayed = opManager.applyOperation(remoteOperation);
    const secondRecord = opManager.getRecord('remote-replay', 'task');

    assert.deepStrictEqual(opManager.getSequenceVector(), firstVector);
    assert.deepStrictEqual(secondRecord, firstRecord);
    assert.strictEqual(replayed.appliedAt, first.appliedAt);
    assert.strictEqual(opManager.getAllOperations().length, 1);

    db.close();
    cleanupTestFile(dbPath);
  });
});
