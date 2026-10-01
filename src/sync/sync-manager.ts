import type { OperationManager } from '../operations/operation-manager.js';
import { serializeCanonical } from '../operations/canonical.js';
import { verifyOperationIntegrity } from '../operations/integrity.js';
import type { Operation, OperationType } from '../operations/types.js';

export type ReceiveOutcome = 'applied' | 'duplicate' | 'rejected';
export type RejectionReason =
  | 'malformed'
  | 'checksum_mismatch'
  | 'integrity_violation'
  | 'sequence_gap'
  | 'local_origin';

export interface ReceiveResult {
  operationId: string;
  nodeId: string;
  sequenceNumber: number;
  outcome: ReceiveOutcome;
  reason?: RejectionReason;
}

export interface ReceiveSummary {
  applied: number;
  duplicates: number;
  rejected: number;
}

export interface ReceiveOperationsResult {
  results: ReceiveResult[];
  summary: ReceiveSummary;
}

interface ValidRemoteOperation extends Operation<Record<string, unknown>> {
  inputIndex: number;
}

function resultFor(
  operation: Partial<Pick<Operation, 'operationId' | 'nodeId' | 'sequenceNumber'>>,
  outcome: ReceiveOutcome,
  reason?: RejectionReason
): ReceiveResult {
  const result: ReceiveResult = {
    operationId: typeof operation.operationId === 'string' ? operation.operationId : '',
    nodeId: typeof operation.nodeId === 'string' ? operation.nodeId : '',
    sequenceNumber:
      typeof operation.sequenceNumber === 'number' ? operation.sequenceNumber : 0,
    outcome,
  };
  if (reason) {
    result.reason = reason;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateIncoming(value: unknown, inputIndex: number): ValidRemoteOperation | ReceiveResult {
  if (!isRecord(value)) {
    return resultFor({}, 'rejected', 'malformed');
  }

  const operationType = value.operationType;
  const sequenceNumber = value.sequenceNumber;
  const requiredStrings = ['operationId', 'nodeId', 'entityType', 'entityId', 'createdAt', 'checksum'];
  if (
    requiredStrings.some((field) => typeof value[field] !== 'string') ||
    ['operationId', 'nodeId', 'entityType', 'entityId', 'createdAt'].some(
      (field) => (value[field] as string).trim() === ''
    ) ||
    isNaN(Date.parse(value.createdAt as string)) ||
    !Number.isSafeInteger(sequenceNumber) ||
    (sequenceNumber as number) < 1 ||
    !['CREATE', 'UPDATE', 'DELETE'].includes(operationType as string) ||
    !isRecord(value.payload)
  ) {
    return resultFor(
      {
        operationId: value.operationId as string,
        nodeId: value.nodeId as string,
        sequenceNumber: sequenceNumber as number,
      },
      'rejected',
      'malformed'
    );
  }

  const operation: ValidRemoteOperation = {
    operationId: value.operationId as string,
    nodeId: value.nodeId as string,
    sequenceNumber: sequenceNumber as number,
    operationType: operationType as OperationType,
    entityType: value.entityType as string,
    entityId: value.entityId as string,
    payload: value.payload as Record<string, unknown>,
    status: 'PENDING',
    createdAt: value.createdAt as string,
    appliedAt: null,
    checksum: value.checksum as string,
    errorMessage: null,
    inputIndex,
  };

  if (!/^[0-9a-f]{64}$/i.test(operation.checksum)) {
    return resultFor(operation, 'rejected', 'malformed');
  }

  if (!verifyOperationIntegrity(operation)) {
    return resultFor(operation, 'rejected', 'checksum_mismatch');
  }

  return operation;
}

function sameContent(left: Operation, right: Operation): boolean {
  return (
    left.operationId === right.operationId &&
    left.nodeId === right.nodeId &&
    left.sequenceNumber === right.sequenceNumber &&
    left.operationType === right.operationType &&
    left.entityType === right.entityType &&
    left.entityId === right.entityId &&
    left.createdAt === right.createdAt &&
    left.checksum === right.checksum &&
    serializeCanonical(left.payload) === serializeCanonical(right.payload)
  );
}

export class SyncManager {
  constructor(
    private readonly operationManager: OperationManager,
    private readonly localNodeId: string
  ) {}

  public getSyncStatus(): { nodeId: string; sequences: Record<string, number> } {
    return {
      nodeId: this.localNodeId,
      sequences: this.operationManager.getSequenceVector(),
    };
  }

  public receiveOperations(operations: unknown[]): ReceiveOperationsResult {
    const results: Array<ReceiveResult | undefined> = new Array(operations.length);
    const validByOrigin = new Map<string, ValidRemoteOperation[]>();

    operations.forEach((value, inputIndex) => {
      const validated = validateIncoming(value, inputIndex);
      if ('outcome' in validated) {
        results[inputIndex] = validated;
        return;
      }
      const originOperations = validByOrigin.get(validated.nodeId) ?? [];
      originOperations.push(validated);
      validByOrigin.set(validated.nodeId, originOperations);
    });

    const sequenceVector = this.operationManager.getSequenceVector();
    for (const [nodeId, originOperations] of validByOrigin) {
      originOperations.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
      let highestKnown = sequenceVector[nodeId] ?? 0;
      let blockedByGap = false;

      for (const operation of originOperations) {
        const existingById = this.operationManager.getOperation(operation.operationId);
        if (existingById) {
          if (sameContent(existingById, operation)) {
            results[operation.inputIndex] = resultFor(operation, 'duplicate');
          } else {
            results[operation.inputIndex] = resultFor(
              operation,
              'rejected',
              'integrity_violation'
            );
          }
          continue;
        }

        const existingBySequence = this.operationManager.getOperationBySequence(
          operation.nodeId,
          operation.sequenceNumber
        );
        if (existingBySequence && existingBySequence.operationId !== operation.operationId) {
          results[operation.inputIndex] = resultFor(
            operation,
            'rejected',
            'integrity_violation'
          );
          continue;
        }

        if (operation.nodeId === this.localNodeId) {
          results[operation.inputIndex] = resultFor(operation, 'rejected', 'local_origin');
          continue;
        }

        if (operation.sequenceNumber > highestKnown + 1 || blockedByGap) {
          results[operation.inputIndex] = resultFor(operation, 'rejected', 'sequence_gap');
          blockedByGap = true;
          continue;
        }

        try {
          this.operationManager.applyOperation(operation);
          results[operation.inputIndex] = resultFor(operation, 'applied');
          highestKnown = Math.max(highestKnown, operation.sequenceNumber);
        } catch (error) {
          results[operation.inputIndex] = resultFor(operation, 'rejected', 'integrity_violation');
        }
      }
    }

    const finalizedResults = results as ReceiveResult[];
    const summary = finalizedResults.reduce<ReceiveSummary>(
      (counts, result) => {
        if (result.outcome === 'applied') {
          counts.applied += 1;
        } else if (result.outcome === 'duplicate') {
          counts.duplicates += 1;
        } else {
          counts.rejected += 1;
        }
        return counts;
      },
      { applied: 0, duplicates: 0, rejected: 0 }
    );

    return { results: finalizedResults, summary };
  }
}
