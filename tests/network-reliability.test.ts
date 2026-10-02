import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { SyncManager, calculateBackoffDelay, type RetryOptions } from '../src/sync/sync-manager.js';
import { createSyncHttpServer } from '../src/sync/http-server.js';
import { NetworkError, MeshVaultError } from '../src/errors.js';
import { cleanupTestFile, getUniqueTestDbPath } from './test-utils.js';

function createNode(dbPath: string, nodeId: string, retryOptions?: RetryOptions) {
  const db = new DatabaseManager({ dbPath });
  const operationManager = new OperationManager(db, new NodeConfig(db, nodeId));
  return {
    db,
    operationManager,
    syncManager: new SyncManager(operationManager, nodeId, {
      initialDelayMs: 0,
      maxDelayMs: 0,
      attemptTimeoutMs: 1000,
      jitter: false,
      ...retryOptions,
    }),
  };
}

async function startMockServer(
  handler: (req: { method: string; url: string; body: unknown }, res: { status: number; headers: Record<string, string>; destroy: () => void; json: (data: unknown) => void }) => void | Promise<void>
): Promise<{ url: string; close: () => Promise<void> }> {
  let server: Server;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    let ended = false;
    await handler(
      { method: req.method ?? 'GET', url: req.url ?? '/', body },
      {
        status: 200,
        headers: {},
        destroy: () => {
          ended = true;
          req.destroy();
          res.destroy();
        },
        json: (data: unknown) => {
          if (ended) return;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
          ended = true;
        },
      }
    );
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('Failed to bind server'));
      }
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('Phase 4 — Reliability & Network Resiliency', () => {
  it('calculates exponential backoff delay correctly with and without jitter', () => {
    const options = {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 2000,
      backoffFactor: 2,
      attemptTimeoutMs: 3000,
      jitter: false,
    };

    assert.strictEqual(calculateBackoffDelay(0, options), 0);
    assert.strictEqual(calculateBackoffDelay(1, options), 100);
    assert.strictEqual(calculateBackoffDelay(2, options), 200);
    assert.strictEqual(calculateBackoffDelay(3, options), 400);
    assert.strictEqual(calculateBackoffDelay(4, options), 800);
    assert.strictEqual(calculateBackoffDelay(5, options), 1600);
    assert.strictEqual(calculateBackoffDelay(6, options), 2000); // capped at maxDelayMs

    // Jitter test
    const jitterOptions = { ...options, jitter: true };
    const jitterDelay = calculateBackoffDelay(1, jitterOptions);
    assert.ok(jitterDelay >= 80 && jitterDelay <= 120);
  });

  it('retries on 503 Service Unavailable and succeeds when server recovers', async () => {
    let attemptCount = 0;
    const server = await startMockServer((_req, res) => {
      attemptCount += 1;
      if (attemptCount <= 2) {
        res.json(null); // overridden by sending status 503
        // send status 503 explicitly
      }
    });

    // Let's implement status 503 handling cleanly in mock server
    await server.close();

    let attempts = 0;
    const customServer = createServer((_req, res) => {
      attempts += 1;
      if (attempts <= 2) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Service Unavailable' }));
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ nodeId: 'peer-node', sequences: {} }));
      }
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-503');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 3 });

    try {
      const result = await node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`);
      assert.strictEqual(attempts, 3); // 1 initial + 2 retries = 3 total attempts
      assert.deepStrictEqual(result.pulled.results, []);
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('exhausts maxRetries on continuous 500 errors and throws NetworkError', async () => {
    let attempts = 0;
    const customServer = createServer((_req, res) => {
      attempts += 1;
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-500');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 3 });

    try {
      await assert.rejects(
        () => node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`),
        (err: unknown) => {
          assert.ok(err instanceof NetworkError);
          assert.strictEqual(err.statusCode, 500);
          return true;
        }
      );
      assert.strictEqual(attempts, 4); // 1 initial + 3 retries = 4 total attempts
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('fails fast immediately without retries on HTTP 404 Not Found', async () => {
    let attempts = 0;
    const customServer = createServer((_req, res) => {
      attempts += 1;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-404');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 3 });

    try {
      await assert.rejects(
        () => node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`),
        (err: unknown) => {
          assert.ok(err instanceof NetworkError);
          assert.strictEqual(err.statusCode, 404);
          return true;
        }
      );
      assert.strictEqual(attempts, 1); // 1 attempt, zero retries
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('fails fast immediately without retries on HTTP 400 Bad Request', async () => {
    let attempts = 0;
    const customServer = createServer((_req, res) => {
      attempts += 1;
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Bad Request' }));
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-400');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 3 });

    try {
      await assert.rejects(
        () => node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`),
        (err: unknown) => {
          assert.ok(err instanceof NetworkError);
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
      assert.strictEqual(attempts, 1); // 1 attempt, zero retries
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('honors maxRetries = 0 by making exactly 1 total attempt', async () => {
    let attempts = 0;
    const customServer = createServer((_req, res) => {
      attempts += 1;
      res.statusCode = 503;
      res.end('Unavailable');
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-maxretries-0');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 0 });

    try {
      await assert.rejects(
        () => node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`),
        NetworkError
      );
      assert.strictEqual(attempts, 1);
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('handles per-attempt timeout and retries successfully when server responds on retry', async () => {
    let attempts = 0;
    const customServer = createServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        // First attempt hangs longer than attemptTimeoutMs (100ms)
        setTimeout(() => {
          res.statusCode = 200;
          res.end(JSON.stringify({ nodeId: 'peer', sequences: {} }));
        }, 300);
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ nodeId: 'peer', sequences: {} }));
      }
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-timeout');
    const node = createNode(dbPath, 'node-rel', {
      maxRetries: 2,
      attemptTimeoutMs: 100, // Short timeout for fast test
    });

    try {
      const result = await node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`);
      assert.strictEqual(attempts, 2); // 1st timed out, 2nd succeeded
      assert.deepStrictEqual(result.pulled.results, []);
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('retries connection failures (closed port) up to maxRetries', async () => {
    const dbPath = getUniqueTestDbPath('rel-conn-fail');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 2 });

    try {
      // Port 59999 is unlikely to have an active server listening
      await assert.rejects(
        () => node.syncManager.syncWithPeer('http://127.0.0.1:59999'),
        (err: unknown) => {
          assert.ok(err instanceof NetworkError);
          return true;
        }
      );
    } finally {
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('safely handles dropped POST response via idempotent operation replay', async () => {
    // Target peer node running actual SyncManager & DB
    const dbPathPeer = getUniqueTestDbPath('rel-dropped-post-peer');
    const peerNode = createNode(dbPathPeer, 'peer-node');
    const peerHttpServer = createSyncHttpServer(peerNode.operationManager, 'peer-node', peerNode.syncManager);
    const peerPort = await peerHttpServer.start(0, '127.0.0.1');

    // Local node creating an operation to push
    const dbPathLocal = getUniqueTestDbPath('rel-dropped-post-local');
    const localNode = createNode(dbPathLocal, 'local-node');
    const op = localNode.operationManager.createOperation({
      operationType: 'CREATE',
      entityType: 'document',
      entityId: 'doc-dropped-1',
      payload: { title: 'Dropped POST Test' },
    });

    // Intercept POST request on proxy to simulate dropped connection on 1st POST attempt
    let postAttempts = 0;
    const proxyServer = createServer(async (req, res) => {
      let reqBody: string | undefined = undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        reqBody = Buffer.concat(chunks).toString('utf-8');
      }

      if (req.method === 'POST' && req.url === '/sync/operations') {
        postAttempts += 1;
        if (postAttempts === 1) {
          // Process POST manually on peer Node, then destroy connection without returning response
          const body = JSON.parse(reqBody!);
          peerNode.syncManager.receiveOperations(body.operations);
          req.destroy();
          res.destroy();
          return;
        }
      }

      // Proxy all other requests to actual peer server
      const proxyReq = fetch(`http://127.0.0.1:${peerPort}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: reqBody,
      });
      const proxyRes = await proxyReq;
      res.statusCode = proxyRes.status;
      for (const [k, v] of proxyRes.headers) {
        res.setHeader(k, v);
      }
      const text = await proxyRes.text();
      res.end(text);
    });

    const proxyPort = await new Promise<number>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => {
        resolve((proxyServer.address() as { port: number }).port);
      });
    });

    try {
      const result = await localNode.syncManager.syncWithPeer(`http://127.0.0.1:${proxyPort}`);

      assert.strictEqual(postAttempts, 2); // 1st dropped, 2nd retried
      assert.strictEqual(result.pushed.summary.duplicates, 1); // Recognized as duplicate on retry
      assert.strictEqual(result.pushed.summary.applied, 0);

      // Explicit verification: Operation count does not increase after duplicate retry
      const peerOps = peerNode.operationManager.getAllOperations();
      assert.strictEqual(peerOps.length, 1);
      assert.strictEqual(peerOps[0].operationId, op.operationId);

      // Explicit verification: Record state is not applied twice
      const peerRecord = peerNode.operationManager.getRecord('doc-dropped-1', 'document');
      assert.notStrictEqual(peerRecord, null);
      assert.deepStrictEqual(peerRecord!.data, { title: 'Dropped POST Test' });
    } finally {
      proxyServer.close();
      await peerHttpServer.stop();
      peerNode.db.close();
      localNode.db.close();
      cleanupTestFile(dbPathPeer);
      cleanupTestFile(dbPathLocal);
    }
  });

  it('maintains request-level retry budget isolation across distinct HTTP calls', async () => {
    let statusAttempts = 0;

    const customServer = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/sync/status') {
        statusAttempts += 1;
        if (statusAttempts <= 2) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Unavailable' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ nodeId: 'peer', sequences: {} }));
        return;
      }
    });

    const port = await new Promise<number>((resolve) => {
      customServer.listen(0, '127.0.0.1', () => {
        resolve((customServer.address() as { port: number }).port);
      });
    });

    const dbPath = getUniqueTestDbPath('rel-isolation');
    const node = createNode(dbPath, 'node-rel', { maxRetries: 3 });

    try {
      await node.syncManager.syncWithPeer(`http://127.0.0.1:${port}`);
      assert.strictEqual(statusAttempts, 3); // 1 initial + 2 retries
    } finally {
      customServer.close();
      node.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('preserves partial progress on sync failure and resumes cleanly on subsequent call', async () => {
    const dbPathPeer = getUniqueTestDbPath('rel-partial-peer');
    const peerNode = createNode(dbPathPeer, 'peer-node');
    const peerHttpServer = createSyncHttpServer(peerNode.operationManager, 'peer-node', peerNode.syncManager);
    const peerPort = await peerHttpServer.start(0, '127.0.0.1');

    // Create 2 operations on peer
    const op1 = peerNode.operationManager.createOperation({
      operationType: 'CREATE',
      entityType: 'item',
      entityId: 'item-1',
      payload: { val: 1 },
    });
    const op2 = peerNode.operationManager.createOperation({
      operationType: 'CREATE',
      entityType: 'item',
      entityId: 'item-2',
      payload: { val: 2 },
    });

    const dbPathLocal = getUniqueTestDbPath('rel-partial-local');
    const localNode = createNode(dbPathLocal, 'local-node', { maxRetries: 0 });

    let pullAttempt = 0;
    const proxyServer = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url?.startsWith('/sync/operations?nodeId=peer-node')) {
        pullAttempt += 1;
        if (pullAttempt === 1) {
          // Serve Batch 1 (op1 only) to simulate chunked transfer
          res.statusCode = 200;
          res.end(JSON.stringify({ operations: [op1] }));
          return;
        }
        if (pullAttempt === 2) {
          // Fail Batch 2 with 500 Server Error
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Server explosion' }));
          return;
        }
      }

      const proxyReq = fetch(`http://127.0.0.1:${peerPort}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      });
      const proxyRes = await proxyReq;
      res.statusCode = proxyRes.status;
      res.end(await proxyRes.text());
    });

    const proxyPort = await new Promise<number>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => {
        resolve((proxyServer.address() as { port: number }).port);
      });
    });

    try {
      // First sync attempt will apply op1, then fail on 2nd batch fetch
      await assert.rejects(
        () => localNode.syncManager.syncWithPeer(`http://127.0.0.1:${proxyPort}`),
        NetworkError
      );

      // Verify item-1 was applied & persisted locally before failure
      const localRec1 = localNode.operationManager.getRecord('item-1', 'item');
      assert.notStrictEqual(localRec1, null);

      // Second sync attempt (proxy forwards to peer server starting from afterSequence=1)
      const res2 = await localNode.syncManager.syncWithPeer(`http://127.0.0.1:${proxyPort}`);
      assert.strictEqual(res2.pulled.summary.applied, 1); // Only item-2 fetched and applied!

      const localRec2 = localNode.operationManager.getRecord('item-2', 'item');
      assert.notStrictEqual(localRec2, null);
    } finally {
      proxyServer.close();
      await peerHttpServer.stop();
      peerNode.db.close();
      localNode.db.close();
      cleanupTestFile(dbPathPeer);
      cleanupTestFile(dbPathLocal);
    }
  });
});

