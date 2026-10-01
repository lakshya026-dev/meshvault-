import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { canonicalize, serializeCanonical } from '../src/operations/canonical.js';
import { computeOperationChecksum, verifyOperationIntegrity } from '../src/operations/integrity.js';
import { Operation } from '../src/operations/types.js';

describe('Operation Integrity & Canonicalization', () => {
  it('canonicalizes JSON object keys in deterministic lexicographical order', () => {
    const obj1 = { title: 'Task', priority: 1, active: true };
    const obj2 = { priority: 1, active: true, title: 'Task' };
    const obj3 = { active: true, title: 'Task', priority: 1 };

    assert.strictEqual(serializeCanonical(obj1), serializeCanonical(obj2));
    assert.strictEqual(serializeCanonical(obj2), serializeCanonical(obj3));
    assert.strictEqual(serializeCanonical(obj1), '{"active":true,"priority":1,"title":"Task"}');
  });

  it('handles deeply nested objects and arrays deterministically', () => {
    const nested1 = {
      meta: { tags: ['sync', 'offline'], author: { z: 1, a: 2 } },
      count: 42,
    };
    const nested2 = {
      count: 42,
      meta: { author: { a: 2, z: 1 }, tags: ['sync', 'offline'] },
    };

    assert.strictEqual(serializeCanonical(nested1), serializeCanonical(nested2));
  });

  it('produces identical SHA-256 checksums for equivalent logical payloads', () => {
    const checksum1 = computeOperationChecksum({
      operationId: 'op-001',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { title: 'Learn Systems', level: 'advanced' },
      createdAt: '2026-10-01T12:00:00.000Z',
    });

    const checksum2 = computeOperationChecksum({
      operationId: 'op-001',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-001',
      payload: { level: 'advanced', title: 'Learn Systems' },
      createdAt: '2026-10-01T12:00:00.000Z',
    });

    assert.strictEqual(checksum1, checksum2);
    assert.strictEqual(checksum1.length, 64);
    assert.match(checksum1, /^[0-9a-f]{64}$/);
  });

  it('verifies integrity of intact operation', () => {
    const payload = { title: 'Verified Task' };
    const createdAt = '2026-10-01T12:00:00.000Z';
    const checksum = computeOperationChecksum({
      operationId: 'op-verify-1',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-v1',
      payload,
      createdAt,
    });

    const operation: Operation = {
      operationId: 'op-verify-1',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-v1',
      payload,
      status: 'PENDING',
      createdAt,
      appliedAt: null,
      checksum,
    };

    assert.strictEqual(verifyOperationIntegrity(operation), true);
  });

  it('detects tampering in operation payload', () => {
    const createdAt = '2026-10-01T12:00:00.000Z';
    const checksum = computeOperationChecksum({
      operationId: 'op-tamper-1',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-t1',
      payload: { amount: 100 },
      createdAt,
    });

    // Tampered payload (changed amount from 100 to 9999)
    const tamperedOp: Operation = {
      operationId: 'op-tamper-1',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-t1',
      payload: { amount: 9999 },
      status: 'PENDING',
      createdAt,
      appliedAt: null,
      checksum,
    };

    assert.strictEqual(verifyOperationIntegrity(tamperedOp), false);
  });

  it('detects tampering in entityId, sequenceNumber, or timestamps', () => {
    const createdAt = '2026-10-01T12:00:00.000Z';
    const baseInput = {
      operationId: 'op-tamper-2',
      nodeId: 'node-A',
      sequenceNumber: 1,
      operationType: 'CREATE' as const,
      entityType: 'task',
      entityId: 'task-t2',
      payload: { ok: true },
      createdAt,
    };
    const checksum = computeOperationChecksum(baseInput);

    const baseOp: Operation = {
      ...baseInput,
      status: 'PENDING',
      appliedAt: null,
      checksum,
    };

    // Tamper entityId
    assert.strictEqual(verifyOperationIntegrity({ ...baseOp, entityId: 'task-tampered' }), false);

    // Tamper sequenceNumber
    assert.strictEqual(verifyOperationIntegrity({ ...baseOp, sequenceNumber: 2 }), false);

    // Tamper nodeId
    assert.strictEqual(verifyOperationIntegrity({ ...baseOp, nodeId: 'node-B' }), false);

    // Tamper createdAt
    assert.strictEqual(verifyOperationIntegrity({ ...baseOp, createdAt: '2026-10-02T12:00:00.000Z' }), false);
  });
});
