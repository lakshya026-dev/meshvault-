import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { computeOperationChecksum } from '../src/operations/integrity.js';
import { createSyncHttpServer, type SyncHttpServer } from '../src/sync/http-server.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

function createNode(dbPath: string, nodeId: string) {
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, nodeId);
  return { db, operationManager: new OperationManager(db, nodeConfig) };
}

function remoteOperation(
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
    payload: { source: nodeId, sequenceNumber },
    status: 'PENDING' as const,
    createdAt: new Date().toISOString(),
    appliedAt: null,
    checksum: '',
    schemaVersion: 1,
  };
  operation.checksum = computeOperationChecksum(operation);
  return operation;
}

async function startNode(nodeId: string, prefix: string): Promise<{
  db: DatabaseManager;
  operationManager: OperationManager;
  server: SyncHttpServer;
  baseUrl: string;
  dbPath: string;
}> {
  const dbPath = getUniqueTestDbPath(prefix);
  const { db, operationManager } = createNode(dbPath, nodeId);
  const server = createSyncHttpServer(operationManager, nodeId);
  const port = await server.start(0);
  return { db, operationManager, server, baseUrl: `http://127.0.0.1:${port}`, dbPath };
}

async function stopNode(node: {
  db: DatabaseManager;
  server: SyncHttpServer;
  dbPath: string;
}): Promise<void> {
  await node.server.stop();
  node.db.close();
  cleanupTestFile(node.dbPath);
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('Sync HTTP server', () => {
  it('returns an empty status for an empty node', async () => {
    const node = await startNode('node-empty', 'sync-http-empty');
    try {
      const result = await getJson(`${node.baseUrl}/sync/status`);
      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(result.body, {
        nodeId: 'node-empty',
        sequences: {},
        protocol: { currentVersion: 1, supportedVersions: [1] },
      });
    } finally {
      await stopNode(node);
    }
  });

  it('returns the local sequence vector in status', async () => {
    const node = await startNode('node-local', 'sync-http-status');
    try {
      node.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-1',
        payload: { value: 1 },
      });
      node.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-2',
        payload: { value: 2 },
      });

      const result = await getJson(`${node.baseUrl}/sync/status`);
      assert.deepStrictEqual(result.body, {
        nodeId: 'node-local',
        sequences: { 'node-local': 2 },
        protocol: { currentVersion: 1, supportedVersions: [1] },
      });
    } finally {
      await stopNode(node);
    }
  });

  it('returns an operation delta ordered by sequence number', async () => {
    const node = await startNode('node-origin', 'sync-http-delta');
    try {
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        node.operationManager.applyOperation(
          remoteOperation(`origin-op-${sequence}`, 'node-origin', sequence, `origin-${sequence}`)
        );
      }

      const result = await getJson(
        `${node.baseUrl}/sync/operations?nodeId=node-origin&afterSequence=3`
      );
      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(
        result.body.operations.map((operation: { sequenceNumber: number }) => operation.sequenceNumber),
        [4, 5]
      );
    } finally {
      await stopNode(node);
    }
  });

  it('applies the limit and preserves original identity and checksum', async () => {
    const node = await startNode('node-origin', 'sync-http-limit');
    try {
      const operations = [1, 2, 3].map((sequence) =>
        remoteOperation(`origin-limit-${sequence}`, 'node-origin', sequence, `limit-${sequence}`)
      );
      for (const operation of operations) {
        node.operationManager.applyOperation(operation);
      }

      const result = await getJson(
        `${node.baseUrl}/sync/operations?nodeId=node-origin&limit=2`
      );
      assert.strictEqual(result.body.operations.length, 2);
      assert.deepStrictEqual(
        result.body.operations.map((operation: { sequenceNumber: number }) => operation.sequenceNumber),
        [1, 2]
      );
      assert.deepStrictEqual(result.body.operations[0], {
        ...operations[0],
        status: 'APPLIED',
        appliedAt: result.body.operations[0].appliedAt,
        errorMessage: null,
        schemaVersion: 1,
      });
    } finally {
      await stopNode(node);
    }
  });

  it('returns an empty list for an unknown origin', async () => {
    const node = await startNode('node-local', 'sync-http-unknown');
    try {
      const result = await getJson(
        `${node.baseUrl}/sync/operations?nodeId=unknown-origin`
      );
      assert.deepStrictEqual(result.body, { operations: [] });
    } finally {
      await stopNode(node);
    }
  });

  it('returns 400 for invalid operation query parameters', async () => {
    const node = await startNode('node-local', 'sync-http-bad-params');
    try {
      for (const query of [
        'afterSequence=0',
        'nodeId=node-local&afterSequence=-1',
        'nodeId=node-local&afterSequence=abc',
        'nodeId=node-local&limit=0',
      ]) {
        const result = await getJson(`${node.baseUrl}/sync/operations?${query}`);
        assert.strictEqual(result.status, 400);
        assert.strictEqual(typeof result.body.error, 'string');
      }
    } finally {
      await stopNode(node);
    }
  });

  it('returns 404 for unknown routes and 405 for POST status requests', async () => {
    const node = await startNode('node-local', 'sync-http-methods');
    try {
      const unknown = await getJson(`${node.baseUrl}/unknown`);
      assert.strictEqual(unknown.status, 404);

      const statusPost = await fetch(`${node.baseUrl}/sync/status`, { method: 'POST' });
      assert.strictEqual(statusPost.status, 405);
    } finally {
      await stopNode(node);
    }
  });

  it('keeps two nodes and their servers isolated', async () => {
    const first = await startNode('node-first', 'sync-http-first');
    const second = await startNode('node-second', 'sync-http-second');
    try {
      first.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'first-task',
        payload: { owner: 'first' },
      });
      second.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'second-task',
        payload: { owner: 'second' },
      });

      const firstStatus = await getJson(`${first.baseUrl}/sync/status`);
      const secondStatus = await getJson(`${second.baseUrl}/sync/status`);
      assert.deepStrictEqual(firstStatus.body.sequences, { 'node-first': 1 });
      assert.deepStrictEqual(secondStatus.body.sequences, { 'node-second': 1 });
      assert.notStrictEqual(first.baseUrl, second.baseUrl);
    } finally {
      await stopNode(first);
      await stopNode(second);
    }
  });

  it('does not change the database when serving requests', async () => {
    const node = await startNode('node-local', 'sync-http-read-only');
    try {
      node.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'stable-task',
        payload: { stable: true },
      });
      const before = node.operationManager.getSequenceVector();

      await getJson(`${node.baseUrl}/sync/status`);
      await getJson(`${node.baseUrl}/sync/operations?nodeId=node-local`);
      await getJson(`${node.baseUrl}/sync/operations?nodeId=unknown`);

      assert.deepStrictEqual(node.operationManager.getSequenceVector(), before);
      assert.strictEqual(node.operationManager.getAllOperations().length, 1);
    } finally {
      await stopNode(node);
    }
  });

  it('accepts remote operations through POST and reports results', async () => {
    const node = await startNode('node-local', 'sync-http-post-success');
    try {
      const operation = remoteOperation('http-remote-1', 'node-remote', 1, 'http-remote-1');
      const result = await postJson(`${node.baseUrl}/sync/operations`, { operations: [operation] });

      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(result.body.summary, { applied: 1, duplicates: 0, rejected: 0 });
      assert.strictEqual(result.body.results[0].outcome, 'applied');
      assert.strictEqual(node.operationManager.getOperation(operation.operationId)?.checksum, operation.checksum);
    } finally {
      await stopNode(node);
    }
  });

  it('rejects invalid POST bodies and oversized requests', async () => {
    const node = await startNode('node-local', 'sync-http-post-validation');
    try {
      const invalidJsonResponse = await fetch(`${node.baseUrl}/sync/operations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"operations":',
      });
      assert.strictEqual(invalidJsonResponse.status, 400);

      const nonArray = await postJson(`${node.baseUrl}/sync/operations`, { operations: {} });
      assert.strictEqual(nonArray.status, 400);

      const tooMany = await postJson(
        `${node.baseUrl}/sync/operations`,
        { operations: new Array(1001).fill(null) }
      );
      assert.strictEqual(tooMany.status, 400);

      const oversizedResponse = await fetch(`${node.baseUrl}/sync/operations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(5 * 1024 * 1024 + 1),
        },
        body: 'x'.repeat(5 * 1024 * 1024 + 1),
      });
      assert.strictEqual(oversizedResponse.status, 413);
    } finally {
      await stopNode(node);
    }
  });

  it('returns 405 for PUT to the operations endpoint', async () => {
    const node = await startNode('node-local', 'sync-http-post-method');
    try {
      const response = await fetch(`${node.baseUrl}/sync/operations`, { method: 'PUT' });
      assert.strictEqual(response.status, 405);
    } finally {
      await stopNode(node);
    }
  });
});
