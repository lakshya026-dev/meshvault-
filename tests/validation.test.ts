import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { OperationValidator } from '../src/operations/validator.js';
import { InvalidOperationError } from '../src/errors.js';
import { Operation, OperationType, OperationStatus } from '../src/operations/types.js';

describe('OperationValidator', () => {
  const validOp: Operation = {
    operationId: 'op-valid-001',
    nodeId: 'node-A',
    sequenceNumber: 1,
    operationType: 'CREATE',
    entityType: 'task',
    entityId: 'task-001',
    payload: { title: 'Test Task' },
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    appliedAt: null,
    checksum: 'a'.repeat(64),
    errorMessage: null,
  };

  it('accepts a fully valid operation', () => {
    assert.doesNotThrow(() => {
      OperationValidator.validateOperation(validOp);
    });
  });

  it('rejects empty or whitespace operationId', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, operationId: '' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Operation ID')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, operationId: '   ' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Operation ID')
    );
  });

  it('rejects empty or whitespace nodeId', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, nodeId: '' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Node ID')
    );
  });

  it('rejects invalid sequence numbers', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, sequenceNumber: 0 }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Sequence number')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, sequenceNumber: -1 }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Sequence number')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, sequenceNumber: 1.5 }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Sequence number')
    );
  });

  it('rejects invalid operation types', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, operationType: 'PATCH' as unknown as OperationType }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Invalid operation type')
    );
  });

  it('rejects empty entityType or entityId', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, entityType: '' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Entity type')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, entityId: '' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Entity ID')
    );
  });

  it('rejects malformed payloads', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, payload: null as unknown as Record<string, unknown> }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Payload')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, payload: [1, 2, 3] as unknown as Record<string, unknown> }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Payload')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, payload: 'string-payload' as unknown as Record<string, unknown> }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('Payload')
    );
  });

  it('rejects invalid timestamps', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, createdAt: 'not-a-date' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('createdAt')
    );
  });

  it('rejects invalid status', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, status: 'UNKNOWN' as unknown as OperationStatus }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('status')
    );
  });

  it('rejects invalid checksum formats', () => {
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, checksum: 'too-short' }),
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('checksum')
    );
    assert.throws(
      () => OperationValidator.validateOperation({ ...validOp, checksum: 'g'.repeat(64) }), // invalid hex
      (err: unknown) => err instanceof InvalidOperationError && err.message.includes('checksum')
    );
  });

  it('validates create input correctly', () => {
    assert.doesNotThrow(() => {
      OperationValidator.validateCreateInput({
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-1',
        payload: { name: 'Valid' },
      });
    });

    assert.throws(() => {
      OperationValidator.validateCreateInput({
        operationType: 'CREATE',
        entityType: '',
        entityId: 'task-1',
        payload: {},
      });
    });
  });
});
