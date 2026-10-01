import { createHash } from 'node:crypto';
import { serializeCanonical } from './canonical.js';
import { Operation } from './types.js';

export interface OperationChecksumInput {
  operationId: string;
  nodeId: string;
  sequenceNumber: number;
  operationType: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
}

/**
 * Computes deterministic SHA-256 checksum across canonical operation content.
 */
export function computeOperationChecksum(input: OperationChecksumInput): string {
  const canonicalPayload = serializeCanonical(input.payload);
  const content = [
    input.operationId,
    input.nodeId,
    String(input.sequenceNumber),
    input.operationType,
    input.entityType,
    input.entityId,
    canonicalPayload,
    input.createdAt,
  ].join(':');

  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Verifies that the operation's checksum matches its canonical content.
 */
export function verifyOperationIntegrity(operation: Operation): boolean {
  if (!operation.checksum || typeof operation.checksum !== 'string') {
    return false;
  }

  const expectedChecksum = computeOperationChecksum({
    operationId: operation.operationId,
    nodeId: operation.nodeId,
    sequenceNumber: operation.sequenceNumber,
    operationType: operation.operationType,
    entityType: operation.entityType,
    entityId: operation.entityId,
    payload: operation.payload,
    createdAt: operation.createdAt,
  });

  return operation.checksum.toLowerCase() === expectedChecksum.toLowerCase();
}
