import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('NodeConfig Identity', () => {
  it('generates and persists a unique node ID when none exists', () => {
    const testDbPath = getUniqueTestDbPath('node_gen');
    const db = new DatabaseManager({ dbPath: testDbPath });
    const config = new NodeConfig(db);

    const nodeId = config.getNodeId();
    assert.ok(nodeId, 'Node ID should be generated');
    assert.ok(nodeId.startsWith('node-'), 'Default Node ID should have node- prefix');

    const info = config.getNodeInfo();
    assert.strictEqual(info.nodeId, nodeId);
    assert.ok(info.createdAt);

    db.close();
    cleanupTestFile(testDbPath);
  });

  it('allows specifying a preferred node ID initially', () => {
    const testDbPath = getUniqueTestDbPath('node_pref');
    const db = new DatabaseManager({ dbPath: testDbPath });
    const config = new NodeConfig(db, 'node-alpha');

    assert.strictEqual(config.getNodeId(), 'node-alpha');
    db.close();
    cleanupTestFile(testDbPath);
  });

  it('persists node identity across application restart', () => {
    const testDbPath = getUniqueTestDbPath('node_restart');

    // First run: initialize with node-A
    const db1 = new DatabaseManager({ dbPath: testDbPath });
    const config1 = new NodeConfig(db1, 'node-A');
    const firstId = config1.getNodeId();
    const firstCreatedAt = config1.getNodeInfo().createdAt;
    assert.strictEqual(firstId, 'node-A');
    db1.close();

    // Restart: reopen database and instantiate NodeConfig without preferred ID
    const db2 = new DatabaseManager({ dbPath: testDbPath });
    const config2 = new NodeConfig(db2, 'node-B'); // Even if preferred is passed, existing must be kept
    const secondId = config2.getNodeId();
    const secondCreatedAt = config2.getNodeInfo().createdAt;

    assert.strictEqual(secondId, 'node-A', 'Node ID must remain identical after restart');
    assert.strictEqual(secondCreatedAt, firstCreatedAt, 'Node created_at must remain identical');
    db2.close();
    cleanupTestFile(testDbPath);
  });
});
