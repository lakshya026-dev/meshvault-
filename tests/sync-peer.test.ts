import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { SyncManager } from '../src/sync/sync-manager.js';
import { createSyncHttpServer } from '../src/sync/http-server.js';
import { cleanupTestFile, getUniqueTestDbPath } from './test-utils.js';

function createNode(dbPath: string, nodeId: string) {
  const db = new DatabaseManager({ dbPath });
  const operationManager = new OperationManager(db, new NodeConfig(db, nodeId));
  return {
    db,
    operationManager,
    syncManager: new SyncManager(operationManager, nodeId),
  };
}

function createOperation(
  operationId: string,
  nodeId: string,
  sequenceNumber: number,
  entityId: string
) {
  const operation = {
    operationId,
    nodeId,
    sequenceNumber,
    operationType: 'CREATE' as const,
    entityType: 'task',
    entityId,
    payload: { sequenceNumber },
    status: 'PENDING' as const,
    createdAt: new Date().toISOString(),
    appliedAt: null,
    checksum: '',
    errorMessage: null,
  };
  operation.checksum = computeOperationChecksum(operation);
  return operation;
}

async function startNode(nodeId: string, prefix: string) {
  const dbPath = getUniqueTestDbPath(prefix);
  const node = createNode(dbPath, nodeId);
  const server = createSyncHttpServer(node.operationManager, nodeId);
  const port = await server.start(0);
  return {
    ...node,
    dbPath,
    server,
    url: `http://127.0.0.1:${port}`,
  };
}

async function stopNode(node: Awaited<ReturnType<typeof startNode>>) {
  await node.server.stop();
  node.db.close();
  cleanupTestFile(node.dbPath);
}

function addLocalOperation(
  node: ReturnType<typeof createNode>,
  entityId: string
) {
  return node.operationManager.createOperation({
    operationType: 'CREATE',
    entityType: 'task',
    entityId,
    payload: { entityId },
  });
}

async function startMockServer(
  handler: (request: Request) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>
): Promise<{ url: string; close: () => Promise<void> }> {
  let server: Server;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const result = await handler(
      new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      })
    );
    const body = JSON.stringify(result.body);
    response.statusCode = result.status;
    response.setHeader('Content-Type', 'application/json');
    response.end(body);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to determine mock port.'));
      } else {
        resolve(address.port);
      }
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

