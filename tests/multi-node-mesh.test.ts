import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { executeCommand, initMeshVault, type MeshVaultApp } from '../src/index.js';
import { cleanupTestFile, getUniqueTestDbPath } from './test-utils.js';

async function startNodeApp(prefix: string, preferredNodeId: string, port: number) {
  const dbPath = getUniqueTestDbPath(prefix);
  const app = initMeshVault(dbPath, preferredNodeId);
  const actualPort = await app.syncServer.start(port, '127.0.0.1');
  return {
    app,
    dbPath,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    stop: async () => {
      await app.syncServer.stop();
      app.db.close();
      cleanupTestFile(dbPath);
    },
  };
}

describe('Multi-Node Mesh Synchronization Verification', () => {
  it('synchronizes 2 independent nodes bi-directionally (Node A ↔ Node B)', async () => {
    const nodeA = await startNodeApp('mesh-2node-a', 'node-a', 0);
    const nodeB = await startNodeApp('mesh-2node-b', 'node-b', 0);

    try {
      // Offline / independent operations on Node A
      await executeCommand(nodeA.app, ['create', 'task', 'task-001', '{"title":"Task on A"}']);
      await executeCommand(nodeA.app, ['update', 'task', 'task-001', '{"title":"Task on A Updated"}']);

      // Offline / independent operations on Node B
      await executeCommand(nodeB.app, ['create', 'task', 'task-002', '{"title":"Task on B"}']);

      // Before sync, Node A does not have task-002 and Node B does not have task-001
      const recA1 = nodeA.app.opManager.getRecord('task-002', 'task');
      const recB1 = nodeB.app.opManager.getRecord('task-001', 'task');
      assert.strictEqual(recA1, null);
      assert.strictEqual(recB1, null);

      // Perform bi-directional CLI sync from Node A -> Node B
      await executeCommand(nodeA.app, ['sync', nodeB.url]);

      // Verify Node A received task-002 from Node B
      const recA2 = nodeA.app.opManager.getRecord('task-002', 'task');
      assert.notStrictEqual(recA2, null);
      assert.deepStrictEqual(recA2!.data, { title: 'Task on B' });

      // Verify Node B received task-001 from Node A (with latest updated title)
      const recB2 = nodeB.app.opManager.getRecord('task-001', 'task');
      assert.notStrictEqual(recB2, null);
      assert.deepStrictEqual(recB2!.data, { title: 'Task on A Updated' });

      // Verify identical sequence vectors on both nodes
      const vecA = nodeA.app.opManager.getSequenceVector();
      const vecB = nodeB.app.opManager.getSequenceVector();
      assert.deepStrictEqual(vecA, vecB);
      assert.strictEqual(vecA['node-a'], 2);
      assert.strictEqual(vecA['node-b'], 1);
    } finally {
      await nodeA.stop();
      await nodeB.stop();
    }
  });

  it('synchronizes 3 independent nodes in a mesh network (Node A ↔ Node B ↔ Node C)', async () => {
    const nodeA = await startNodeApp('mesh-3node-a', 'node-a', 0);
    const nodeB = await startNodeApp('mesh-3node-b', 'node-b', 0);
    const nodeC = await startNodeApp('mesh-3node-c', 'node-c', 0);

    try {
      // Independent operations on all 3 nodes
      await executeCommand(nodeA.app, ['create', 'doc', 'doc-101', '{"title":"Doc from Node A"}']);
      await executeCommand(nodeB.app, ['create', 'doc', 'doc-102', '{"title":"Doc from Node B"}']);
      await executeCommand(nodeC.app, ['create', 'doc', 'doc-103', '{"title":"Doc from Node C"}']);

      // Mesh sync sequence: Node A ↔ Node B, Node B ↔ Node C, Node A ↔ Node C
      await executeCommand(nodeA.app, ['sync', nodeB.url]); // A gets B's operations, B gets A's operations
      await executeCommand(nodeB.app, ['sync', nodeC.url]); // B (has A+B) syncs with C (has C) -> B & C have A+B+C
      await executeCommand(nodeA.app, ['sync', nodeC.url]); // A syncs with C -> A gets C's ops and B's ops forwarded

      // Verify all 3 nodes have all 3 records
      for (const [name, node] of [['Node A', nodeA], ['Node B', nodeB], ['Node C', nodeC]] as const) {
        const d101 = node.app.opManager.getRecord('doc-101', 'doc');
        const d102 = node.app.opManager.getRecord('doc-102', 'doc');
        const d103 = node.app.opManager.getRecord('doc-103', 'doc');

        assert.notStrictEqual(d101, null, `${name} missing doc-101`);
        assert.notStrictEqual(d102, null, `${name} missing doc-102`);
        assert.notStrictEqual(d103, null, `${name} missing doc-103`);

        assert.deepStrictEqual(d101!.data, { title: 'Doc from Node A' });
        assert.deepStrictEqual(d102!.data, { title: 'Doc from Node B' });
        assert.deepStrictEqual(d103!.data, { title: 'Doc from Node C' });
      }

      // Verify identical sequence vectors across all 3 nodes
      const vecA = nodeA.app.opManager.getSequenceVector();
      const vecB = nodeB.app.opManager.getSequenceVector();
      const vecC = nodeC.app.opManager.getSequenceVector();

      assert.deepStrictEqual(vecA, { 'node-a': 1, 'node-b': 1, 'node-c': 1 });
      assert.deepStrictEqual(vecB, { 'node-a': 1, 'node-b': 1, 'node-c': 1 });
      assert.deepStrictEqual(vecC, { 'node-a': 1, 'node-b': 1, 'node-c': 1 });
    } finally {
      await nodeA.stop();
      await nodeB.stop();
      await nodeC.stop();
    }
  });
});
