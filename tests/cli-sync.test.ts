import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { executeCommand, initMeshVault, resolveSyncPort } from '../src/index.js';
import { cleanupTestFile, getUniqueTestDbPath } from './test-utils.js';

async function captureOutput(action: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  try {
    await action();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function createApp(prefix: string) {
  const dbPath = getUniqueTestDbPath(prefix);
  return { app: initMeshVault(dbPath, 'node-cli'), dbPath };
}

function withEnvironment<T>(values: Record<string, string | undefined>, action: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('CLI synchronization commands', () => {
  it('uses the default database path and sync port without environment variables', () => {
    const app = withEnvironment(
      { MESHVAULT_DB_PATH: undefined, MESHVAULT_PORT: undefined, MESHVAULT_SYNC_PORT: undefined },
      () => initMeshVault(undefined, 'node-config-default')
    );
    try {
      assert.strictEqual(app.dbPath, path.resolve(process.cwd(), 'data', 'meshvault.db'));
      assert.strictEqual(withEnvironment({ MESHVAULT_PORT: undefined, MESHVAULT_SYNC_PORT: undefined }, resolveSyncPort), 3000);
    } finally {
      app.db.close();
    }
  });

  it('uses independent database paths and sync ports from environment variables', () => {
    for (const [dbPath, port] of [
      ['data/node-a.db', '3001'],
      ['data/node-b.db', '3002'],
    ] as const) {
      withEnvironment(
        { MESHVAULT_DB_PATH: dbPath, MESHVAULT_PORT: port },
        () => {
          const app = initMeshVault(undefined, `node-${port}`);
          try {
            assert.strictEqual(app.dbPath, dbPath);
            assert.strictEqual(resolveSyncPort(), Number(port));
          } finally {
            app.db.close();
            cleanupTestFile(path.resolve(process.cwd(), dbPath));
          }
        }
      );
    }
  });

  it('rejects an explicitly invalid sync port', () => {
    assert.throws(
      () => withEnvironment({ MESHVAULT_PORT: 'not-a-port' }, resolveSyncPort),
      /Invalid MESHVAULT_PORT: not-a-port/
    );
  });

  it('prints sync-status with the node ID and sequence vector', async () => {
    const { app, dbPath } = createApp('cli-sync-status');
    try {
      app.opManager.createOperation({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'cli-task',
        payload: { ready: true },
      });
      const output = await captureOutput(() => executeCommand(app, ['sync-status']));

      assert.match(output.stdout, /Node ID: node-cli/);
      assert.match(output.stdout, /node-cli: 1/);
      assert.strictEqual(output.stderr, '');
    } finally {
      app.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('delegates sync to SyncManager and prints the transfer summary', async () => {
    const { app, dbPath } = createApp('cli-sync-success');
    try {
      let requestedPeer = '';
      app.syncManager.syncWithPeer = async (peerUrl: string) => {
        requestedPeer = peerUrl;
        return {
          pulled: {
            results: [],
            summary: { applied: 2, duplicates: 1, rejected: 0 },
          },
          pushed: {
            results: [],
            summary: { applied: 3, duplicates: 0, rejected: 1 },
          },
        };
      };

      const output = await captureOutput(() =>
        executeCommand(app, ['sync', 'http://127.0.0.1:3002/'])
      );

      assert.strictEqual(requestedPeer, 'http://127.0.0.1:3002/');
      assert.match(output.stdout, /Synchronizing with peer: http:\/\/127\.0\.0\.1:3002\//);
      assert.match(output.stdout, /Operations pulled: 0 \(applied: 2, duplicates: 1, rejected: 0\)/);
      assert.match(output.stdout, /Operations pushed: 0 \(applied: 3, duplicates: 0, rejected: 1\)/);
      assert.strictEqual(output.stderr, '');
    } finally {
      app.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('reports invalid arguments and delegated sync failures without throwing', async () => {
    const { app, dbPath } = createApp('cli-sync-errors');
    try {
      const invalid = await captureOutput(() => executeCommand(app, ['sync', 'not-a-url']));
      assert.match(invalid.stderr, /Invalid peer URL/);

      const missing = await captureOutput(() => executeCommand(app, ['sync']));
      assert.match(missing.stderr, /Usage: sync <peer_url>/);

      app.syncManager.syncWithPeer = async () => {
        throw new Error('peer unavailable');
      };
      const failed = await captureOutput(() =>
        executeCommand(app, ['sync', 'http://127.0.0.1:3002'])
      );
      assert.match(failed.stderr, /Synchronization failed: peer unavailable/);
    } finally {
      app.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('preserves existing node and create commands', async () => {
    const { app, dbPath } = createApp('cli-sync-regression');
    try {
      const nodeOutput = await captureOutput(() => executeCommand(app, ['node-id']));
      assert.match(nodeOutput.stdout, /Node ID: node-cli/);

      const createOutput = await captureOutput(() =>
        executeCommand(app, ['create', 'task', 'cli-created', '{"ok":true}'])
      );
      assert.match(createOutput.stdout, /Node:     node-cli/);
      assert.ok(app.opManager.getRecord('cli-created', 'task'));
    } finally {
      app.db.close();
      cleanupTestFile(dbPath);
    }
  });

  it('can start and stop the local sync server used by the CLI app', async () => {
    const { app, dbPath } = createApp('cli-sync-server');
    try {
      const port = await app.syncServer.start(0, '127.0.0.1');
      assert.ok(port > 0);
      assert.strictEqual(app.syncServer.getPort(), port);
      await app.syncServer.stop();
      assert.strictEqual(app.syncServer.getPort(), null);
    } finally {
      await app.syncServer.stop();
      app.db.close();
      cleanupTestFile(dbPath);
    }
  });
});
