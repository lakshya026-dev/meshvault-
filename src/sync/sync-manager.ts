import type { OperationManager } from '../operations/operation-manager.js';
import { CURRENT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type ProtocolCapabilities, commonProtocolVersions } from './protocol.js';
import { ProtocolVersionMismatchError } from '../errors.js';

import { serializeCanonical } from '../operations/canonical.js';
import { verifyOperationIntegrity } from '../operations/integrity.js';
import type { Operation, OperationType } from '../operations/types.js';
import { isSupportedSchemaVersion } from '../operations/types.js';
import { MeshVaultError, NetworkError } from '../errors.js';

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

export interface PeerSyncResult {
  pulled: ReceiveOperationsResult;
  pushed: ReceiveOperationsResult;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  attemptTimeoutMs?: number;
  jitter?: boolean;
}

export function calculateBackoffDelay(
  retryCount: number,
  options: Required<RetryOptions>
): number {
  if (retryCount <= 0) return 0;
  const baseDelay = options.initialDelayMs * Math.pow(options.backoffFactor, retryCount - 1);
  const cappedDelay = Math.min(baseDelay, options.maxDelayMs);
  if (options.jitter) {
    return Math.floor(cappedDelay * (0.8 + 0.4 * Math.random()));
  }
  return Math.floor(cappedDelay);
}

function isRetryableStatusCode(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof NetworkError) {
    if (error.statusCode !== undefined) {
      return isRetryableStatusCode(error.statusCode);
    }
    return true;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    const code = (error as { code?: string }).code;
    if (code && ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
      return true;
    }
    if (error instanceof TypeError) return true;
  }
  return false;
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
    schemaVersion: value.schemaVersion as number,
    inputIndex,
  };

  if (!isSupportedSchemaVersion(operation.schemaVersion)) {
    return resultFor(operation, 'rejected', 'malformed');
  }

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
    left.schemaVersion === right.schemaVersion &&
    left.checksum === right.checksum &&
    serializeCanonical(left.payload) === serializeCanonical(right.payload)
  );
}

export interface SyncStatusResponse {
  nodeId: string;
  sequences: Record<string, number>;
  protocol: ProtocolCapabilities;
}

export class SyncManager {
  private static readonly transferBatchSize = 1_000;
  private readonly retryOptions: Required<RetryOptions>;

  constructor(
    private readonly operationManager: OperationManager,
    private readonly localNodeId: string,
    retryOptions?: RetryOptions
  ) {
    this.retryOptions = {
      maxRetries: retryOptions?.maxRetries ?? 3,
      initialDelayMs: retryOptions?.initialDelayMs ?? 100,
      maxDelayMs: retryOptions?.maxDelayMs ?? 2000,
      backoffFactor: retryOptions?.backoffFactor ?? 2,
      attemptTimeoutMs: retryOptions?.attemptTimeoutMs ?? 3000,
      jitter: retryOptions?.jitter ?? true,
    };
  }

