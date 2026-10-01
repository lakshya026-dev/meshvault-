import { randomUUID } from 'node:crypto';
import { DatabaseManager } from '../database/db.js';
import { NodeInfo } from '../operations/types.js';

export class NodeConfig {
  private nodeId: string;
  private createdAt: string;

  constructor(dbManager: DatabaseManager, preferredNodeId?: string) {
    const rawDb = dbManager.getRawDb();

    // Check and initialize node identity atomically within a transaction
    const info = dbManager.transaction(() => {
      const existing = (rawDb.prepare(
        'SELECT node_id, created_at FROM node_info LIMIT 1'
      ).get() as unknown) as { node_id: string; created_at: string } | undefined;

      if (existing) {
        return existing;
      }

      const nodeId = preferredNodeId?.trim() || process.env.NODE_ID?.trim() || `node-${randomUUID().slice(0, 8)}`;
      const createdAt = new Date().toISOString();

      rawDb.prepare(
        'INSERT INTO node_info (node_id, created_at) VALUES (?, ?)'
      ).run(nodeId, createdAt);

      return { node_id: nodeId, created_at: createdAt };
    });

    this.nodeId = info.node_id;
    this.createdAt = info.created_at;
  }

  public getNodeId(): string {
    return this.nodeId;
  }

  public getNodeInfo(): NodeInfo {
    return {
      nodeId: this.nodeId,
      createdAt: this.createdAt,
    };
  }
}
