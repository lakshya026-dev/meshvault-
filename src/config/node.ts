import { randomUUID } from 'node:crypto';
import { DatabaseManager } from '../database/db.js';
import { NodeInfo } from '../operations/types.js';

export class NodeConfig {
  private nodeId: string;
  private createdAt: string;

  constructor(dbManager: DatabaseManager, preferredNodeId?: string) {
    const rawDb = dbManager.getRawDb();

    // Check if node identity already exists in node_info table
    const existing = (rawDb.prepare(
      'SELECT node_id, created_at FROM node_info LIMIT 1'
    ).get() as unknown) as { node_id: string; created_at: string } | undefined;

    if (existing) {
      this.nodeId = existing.node_id;
      this.createdAt = existing.created_at;
    } else {
      this.nodeId = preferredNodeId?.trim() || process.env.NODE_ID?.trim() || `node-${randomUUID().slice(0, 8)}`;
      this.createdAt = new Date().toISOString();

      rawDb.prepare(
        'INSERT INTO node_info (node_id, created_at) VALUES (?, ?)'
      ).run(this.nodeId, this.createdAt);
    }
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
