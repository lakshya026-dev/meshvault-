import { InvalidOperationError } from '../errors.js';
import { CreateOperationInput, Operation, OperationType, OperationStatus } from './types.js';

const VALID_OPERATION_TYPES: ReadonlySet<OperationType> = new Set(['CREATE', 'UPDATE', 'DELETE']);
const VALID_STATUSES: ReadonlySet<OperationStatus> = new Set(['PENDING', 'APPLIED', 'FAILED']);
const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

export class OperationValidator {
  /**
   * Validates input parameters for creating a new operation.
   */
  public static validateCreateInput(input: CreateOperationInput): void {
    if (!input || typeof input !== 'object') {
      throw new InvalidOperationError('Operation input must be a valid object.');
    }

    if (!input.operationType || !VALID_OPERATION_TYPES.has(input.operationType)) {
      throw new InvalidOperationError(
        `Invalid operation type: '${input.operationType}'. Expected CREATE, UPDATE, or DELETE.`
      );
    }

    if (!input.entityType || typeof input.entityType !== 'string' || input.entityType.trim() === '') {
      throw new InvalidOperationError('Entity type must be a non-empty string.');
    }

    if (!input.entityId || typeof input.entityId !== 'string' || input.entityId.trim() === '') {
      throw new InvalidOperationError('Entity ID must be a non-empty string.');
    }

    this.validatePayload(input.payload);

    if (input.operationId !== undefined) {
      if (typeof input.operationId !== 'string' || input.operationId.trim() === '') {
        throw new InvalidOperationError('Explicit operation ID must be a non-empty string.');
      }
    }
  }

  /**
   * Validates a complete Operation object structure.
   */
  public static validateOperation(operation: Operation): void {
    if (!operation || typeof operation !== 'object') {
      throw new InvalidOperationError('Operation must be a valid object.');
    }

    if (!operation.operationId || typeof operation.operationId !== 'string' || operation.operationId.trim() === '') {
      throw new InvalidOperationError('Operation ID must be a non-empty string.');
    }

    if (!operation.nodeId || typeof operation.nodeId !== 'string' || operation.nodeId.trim() === '') {
      throw new InvalidOperationError('Node ID must be a non-empty string.');
    }

    if (
      typeof operation.sequenceNumber !== 'number' ||
      !Number.isInteger(operation.sequenceNumber) ||
      operation.sequenceNumber < 1
    ) {
      throw new InvalidOperationError(
        `Invalid sequence number: ${operation.sequenceNumber}. Sequence number must be an integer >= 1.`
      );
    }

    if (!operation.operationType || !VALID_OPERATION_TYPES.has(operation.operationType)) {
      throw new InvalidOperationError(
        `Invalid operation type: '${operation.operationType}'. Expected CREATE, UPDATE, or DELETE.`
      );
    }

    if (!operation.entityType || typeof operation.entityType !== 'string' || operation.entityType.trim() === '') {
      throw new InvalidOperationError('Entity type must be a non-empty string.');
    }

    if (!operation.entityId || typeof operation.entityId !== 'string' || operation.entityId.trim() === '') {
      throw new InvalidOperationError('Entity ID must be a non-empty string.');
    }

    this.validatePayload(operation.payload);

    if (!operation.status || !VALID_STATUSES.has(operation.status)) {
      throw new InvalidOperationError(
        `Invalid operation status: '${operation.status}'. Expected PENDING, APPLIED, or FAILED.`
      );
    }

    this.validateTimestamp('createdAt', operation.createdAt);

    if (operation.appliedAt !== null && operation.appliedAt !== undefined) {
      this.validateTimestamp('appliedAt', operation.appliedAt);
    }

    if (!operation.checksum || typeof operation.checksum !== 'string' || !HEX_64_REGEX.test(operation.checksum)) {
      throw new InvalidOperationError('Operation checksum must be a 64-character hex SHA-256 string.');
    }
  }

  private static validatePayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new InvalidOperationError('Payload must be a valid JSON object.');
    }
  }

  private static validateTimestamp(fieldName: string, value: string): void {
    if (typeof value !== 'string' || value.trim() === '' || isNaN(Date.parse(value))) {
      throw new InvalidOperationError(`Invalid timestamp for '${fieldName}': '${value}'.`);
    }
  }
}
