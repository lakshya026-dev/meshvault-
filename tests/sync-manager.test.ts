import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { SyncManager } from '../src/sync/sync-manager.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

function createNode(dbPath: string, nodeId = 'node-local') {
  const db = new DatabaseManager({ dbPath });
  const operationManager = new OperationManager(db, new NodeConfig(db, nodeId));
  return { db, operationManager, syncManager: new SyncManager(operationManager, nodeId) };
}

function remoteOperation(
  operationId: string,
  nodeId: string,
  sequenceNumber: number,
  entityId: string,
  payload: Record<string, unknown> = { sequenceNumber }
) {
  const operation = {
    operationId,
    nodeId,
    sequenceNumber,
    operationType: 'CREATE' as const,
    entityType: 'task',
    entityId,
    payload,
    status: 'PENDING' as const,
    createdAt: new Date().toISOString(),
    appliedAt: null,
    checksum: '',
    errorMessage: null,
  };
  operation.checksum = computeOperationChecksum(operation);
  return operation;
}

function closeAndClean(db: DatabaseManager, dbPath: string): void {
  db.close();
  cleanupTestFile(dbPath);
}

describe('SyncManager', () => {
  it('applies a valid remote batch and preserves local sequence state', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-valid');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'local-task',
        payload: { local: true },
      });
      const batch = [
        remoteOperation('remote-1', 'node-a', 1, 'remote-task-1'),
        remoteOperation('remote-2', 'node-a', 2, 'remote-task-2'),
      ];

      const received = syncManager.receiveOperations(batch);

      assert.deepStrictEqual(received.summary, { applied: 2, duplicates: 0, rejected: 0 });
      assert.deepStrictEqual(syncManager.getSyncStatus().sequences, {
        'node-local': 1,
        'node-a': 2,
      });
      assert.ok(operationManager.getRecord('remote-task-1', 'task'));
      assert.strictEqual(operationManager.getOperation('remote-1')?.checksum, batch[0].checksum);
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('treats the same batch twice as duplicates without changing state', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-duplicates');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const batch = [
        remoteOperation('duplicate-1', 'node-a', 1, 'duplicate-task-1'),
        remoteOperation('duplicate-2', 'node-a', 2, 'duplicate-task-2'),
      ];
      syncManager.receiveOperations(batch);
      const before = {
        vector: syncManager.getSyncStatus().sequences,
        records: operationManager.getAllRecords(),
      };

      const received = syncManager.receiveOperations(batch);

      assert.deepStrictEqual(received.summary, { applied: 0, duplicates: 2, rejected: 0 });
      assert.deepStrictEqual(syncManager.getSyncStatus().sequences, before.vector);
      assert.deepStrictEqual(operationManager.getAllRecords(), before.records);
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('rejects same operation ID with different content as an integrity violation', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-conflict');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const original = remoteOperation('conflict-1', 'node-a', 1, 'conflict-task', { value: 1 });
      syncManager.receiveOperations([original]);
      const conflicting = remoteOperation(
        'conflict-1',
        'node-a',
        1,
        'conflict-task',
        { value: 2 }
      );

      const received = syncManager.receiveOperations([conflicting]);

      assert.deepStrictEqual(received.results[0], {
        operationId: 'conflict-1',
        nodeId: 'node-a',
        sequenceNumber: 1,
        outcome: 'rejected',
        reason: 'integrity_violation',
      });
      assert.deepStrictEqual(operationManager.getRecord('conflict-task', 'task')?.data, { value: 1 });
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('rejects a tampered payload with checksum mismatch', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-tampered');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const original = remoteOperation('tampered-1', 'node-a', 1, 'tampered-task');
      const tampered = { ...original, payload: { sequenceNumber: 999 } };

      const received = syncManager.receiveOperations([tampered]);

      assert.strictEqual(received.results[0].reason, 'checksum_mismatch');
      assert.strictEqual(operationManager.getOperation('tampered-1'), null);
      assert.strictEqual(operationManager.getRecord('tampered-task', 'task'), null);
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('rejects malformed entries while applying other valid entries', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-malformed');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const valid = remoteOperation('valid-after-malformed', 'node-a', 1, 'valid-task');
      const received = syncManager.receiveOperations([
        null,
        { operationId: 'missing-fields' },
        { ...valid, sequenceNumber: '1' },
        valid,
      ]);

      assert.deepStrictEqual(received.summary, { applied: 1, duplicates: 0, rejected: 3 });
      assert.strictEqual(received.results[3].outcome, 'applied');
      assert.ok(operationManager.getOperation(valid.operationId));
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('enforces contiguous sequence numbers and allows a later fill', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-gaps');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const firstBatch = [1, 2, 3].map((sequence) =>
        remoteOperation(`gap-${sequence}`, 'node-a', sequence, `gap-${sequence}`)
      );
      syncManager.receiveOperations(firstBatch);
      const five = remoteOperation('gap-5', 'node-a', 5, 'gap-5');
      assert.strictEqual(syncManager.receiveOperations([five]).results[0].reason, 'sequence_gap');
      assert.strictEqual(operationManager.getOperation('gap-5'), null);

      const four = remoteOperation('gap-4', 'node-a', 4, 'gap-4');
      const filled = syncManager.receiveOperations([four, five]);
      assert.deepStrictEqual(filled.summary, { applied: 2, duplicates: 0, rejected: 0 });
      assert.deepStrictEqual(syncManager.getSyncStatus().sequences, { 'node-a': 5 });
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('sorts shuffled in-order operations before applying and returns input order', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-shuffled');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const operations = [1, 2, 3].map((sequence) =>
        remoteOperation(`shuffle-${sequence}`, 'node-a', sequence, `shuffle-${sequence}`)
      );
      const received = syncManager.receiveOperations([operations[2], operations[0], operations[1]]);

      assert.deepStrictEqual(
        received.results.map((result) => result.operationId),
        ['shuffle-3', 'shuffle-1', 'shuffle-2']
      );
      assert.deepStrictEqual(received.summary, { applied: 3, duplicates: 0, rejected: 0 });
      assert.deepStrictEqual(syncManager.getSyncStatus().sequences, { 'node-a': 3 });
      assert.strictEqual(operationManager.getAllRecords().length, 3);
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('blocks later operations after a gap while allowing other origins', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-gap-batch');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const received = syncManager.receiveOperations([
        remoteOperation('gap-b-2', 'node-b', 2, 'gap-b-2'),
        remoteOperation('gap-b-3', 'node-b', 3, 'gap-b-3'),
        remoteOperation('origin-c-1', 'node-c', 1, 'origin-c-1'),
      ]);

      assert.strictEqual(received.results[0].reason, 'sequence_gap');
      assert.strictEqual(received.results[1].reason, 'sequence_gap');
      assert.strictEqual(received.results[2].outcome, 'applied');
      assert.deepStrictEqual(syncManager.getSyncStatus().sequences, { 'node-c': 1 });
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('handles two origins in one batch and rejects new local-origin operations', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-origins');
    const { db, operationManager, syncManager } = createNode(dbPath, 'node-local');
    try {
      const localOperation = remoteOperation('claimed-local', 'node-local', 1, 'claimed-local');
      const received = syncManager.receiveOperations([
        remoteOperation('origin-a-1', 'node-a', 1, 'origin-a-1'),
        remoteOperation('origin-b-1', 'node-b', 1, 'origin-b-1'),
        localOperation,
      ]);

      assert.deepStrictEqual(received.summary, { applied: 2, duplicates: 0, rejected: 1 });
      assert.strictEqual(received.results[2].reason, 'local_origin');
      assert.deepStrictEqual(syncManager.getSyncStatus().sequences, {
        'node-a': 1,
        'node-b': 1,
      });
      assert.strictEqual(operationManager.getOperation('claimed-local'), null);
    } finally {
      closeAndClean(db, dbPath);
    }
  });

  it('survives restart and re-sending becomes duplicates', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-restart');
    const batch = [
      remoteOperation('restart-1', 'node-a', 1, 'restart-1'),
      remoteOperation('restart-2', 'node-a', 2, 'restart-2'),
    ];
    const first = createNode(dbPath);
    first.syncManager.receiveOperations(batch);
    const firstVector = first.syncManager.getSyncStatus().sequences;
    first.db.close();

    const second = createNode(dbPath);
    try {
      assert.deepStrictEqual(second.syncManager.getSyncStatus().sequences, firstVector);
      const received = second.syncManager.receiveOperations(batch);
      assert.deepStrictEqual(received.summary, { applied: 0, duplicates: 2, rejected: 0 });
      assert.ok(second.operationManager.getRecord('restart-1', 'task'));
    } finally {
      closeAndClean(second.db, dbPath);
    }
  });

  it('does not change records when input is rejected', () => {
    const dbPath = getUniqueTestDbPath('sync-manager-rejected-state');
    const { db, operationManager, syncManager } = createNode(dbPath);
    try {
      const before = operationManager.getAllRecords();
      const tampered = remoteOperation('rejected-state', 'node-a', 1, 'rejected-state');
      tampered.payload = { changed: true };

      syncManager.receiveOperations([tampered, remoteOperation('gap-state', 'node-b', 2, 'gap-state')]);

      assert.deepStrictEqual(operationManager.getAllRecords(), before);
    } finally {
      closeAndClean(db, dbPath);
    }
  });
});
