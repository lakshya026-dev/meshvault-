import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { verifyOperationIntegrity } from '../src/operations/integrity.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('Phase 2 Mandatory Restart Test', () => {
  it('preserves node ID, database, operation history, checksums, statuses, sequence counter, and local state across restart', () => {
    const dbPath = getUniqueTestDbPath('restart_spec');

    // ------------------------------------------------------------------
    // STEP 1: Application Starts (Session 1)
    // ------------------------------------------------------------------
    let db = new DatabaseManager({ dbPath });
    let nodeConfig = new NodeConfig(db, 'node-A');
    let opManager = new OperationManager(db, nodeConfig);

    const initialNodeId = nodeConfig.getNodeId();
    assert.strictEqual(initialNodeId, 'node-A');

    // ------------------------------------------------------------------
    // STEP 2: Create 3 Operations
    // ------------------------------------------------------------------
    // Operation 1: CREATE task-001
    const op1 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Learn Distributed Systems', status: 'pending' },
    });
    assert.strictEqual(op1.sequenceNumber, 1);
    assert.strictEqual(op1.status, 'APPLIED');
    assert.ok(op1.checksum);
    assert.ok(verifyOperationIntegrity(op1));

    // Operation 2: UPDATE task-001
    const op2 = opManager.createOperation({
      operationType: 'UPDATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { status: 'in-progress' },
    });
    assert.strictEqual(op2.sequenceNumber, 2);
    assert.strictEqual(op2.status, 'APPLIED');
    assert.ok(op2.checksum);
    assert.ok(verifyOperationIntegrity(op2));

    // Operation 3: CREATE task-002
    const op3 = opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-002',
      payload: { title: 'Master Event Sourcing' },
    });
    assert.strictEqual(op3.sequenceNumber, 3);
    assert.strictEqual(op3.status, 'APPLIED');
    assert.ok(op3.checksum);
    assert.ok(verifyOperationIntegrity(op3));

    // Verify state before shutdown
    assert.strictEqual(opManager.getCurrentSequenceNumber(), 3);
    assert.strictEqual(opManager.getAllRecords().length, 2);
    assert.strictEqual(opManager.getAllOperations().length, 3);

    // ------------------------------------------------------------------
    // STEP 3: Exit (Close Database)
    // ------------------------------------------------------------------
    db.close();

    // ------------------------------------------------------------------
    // STEP 4: Restart (Session 2)
    // ------------------------------------------------------------------
    db = new DatabaseManager({ dbPath });
    // When restarting, NodeConfig does not supply preferred node ID; loads from database
    nodeConfig = new NodeConfig(db);
    opManager = new OperationManager(db, nodeConfig);

    // Verify 1: Same Node ID
    assert.strictEqual(nodeConfig.getNodeId(), 'node-A', 'Node ID must remain identical');

    // Verify 2: Same sequence counter
    assert.strictEqual(
      opManager.getCurrentSequenceNumber(),
      3,
      'Sequence counter must be 3 after restart'
    );
    assert.strictEqual(
      opManager.getNextSequenceNumber(),
      4,
      'Next sequence number must be 4'
    );

    // Verify 3: Same operation history & checksums
    const opsAfter = opManager.getAllOperations();
    assert.strictEqual(opsAfter.length, 3, 'Must retain all 3 operations');

    assert.strictEqual(opsAfter[0].operationId, op1.operationId);
    assert.strictEqual(opsAfter[0].sequenceNumber, 1);
    assert.strictEqual(opsAfter[0].operationType, 'CREATE');
    assert.strictEqual(opsAfter[0].status, 'APPLIED');
    assert.strictEqual(opsAfter[0].checksum, op1.checksum);
    assert.ok(verifyOperationIntegrity(opsAfter[0]));

    assert.strictEqual(opsAfter[1].operationId, op2.operationId);
    assert.strictEqual(opsAfter[1].sequenceNumber, 2);
    assert.strictEqual(opsAfter[1].operationType, 'UPDATE');
    assert.strictEqual(opsAfter[1].status, 'APPLIED');
    assert.strictEqual(opsAfter[1].checksum, op2.checksum);
    assert.ok(verifyOperationIntegrity(opsAfter[1]));

    assert.strictEqual(opsAfter[2].operationId, op3.operationId);
    assert.strictEqual(opsAfter[2].sequenceNumber, 3);
    assert.strictEqual(opsAfter[2].operationType, 'CREATE');
    assert.strictEqual(opsAfter[2].status, 'APPLIED');
    assert.strictEqual(opsAfter[2].checksum, op3.checksum);
    assert.ok(verifyOperationIntegrity(opsAfter[2]));

    // Verify 4: Same local state
    const recordsAfter = opManager.getAllRecords();
    assert.strictEqual(recordsAfter.length, 2);
    const rec1 = opManager.getRecord('task-001');
    assert.ok(rec1);
    assert.deepStrictEqual(rec1.data, {
      title: 'Learn Distributed Systems',
      status: 'in-progress',
    });

    const rec2 = opManager.getRecord('task-002');
    assert.ok(rec2);
    assert.deepStrictEqual(rec2.data, {
      title: 'Master Event Sourcing',
    });

    // Verify 5: Post-restart operation continues monotonically
    const op4 = opManager.createOperation({
      operationType: 'DELETE',
      entityType: 'task',
      entityId: 'task-002',
      payload: {},
    });
    assert.strictEqual(op4.sequenceNumber, 4);
    assert.strictEqual(op4.status, 'APPLIED');
    assert.strictEqual(opManager.getAllRecords().length, 1);
    assert.strictEqual(opManager.getAllOperations().length, 4);

    db.close();
    cleanupTestFile(dbPath);
  });
});
