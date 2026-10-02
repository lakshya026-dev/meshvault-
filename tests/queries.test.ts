import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('OperationManager Queries', () => {
  function createTestNode(dbPath: string, nodeId = 'node-A') {
    const db = new DatabaseManager({ dbPath });
    const config = new NodeConfig(db, nodeId);
    const opManager = new OperationManager(db, config);
    return { db, config, opManager };
  }

  it('queries operations by operation ID, node, and sequence', () => {
    const dbPath = getUniqueTestDbPath('query_basic');
    const { db, opManager } = createTestNode(dbPath, 'node-A');

    const op1 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-1',
      payload: { title: 'First' },
    });
    const op2 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-2',
      payload: { title: 'Second' },
    });

    // Query by ID
    const found1 = opManager.getOperation(op1.operationId);
    assert.ok(found1);
    assert.strictEqual(found1.operationId, op1.operationId);

    // Query by Sequence
    const foundSeq2 = opManager.getOperationBySequence('node-A', 2);
    assert.ok(foundSeq2);
    assert.strictEqual(foundSeq2.operationId, op2.operationId);
    assert.strictEqual(foundSeq2.sequenceNumber, 2);

    // Query by Node
    const nodeOps = opManager.getOperationsByNode('node-A');
    assert.strictEqual(nodeOps.length, 2);
    assert.strictEqual(nodeOps[0].operationId, op1.operationId);
    assert.strictEqual(nodeOps[1].operationId, op2.operationId);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('queries operations by entity type and ID', () => {
    const dbPath = getUniqueTestDbPath('query_entity');
    const { db, opManager } = createTestNode(dbPath, 'node-A');

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-target',
      payload: { status: 'open' },
    });
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'note',
      entityId: 'note-other',
      payload: { text: 'hello' },
    });
    opManager.createOperation({
      operationType: 'UPDATE',
      entityType: 'task',
      entityId: 'task-target',
      payload: { status: 'in-progress' },
    });

    const targetOps = opManager.getOperationsByEntity('task', 'task-target');
    assert.strictEqual(targetOps.length, 2);
    assert.strictEqual(targetOps[0].operationType, 'CREATE');
    assert.strictEqual(targetOps[1].operationType, 'UPDATE');

    db.close();
    cleanupTestFile(dbPath);
  });

  it('queries operations by status (PENDING, APPLIED, FAILED)', () => {
    const dbPath = getUniqueTestDbPath('query_status');
    const { db, opManager } = createTestNode(dbPath, 'node-A');

    // 1. Normal create becomes APPLIED
    const appliedOp = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-app',
      payload: { title: 'Applied Task' },
    });

    assert.strictEqual(opManager.getAppliedOperations().length, 1);
    assert.strictEqual(opManager.getPendingOperations().length, 0);

    // 2. Manually insert a PENDING operation into the log
    const createdAt = new Date().toISOString();
    const pendingChecksum = computeOperationChecksum({
      operationId: 'op-pending-1',
      nodeId: 'node-A',
      sequenceNumber: 2,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-pend',
      payload: { title: 'Pending Task' },
      createdAt,
      schemaVersion: 1,
    });

    db.getRawDb()
      .prepare(
        `INSERT INTO operations (
          operation_id, node_id, sequence_number, operation_type,
          entity_type, entity_id, payload, status, created_at, checksum, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'op-pending-1',
        'node-A',
        2,
        'CREATE',
        'task',
        'task-pend',
        JSON.stringify({ title: 'Pending Task' }),
        'PENDING',
        createdAt,
        pendingChecksum,
        1
      );

    const pendingOps = opManager.getPendingOperations();
    assert.strictEqual(pendingOps.length, 1);
    assert.strictEqual(pendingOps[0].operationId, 'op-pending-1');

    db.close();
    cleanupTestFile(dbPath);
  });

  it('queries operations after a given sequence number', () => {
    const dbPath = getUniqueTestDbPath('query_after_seq');
    const { db, opManager } = createTestNode(dbPath, 'node-A');

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-1',
      payload: {},
    });
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-2',
      payload: {},
    });
    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-3',
      payload: {},
    });

    const afterSeq1 = opManager.getOperationsAfterSequence('node-A', 1);
    assert.strictEqual(afterSeq1.length, 2);
    assert.strictEqual(afterSeq1[0].sequenceNumber, 2);
    assert.strictEqual(afterSeq1[1].sequenceNumber, 3);

    const afterSeq2 = opManager.getOperationsAfterSequence('node-A', 2);
    assert.strictEqual(afterSeq2.length, 1);
    assert.strictEqual(afterSeq2[0].sequenceNumber, 3);

    const afterSeq3 = opManager.getOperationsAfterSequence('node-A', 3);
    assert.strictEqual(afterSeq3.length, 0);

    db.close();
    cleanupTestFile(dbPath);
  });

  it('supports independent sequence numbers across different nodes', () => {
    const dbPath = getUniqueTestDbPath('query_multi_node');
    const db = new DatabaseManager({ dbPath });
    const configA = new NodeConfig(db, 'node-A');
    const opManagerA = new OperationManager(db, configA);

    const opA1 = opManagerA.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-from-a',
      payload: { by: 'A' },
    });
    assert.strictEqual(opA1.sequenceNumber, 1);
    assert.strictEqual(opA1.nodeId, 'node-A');

    // Create an operation for node-B via standalone apply
    const createdAt = new Date().toISOString();
    const checksumB1 = computeOperationChecksum({
      operationId: 'op-b-001',
      nodeId: 'node-B',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-from-b',
      payload: { by: 'B' },
      createdAt,
      schemaVersion: 1,
    });

    const opB1 = {
      operationId: 'op-b-001',
      nodeId: 'node-B',
      sequenceNumber: 1,
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-from-b',
      payload: { by: 'B' },
      status: 'PENDING' as const,
      createdAt,
      appliedAt: null,
      checksum: checksumB1,
      schemaVersion: 1,
    };

    opManagerA.applyOperation(opB1);

    // Verify: node-A has seq 1, node-B has seq 1 independently
    const foundA1 = opManagerA.getOperationBySequence('node-A', 1);
    const foundB1 = opManagerA.getOperationBySequence('node-B', 1);
    assert.ok(foundA1);
    assert.ok(foundB1);
    assert.strictEqual(foundA1.operationId, opA1.operationId);
    assert.strictEqual(foundB1.operationId, 'op-b-001');

    db.close();
    cleanupTestFile(dbPath);
  });
});