  public getSyncStatus(): SyncStatusResponse {
    return {
      nodeId: this.localNodeId,
      sequences: this.operationManager.getSequenceVector(),
      protocol: {
        currentVersion: CURRENT_PROTOCOL_VERSION,
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
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

  public async syncWithPeer(peerUrl: string): Promise<PeerSyncResult> {
    const baseUrl = peerUrl.endsWith('/') ? peerUrl.slice(0, -1) : peerUrl;
    const peerStatus = await this.fetchJson(`${baseUrl}/sync/status`);

    // Validate and negotiate protocol version
    const peerProtocol = this.parsePeerProtocol(peerStatus);
    const localCapabilities: ProtocolCapabilities = {
      currentVersion: CURRENT_PROTOCOL_VERSION,
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    };
    const negotiatedVersion = commonProtocolVersions(localCapabilities, peerProtocol);
    // negotiatedVersion is unused for now (only v1 is implemented); wire format is unchanged.

    const peerSequences = this.parsePeerSequences(peerStatus);
    const pulled: ReceiveOperationsResult = {
      results: [],
      summary: { applied: 0, duplicates: 0, rejected: 0 },
    };
    const localSequencesBeforePull = this.operationManager.getSequenceVector();

    for (const [originNodeId, peerSequence] of Object.entries(peerSequences)) {
      let afterSequence = localSequencesBeforePull[originNodeId] ?? 0;
      while (afterSequence < peerSequence) {
        const response = await this.fetchJson(
          `${baseUrl}/sync/operations?nodeId=${encodeURIComponent(originNodeId)}&afterSequence=${afterSequence}&limit=${SyncManager.transferBatchSize}`
        );
        const operations = this.parsePeerOperations(response);
        if (operations.length === 0) {
          throw new Error(
            `Peer returned no operations for ${originNodeId} after sequence ${afterSequence}.`
          );
        }

        for (const operation of operations) {
          if (
            operation === null ||
            typeof operation !== 'object' ||
            Array.isArray(operation) ||
            (operation as { nodeId?: unknown }).nodeId !== originNodeId ||
            typeof (operation as { sequenceNumber?: unknown }).sequenceNumber !== 'number' ||
            (operation as { sequenceNumber: number }).sequenceNumber <= afterSequence
          ) {
            throw new Error('Peer returned a malformed operation delta.');
          }
        }

        const received = this.receiveOperations(operations);
        pulled.results.push(...received.results);
        pulled.summary.applied += received.summary.applied;
        pulled.summary.duplicates += received.summary.duplicates;
        pulled.summary.rejected += received.summary.rejected;
        this.assertTransferAccepted(received, originNodeId);

        const nextSequence = Math.max(
          ...operations.map((operation) => (operation as { sequenceNumber: number }).sequenceNumber)
        );
        if (nextSequence <= afterSequence) {
          throw new Error(`Peer made no progress for origin ${originNodeId}.`);
        }
        afterSequence = nextSequence;
      }
    }

    const peerSequencesForPush = peerSequences;
    const pushed: ReceiveOperationsResult = {
      results: [],
      summary: { applied: 0, duplicates: 0, rejected: 0 },
    };
    const localSequences = this.operationManager.getSequenceVector();
    for (const [originNodeId, localSequence] of Object.entries(localSequences)) {
      let afterSequence = peerSequencesForPush[originNodeId] ?? 0;
      while (afterSequence < localSequence) {
        const operations = this.operationManager
          .getOperationsAfterSequence(originNodeId, afterSequence)
          .slice(0, SyncManager.transferBatchSize);
        if (operations.length === 0) {
          throw new Error(
            `Unable to read local operations for ${originNodeId} after sequence ${afterSequence}.`
          );
        }

        const response = await this.fetchJson(`${baseUrl}/sync/operations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operations }),
        });
        const received = this.parseReceiveResponse(response, operations);
        pushed.results.push(...received.results);
        pushed.summary.applied += received.summary.applied;
        pushed.summary.duplicates += received.summary.duplicates;
        pushed.summary.rejected += received.summary.rejected;
        this.assertTransferAccepted(received, originNodeId);

        const nextSequence = Math.max(...operations.map((operation) => operation.sequenceNumber));
        if (nextSequence <= afterSequence) {
          throw new Error(`Local transfer made no progress for origin ${originNodeId}.`);
        }
        afterSequence = nextSequence;
      }
    }

    return { pulled, pushed };
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    let retries = 0;

    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.retryOptions.attemptTimeoutMs
      );

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);

        const status = response.status;
        if (!response.ok) {
          const isRetryableStatus = isRetryableStatusCode(status);
          const err = new NetworkError(`Peer request failed with HTTP ${status}.`, status);
          if (isRetryableStatus && retries < this.retryOptions.maxRetries) {
            retries += 1;
            const delay = calculateBackoffDelay(retries, this.retryOptions);
            if (delay > 0) {
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
            continue;
          }
          throw err;
        }

        const text = await response.text();
        let body: unknown;
        try {
          body = text === '' ? null : JSON.parse(text);
        } catch {
          throw new MeshVaultError(`Peer returned invalid JSON (${status}).`);
        }
        return body;
      } catch (error) {
        clearTimeout(timeout);

        if (error instanceof MeshVaultError && !(error instanceof NetworkError)) {
          throw error;
        }

        if (error instanceof NetworkError && error.statusCode !== undefined) {
          if (!isRetryableStatusCode(error.statusCode)) {
            throw error;
          }
        }

        const retryable = isRetryableError(error);
        if (retryable && retries < this.retryOptions.maxRetries) {
          retries += 1;
          const delay = calculateBackoffDelay(retries, this.retryOptions);
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          continue;
        }

        if (error instanceof MeshVaultError) {
          throw error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new NetworkError(
            `Peer request timed out after ${this.retryOptions.attemptTimeoutMs} ms.`,
            undefined,
            error
          );
        }
        throw new NetworkError(
          error instanceof Error ? error.message : String(error),
          undefined,
          error
        );
      }
    }
  }


  private parsePeerSequences(value: unknown): Record<string, number> {
    if (!isRecord(value) || !isRecord(value.sequences)) {
      throw new Error('Peer returned a malformed status response.');
    }
    const sequences: Record<string, number> = {};
    for (const [nodeId, sequence] of Object.entries(value.sequences)) {
      if (
        nodeId.trim() === '' ||
        typeof sequence !== 'number' ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
      ) {
        throw new Error('Peer returned a malformed sequence vector.');
      }
      sequences[nodeId] = sequence;
    }
    return sequences;
  }

  private parsePeerProtocol(value: unknown): ProtocolCapabilities {
    if (!isRecord(value)) {
      throw new Error('Peer returned a malformed status response.');
    }
    const rawProtocol = value.protocol;
    // If missing — treat as legacy peer or fixture (backward-compat path)
    if (rawProtocol === undefined) {
      return {
        currentVersion: CURRENT_PROTOCOL_VERSION,
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      };
    }
    if (!isRecord(rawProtocol)) {
      throw new Error('Peer returned a malformed protocol capabilities response.');
    }
    const { currentVersion, supportedVersions } = rawProtocol;
    if (
      typeof currentVersion !== 'number' ||
      !Number.isSafeInteger(currentVersion) ||
      currentVersion < 1
    ) {
      throw new Error('Peer returned an invalid protocol currentVersion.');
    }
    if (
      !Array.isArray(supportedVersions) ||
      supportedVersions.length === 0 ||
      !supportedVersions.every(
        (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0
      )
    ) {
      throw new Error('Peer returned an invalid protocol supportedVersions.');
    }
    return {
      currentVersion,
      supportedVersions: [...supportedVersions],
    };
  }

  private parsePeerOperations(value: unknown): unknown[] {
    if (!isRecord(value) || !Array.isArray(value.operations)) {
      throw new Error('Peer returned a malformed operations response.');
    }
    return value.operations;
  }

  private parseReceiveResponse(
    value: unknown,
    expectedOperations: Operation[]
  ): ReceiveOperationsResult {
    if (!isRecord(value) || !Array.isArray(value.results) || !isRecord(value.summary)) {
      throw new Error('Peer returned a malformed synchronization response.');
    }
    if (value.results.length !== expectedOperations.length) {
      throw new Error('Peer returned an incomplete synchronization response.');
    }
    const summary = value.summary;
    const { applied, duplicates, rejected } = summary;
    if (
      typeof applied !== 'number' ||
      typeof duplicates !== 'number' ||
      typeof rejected !== 'number' ||
      !Number.isSafeInteger(applied) ||
      !Number.isSafeInteger(duplicates) ||
      !Number.isSafeInteger(rejected)
    ) {
      throw new Error('Peer returned a malformed synchronization summary.');
    }
    const results = value.results as unknown[];
    results.forEach((result, index) => {
      if (!isRecord(result)) {
        throw new Error('Peer returned a malformed synchronization result.');
      }
      const expected = expectedOperations[index];
      if (
        result.operationId !== expected.operationId ||
        result.nodeId !== expected.nodeId ||
        result.sequenceNumber !== expected.sequenceNumber ||
        !['applied', 'duplicate', 'rejected'].includes(result.outcome as string) ||
        (result.outcome === 'rejected' &&
          ![
            'malformed',
            'checksum_mismatch',
            'integrity_violation',
            'sequence_gap',
            'local_origin',
          ].includes(result.reason as string))
      ) {
        throw new Error('Peer returned a mismatched synchronization result.');
      }
    });
    const calculated = results.reduce<ReceiveSummary>(
      (counts, result) => {
        if ((result as { outcome: string }).outcome === 'applied') {
          counts.applied += 1;
        } else if ((result as { outcome: string }).outcome === 'duplicate') {
          counts.duplicates += 1;
        } else {
          counts.rejected += 1;
        }
        return counts;
      },
      { applied: 0, duplicates: 0, rejected: 0 }
    );
    if (
      calculated.applied !== applied ||
      calculated.duplicates !== duplicates ||
      calculated.rejected !== rejected
    ) {
      throw new Error('Peer returned an inconsistent synchronization summary.');
    }
    return {
      results: value.results as ReceiveResult[],
      summary: { applied, duplicates, rejected },
    };
  }

  private assertTransferAccepted(result: ReceiveOperationsResult, originNodeId: string): void {
    const rejected = result.results.find(
      (item) => item.outcome === 'rejected'
    );
    if (rejected) {
      throw new Error(
        `Synchronization rejected operation ${rejected.operationId} from ${originNodeId}: ${rejected.reason ?? 'unknown'}.`
      );
    }
  }
}