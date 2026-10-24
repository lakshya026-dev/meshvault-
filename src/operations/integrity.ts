import { createHash } from 'node:crypto';
import { serializeCanonical } from './canonical.js';
import { Operation, isSupportedSchemaVersion } from './types.js';
import { UnsupportedSchemaVersionError } from '../errors.js';

export interface OperationChecksumInput {
  operationId: string;
  nodeId: string;
  sequenceNumber: number;
  operationType: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
  /**
   * Operation schema version.
   *
   * - 1: Uses the original 8-field canonical representation.
   * - 2: Appends schemaVersion as a 9th field, making version tampering
   *   detectable.
   * - 3: Appends schemaVersion as 9th field and canonical causalDependencies
   *   as 10th field.
   */
  schemaVersion: number;
  causalDependencies?: string[];
}

/**
 * V1 (legacy) checksum formula — 8 fields joined by ':'.
 *
 *   SHA-256( operationId:nodeId:sequenceNumber:operationType:entityType:entityId:canonicalPayload:createdAt )
 *
 * This formula is frozen. Historical operations hashed with it must always
 * verify successfully; it must never be changed.
 */
function computeV1Checksum(
  operationId: string,
  nodeId: string,
  sequenceNumber: number,
  operationType: string,
  entityType: string,
  entityId: string,
  canonicalPayload: string,
  createdAt: string
): string {
  const content = [
    operationId,
    nodeId,
    String(sequenceNumber),
    operationType,
    entityType,
    entityId,
    canonicalPayload,
    createdAt,
  ].join(':');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * V2 (versioned) checksum formula — 9 fields joined by ':'.
 *
 *   SHA-256( operationId:nodeId:sequenceNumber:operationType:entityType:entityId:canonicalPayload:createdAt:schemaVersion )
 *
 * schemaVersion is appended as the 9th field so that altering it invalidates
 * the checksum. The first 8 fields are identical to v1 to aid readability,
 * but the presence of the 9th field makes the two checksums always distinct.
 */
function computeV2Checksum(
  operationId: string,
  nodeId: string,
  sequenceNumber: number,
  operationType: string,
  entityType: string,
  entityId: string,
  canonicalPayload: string,
  createdAt: string,
  schemaVersion: number
): string {
  const content = [
    operationId,
    nodeId,
    String(sequenceNumber),
    operationType,
    entityType,
    entityId,
    canonicalPayload,
    createdAt,
    String(schemaVersion),
  ].join(':');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * V3 (causal) checksum formula — 10 fields joined by ':'.
 *
 *   SHA-256( operationId:nodeId:sequenceNumber:operationType:entityType:entityId:canonicalPayload:createdAt:schemaVersion:canonicalDependencies )
 *
 * Appends canonicalDependencies as the 10th field so that any alteration to
 * causal dependencies invalidates the checksum.
 */
function computeV3Checksum(
  operationId: string,
  nodeId: string,
  sequenceNumber: number,
  operationType: string,
  entityType: string,
  entityId: string,
  canonicalPayload: string,
  createdAt: string,
  schemaVersion: number,
  canonicalDependencies: string
): string {
  const content = [
    operationId,
    nodeId,
    String(sequenceNumber),
    operationType,
    entityType,
    entityId,
    canonicalPayload,
    createdAt,
    String(schemaVersion),
    canonicalDependencies,
  ].join(':');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Computes a deterministic SHA-256 integrity checksum for an operation.
 *
 * The explicitly declared schemaVersion selects exactly one supported formula.
 */
export function computeOperationChecksum(input: OperationChecksumInput): string {
  const canonicalPayload = serializeCanonical(input.payload);

  if (!isSupportedSchemaVersion(input.schemaVersion)) {
    throw new UnsupportedSchemaVersionError(input.schemaVersion);
  }
  const version = input.schemaVersion;

  if (version === 3) {
    const canonicalDependencies = serializeCanonical(input.causalDependencies ?? []);
    return computeV3Checksum(
      input.operationId,
      input.nodeId,
      input.sequenceNumber,
      input.operationType,
      input.entityType,
      input.entityId,
      canonicalPayload,
      input.createdAt,
      version,
      canonicalDependencies
    );
  }

  if (version === 2) {
    return computeV2Checksum(
      input.operationId,
      input.nodeId,
      input.sequenceNumber,
      input.operationType,
      input.entityType,
      input.entityId,
      canonicalPayload,
      input.createdAt,
      version
    );
  }

  // version === 1 — use the frozen v1 formula
  return computeV1Checksum(
    input.operationId,
    input.nodeId,
    input.sequenceNumber,
    input.operationType,
    input.entityType,
    input.entityId,
    canonicalPayload,
    input.createdAt
  );
}

/**
 * Verifies that the operation's stored checksum matches its canonical content.
 *
 * The correct formula is chosen only from the explicitly declared supported
 * schemaVersion. Missing and unsupported versions fail verification.
 */
export function verifyOperationIntegrity(operation: Operation): boolean {
  if (!operation.checksum || typeof operation.checksum !== 'string') {
    return false;
  }

  if (!isSupportedSchemaVersion(operation.schemaVersion)) {
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
    schemaVersion: operation.schemaVersion,
    causalDependencies: operation.causalDependencies,
  });

  return operation.checksum.toLowerCase() === expectedChecksum.toLowerCase();
}