describe('SyncManager peer synchronization', () => {
  it('performs bidirectional delta sync across multiple origins', async () => {
    const left = await startNode('node-left', 'sync-peer-left');
    const right = await startNode('node-right', 'sync-peer-right');
    try {
      addLocalOperation(left, 'left-1');
      addLocalOperation(left, 'left-2');
      addLocalOperation(right, 'right-1');

      const result = await left.syncManager.syncWithPeer(right.url);

      assert.strictEqual(result.pulled.summary.applied, 1);
      assert.strictEqual(result.pushed.summary.applied, 2);
      assert.deepStrictEqual(left.operationManager.getSequenceVector(), {
        'node-left': 2,
        'node-right': 1,
      });
      assert.deepStrictEqual(right.operationManager.getSequenceVector(), {
        'node-right': 1,
        'node-left': 2,
      });
    } finally {
      await stopNode(left);
      await stopNode(right);
    }
  });

  it('repeats safely and transfers only missing deltas', async () => {
    const left = await startNode('node-left', 'sync-peer-repeat-left');
    const right = await startNode('node-right', 'sync-peer-repeat-right');
    try {
      addLocalOperation(left, 'left-1');
      addLocalOperation(right, 'right-1');
      const first = await left.syncManager.syncWithPeer(right.url);
      addLocalOperation(left, 'left-2');
      const second = await left.syncManager.syncWithPeer(right.url);

      assert.strictEqual(first.pushed.summary.applied, 1);
      assert.strictEqual(second.pushed.summary.applied, 1);
      assert.strictEqual(second.pulled.summary.applied, 0);
      assert.strictEqual(second.pulled.summary.duplicates, 0);
      assert.strictEqual(right.operationManager.getAllOperations().length, 3);
    } finally {
      await stopNode(left);
      await stopNode(right);
    }
  });

  it('continues safely after a partial transfer is retried', async () => {
    const node = createNode(getUniqueTestDbPath('sync-peer-partial-local'), 'node-local');
    const operations = [
      createOperation('remote-1', 'node-remote', 1, 'remote-1'),
      createOperation('remote-2', 'node-remote', 2, 'remote-2'),
    ];
    let requests = 0;
    const mock = await startMockServer((request) => {
      if (request.url.includes('/sync/status')) {
        return { status: 200, body: { nodeId: 'node-remote', sequences: { 'node-remote': 2 } } };
      }
      requests += 1;
      if (requests === 1) {
        return { status: 200, body: { operations: [operations[0]] } };
      }
      return { status: 200, body: { operations: [operations[1]] } };
    });
    try {
      await node.syncManager.syncWithPeer(mock.url);
      assert.strictEqual(node.operationManager.getAllOperations().length, 2);
      assert.strictEqual(requests, 2);
    } finally {
      await mock.close();
      node.db.close();
      cleanupTestFile(getUniqueTestDbPath('never-used'));
    }
  });

  it('rejects malformed peer responses and HTTP failures', async () => {
    const dbPath = getUniqueTestDbPath('sync-peer-errors');
    const node = createNode(dbPath, 'node-local');
    const malformed = await startMockServer(() => ({ status: 200, body: { sequences: [] } }));
    const malformedOperation = await startMockServer((request) => {
      if (request.url.includes('/sync/status')) {
        return { status: 200, body: { nodeId: 'node-remote', sequences: { 'node-remote': 1 } } };
      }
      return { status: 200, body: { operations: [{ operationId: 'missing-fields' }] } };
    });
    const checksumMismatch = await startMockServer((request) => {
      if (request.url.includes('/sync/status')) {
        return { status: 200, body: { nodeId: 'node-remote', sequences: { 'node-remote': 1 } } };
      }
      return {
        status: 200,
        body: {
          operations: [
            {
              ...createOperation('tampered', 'node-remote', 1, 'tampered'),
              payload: { changed: true },
            },
          ],
        },
      };
    });
    const clientError = await startMockServer(() => ({ status: 400, body: { error: 'bad request' } }));
    const serverError = await startMockServer(() => ({ status: 500, body: { error: 'failure' } }));
    try {
      await assert.rejects(node.syncManager.syncWithPeer(malformed.url), /malformed status/i);
      await assert.rejects(
        node.syncManager.syncWithPeer(malformedOperation.url),
        /malformed operation/i
      );
      await assert.rejects(
        node.syncManager.syncWithPeer(checksumMismatch.url),
        /checksum_mismatch/i
      );
      await assert.rejects(node.syncManager.syncWithPeer(clientError.url), /HTTP 400/);
      await assert.rejects(node.syncManager.syncWithPeer(serverError.url), /HTTP 500/);
      await assert.rejects(
        node.syncManager.syncWithPeer('http://127.0.0.1:1'),
        /fetch failed|connect|refused/i
      );
    } finally {
      await malformed.close();
      await malformedOperation.close();
      await checksumMismatch.close();
      await clientError.close();
      await serverError.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('rejects an incomplete push acknowledgement without advancing the transfer', async () => {
    const node = await startNode('node-local', 'sync-peer-incomplete-ack');
    const peer = await startMockServer((request) => {
      if (request.url.includes('/sync/status')) {
        return { status: 200, body: { nodeId: 'node-peer', sequences: {} } };
      }
      return {
        status: 200,
        body: { results: [], summary: { applied: 0, duplicates: 0, rejected: 0 } },
      };
    });
    try {
      addLocalOperation(node, 'local-1');
      await assert.rejects(
        node.syncManager.syncWithPeer(peer.url),
        /incomplete synchronization response/i
      );
    } finally {
      await peer.close();
      await stopNode(node);
    }
  });

  it('persists synchronized operations across restart', async () => {
    const left = await startNode('node-left', 'sync-peer-restart-left');
    const right = await startNode('node-right', 'sync-peer-restart-right');
    try {
      addLocalOperation(right, 'right-1');
      await left.syncManager.syncWithPeer(right.url);
      const dbPath = left.dbPath;
      await left.server.stop();
      left.db.close();
      const reopened = createNode(dbPath, 'node-left');
      try {
        assert.ok(reopened.operationManager.getOperationBySequence('node-right', 1));
        const result = await reopened.syncManager.syncWithPeer(right.url);
        assert.deepStrictEqual(result.pulled.summary, {
          applied: 0,
          duplicates: 0,
          rejected: 0,
        });
        assert.strictEqual(reopened.operationManager.getAllRecords().length, 1);
      } finally {
        reopened.db.close();
        cleanupTestFile(dbPath);
      }
    } finally {
      await stopNode(right);
    }
  });
});
