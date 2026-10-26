import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import { SyncManager } from '../src/sync/sync-manager.js';
import {
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  commonProtocolVersions,
  validateProtocolCapabilities,
  ProtocolCapabilities,
} from '../src/sync/protocol.js';
import { ProtocolVersionMismatchError } from '../src/errors.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

function createNode(dbPath: string, nodeId: string) {
  const db = new DatabaseManager({ dbPath });
  const nodeConfig = new NodeConfig(db, nodeId);
  const operationManager = new OperationManager(db, nodeConfig);
  return {
    db,
    operationManager,
    syncManager: new SyncManager(
      operationManager,
      nodeId,
      { maxRetries: 0 }
    ),
  };
}

describe('Sync Protocol Version', () => {
  describe('Capability advertisement', () => {
    it('empty node status includes protocol capabilities', () => {
      const dbPath = getUniqueTestDbPath('proto-empty');
      const db = new DatabaseManager({ dbPath });
      const nodeConfig = new NodeConfig(db, 'proto-empty-node');
      const operationManager = new OperationManager(db, nodeConfig);
      const syncManager = new SyncManager(operationManager, 'proto-empty-node');

      const status = syncManager.getSyncStatus();
      assert.ok('protocol' in status, 'status must include protocol field');
      assert.strictEqual(status.protocol.currentVersion, CURRENT_PROTOCOL_VERSION);
      assert.deepStrictEqual(status.protocol.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);

      db.close();
      cleanupTestFile(dbPath);
    });

    it('status protocol field is present after operations', () => {
      const dbPath = getUniqueTestDbPath('proto-with-ops');
      const db = new DatabaseManager({ dbPath });
      const nodeConfig = new NodeConfig(db, 'nego-node-ops');
      const operationManager = new OperationManager(db, nodeConfig);
      const syncManager = new SyncManager(operationManager, 'proto-node-ops');

      operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'test',
        entityId: 'test-1',
        payload: { value: 1 },
      });

      const status = syncManager.getSyncStatus();
      assert.ok('protocol' in status);
      assert.strictEqual(status.protocol.currentVersion, CURRENT_PROTOCOL_VERSION);
      assert.deepStrictEqual(status.protocol.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);

      db.close();
      cleanupTestFile(dbPath);
    });
  });

  describe('Negotiation helper', () => {
    it('[1] + [1] => 1', () => {
      const local: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1] };
      const remote: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1] };
      assert.strictEqual(commonProtocolVersions(local, remote), 1);
    });

    it('[1,2] + [1,2] => 2', () => {
      const local: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [1, 2] };
      const remote: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [1, 2] };
      assert.strictEqual(commonProtocolVersions(local, remote), 2);
    });

    it('[1,2] + [2] => 2', () => {
      const local: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [1, 2] };
      const remote: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [2] };
      assert.strictEqual(commonProtocolVersions(local, remote), 2);
    });

    it('[1,2] + [1] => 1', () => {
      const local: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [1, 2] };
      const remote: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1] };
      assert.strictEqual(commonProtocolVersions(local, remote), 1);
    });

    it('no overlap => ProtocolVersionMismatchError', () => {
      const local: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1] };
      const remote: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [2] };
      assert.throws(
        () => commonProtocolVersions(local, remote),
        (err: unknown) => err instanceof ProtocolVersionMismatchError
      );
    });

    it('error exposes local and remote versions', () => {
      const local: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1] };
      const remote: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [2] };
      try {
        commonProtocolVersions(local, remote);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof ProtocolVersionMismatchError);
        // @ts-ignore
        assert.deepStrictEqual(err.localVersions, [1]);
        // @ts-ignore
        assert.deepStrictEqual(err.remoteVersions, [2]);
      }
    });

    it('does not mutate inputs', () => {
      const local: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1, 2] };
      const remote: ProtocolCapabilities = { currentVersion: 2, supportedVersions: [2, 3] };
      const localBefore = { ...local, supportedVersions: [...local.supportedVersions] };
      const remoteBefore = { ...remote, supportedVersions: [...remote.supportedVersions] };
      assert.strictEqual(commonProtocolVersions(local, remote), 2);
      assert.deepStrictEqual(local, localBefore);
      assert.deepStrictEqual(remote, remoteBefore);
    });

    it('rejects invalid capability objects and version entries explicitly', () => {
      const valid: ProtocolCapabilities = { currentVersion: 1, supportedVersions: [1] };

      // Not an object or null
      assert.throws(() => validateProtocolCapabilities(null), /must be an object/i);
      assert.throws(() => validateProtocolCapabilities('v1'), /must be an object/i);
      assert.throws(() => commonProtocolVersions(valid, null as unknown as ProtocolCapabilities), /must be an object/i);

      // Invalid currentVersion
      assert.throws(() => validateProtocolCapabilities({ currentVersion: 0, supportedVersions: [1] }), /currentVersion/i);
      assert.throws(() => validateProtocolCapabilities({ currentVersion: 1.5, supportedVersions: [1] }), /currentVersion/i);
      assert.throws(() => validateProtocolCapabilities({ currentVersion: '1' as unknown as number, supportedVersions: [1] }), /currentVersion/i);

      // Empty or invalid supportedVersions
      assert.throws(() => validateProtocolCapabilities({ currentVersion: 1, supportedVersions: [] }), /supportedVersions/i);
      assert.throws(() => validateProtocolCapabilities({ currentVersion: 1, supportedVersions: [0] }), /supportedVersions/i);
      assert.throws(() => validateProtocolCapabilities({ currentVersion: 1, supportedVersions: [-1] }), /supportedVersions/i);
      assert.throws(() => validateProtocolCapabilities({ currentVersion: 1, supportedVersions: [1.2] }), /supportedVersions/i);

      // Does not silently filter out invalid entries in commonProtocolVersions
      assert.throws(
        () => commonProtocolVersions(valid, { currentVersion: 1, supportedVersions: [1, -2] as unknown as number[] }),
        /supportedVersions/i
      );
      assert.throws(
        () => commonProtocolVersions(valid, { currentVersion: 1, supportedVersions: [1, '2'] as unknown as number[] }),
        /supportedVersions/i
      );
    });
  });

  describe('Peer negotiation integration', () => {
    it('syncWithPeer successfully negotiates version 1', async () => {
      const dbPathLocal = getUniqueTestDbPath('proto-nego-local');
      const local = createNode(dbPathLocal, 'nego-local');

      const dbPathPeer = getUniqueTestDbPath('proto-nego-peer');
      const peer = createNode(dbPathPeer, 'nego-peer');

      peer.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'doc',
        entityId: 'doc-nego-1',
        payload: { title: 'nego' },
      });

      const http = await import('node:http');
      let statusCallCount = 0;
      const server = http.createServer((req, res) => {
        if (req.url === '/sync/status' && req.method === 'GET') {
          statusCallCount += 1;
          const status = peer.syncManager.getSyncStatus();
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(status));
          return;
        }
        if (req.url?.startsWith('/sync/operations') && req.method === 'GET') {
          const url = new URL(req.url, 'http://127.0.0.1');
          const nodeId = url.searchParams.get('nodeId')!;
          const afterSeq = Number(url.searchParams.get('afterSequence') ?? '0');
          const ops = peer.operationManager.getOperationsAfterSequence(nodeId, afterSeq);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ operations: ops }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as { port: number }).port);
        });
      });

      try {
        const result = await local.syncManager.syncWithPeer(`http://127.0.0.1:${port}`);
        assert.strictEqual(statusCallCount, 1);
        assert.strictEqual(result.pulled.summary.applied, 1);
        // Verify the record was applied locally
        const record = local.operationManager.getRecord('doc-nego-1', 'doc');
        assert.notStrictEqual(record, null);
        assert.deepStrictEqual(record!.data, { title: 'nego' });
      } finally {
        server.close();
        local.db.close();
        peer.db.close();
        cleanupTestFile(dbPathLocal);
        cleanupTestFile(dbPathPeer);
      }
    });

    it('incompatible peer causes ProtocolVersionMismatchError', async () => {
      const dbPathLocal = getUniqueTestDbPath('proto-fail-local');
      const local = createNode(dbPathLocal, 'fail-local');

      // Peer that advertises only version 2 (incompatible with local version 1)
      const http = await import('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/sync/status' && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            nodeId: 'incompatible-peer',
            sequences: {},
            protocol: {
              currentVersion: 2,
              supportedVersions: [2],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as { port: number }).port);
        });
      });

      try {
        await assert.rejects(
          () => local.syncManager.syncWithPeer(`http://127.0.0.1:${port}`),
          (err: unknown) => {
            assert.ok(err instanceof ProtocolVersionMismatchError);
            assert.deepStrictEqual((err as ProtocolVersionMismatchError).localVersions, [1]);
            assert.deepStrictEqual((err as ProtocolVersionMismatchError).remoteVersions, [2]);
            return true;
          }
        );
      } finally {
        server.close();
        local.db.close();
        cleanupTestFile(dbPathLocal);
      }
    });

    it('legacy peer without protocol capability successfully syncs falling back to v1', async () => {
      const dbPathLocal = getUniqueTestDbPath('proto-legacy-local');
      const local = createNode(dbPathLocal, 'legacy-local');

      const dbPathPeer = getUniqueTestDbPath('proto-legacy-peer');
      const peer = createNode(dbPathPeer, 'legacy-peer');

      peer.operationManager.createOperation({
        operationType: 'CREATE',
        entityType: 'doc',
        entityId: 'doc-legacy-1',
        payload: { text: 'legacy' },
      });

      const http = await import('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/sync/status' && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            nodeId: 'legacy-peer',
            sequences: peer.operationManager.getSequenceVector(),
          }));
          return;
        }
        if (req.url?.startsWith('/sync/operations') && req.method === 'GET') {
          const url = new URL(req.url, 'http://127.0.0.1');
          const nodeId = url.searchParams.get('nodeId')!;
          const afterSeq = Number(url.searchParams.get('afterSequence') ?? '0');
          const ops = peer.operationManager.getOperationsAfterSequence(nodeId, afterSeq);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ operations: ops }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as { port: number }).port);
        });
      });

      try {
        const result = await local.syncManager.syncWithPeer(`http://127.0.0.1:${port}`);
        assert.strictEqual(result.pulled.summary.applied, 1);
        const record = local.operationManager.getRecord('doc-legacy-1', 'doc');
        assert.notStrictEqual(record, null);
        assert.deepStrictEqual(record!.data, { text: 'legacy' });
      } finally {
        server.close();
        local.db.close();
        peer.db.close();
        cleanupTestFile(dbPathLocal);
        cleanupTestFile(dbPathPeer);
      }
    });

    it('malformed protocol capability rejects and does not silently fall back to v1', async () => {
      const dbPathLocal = getUniqueTestDbPath('proto-malformed-local');
      const local = createNode(dbPathLocal, 'malformed-local');

      const http = await import('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/sync/status' && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            nodeId: 'malformed-peer',
            sequences: {},
            protocol: 'not-an-object',
          }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as { port: number }).port);
        });
      });

      try {
        await assert.rejects(
          () => local.syncManager.syncWithPeer(`http://127.0.0.1:${port}`),
          /malformed protocol capabilities response/i
        );
      } finally {
        server.close();
        local.db.close();
        cleanupTestFile(dbPathLocal);
      }
    });
  });
});
