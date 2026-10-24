import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  computeOperationChecksum,
  verifyOperationIntegrity,
} from '../src/operations/integrity.js';
import { OperationValidator } from '../src/operations/validator.js';
import { Operation, CreateOperationInput } from '../src/operations/types.js';
import { InvalidOperationError } from '../src/errors.js';

describe('Phase 6.1 — Schema v3 Integrity & Causal Dependency Validation', () => {
  const goldenBase = {
    operationId: 'op-golden-001',
    nodeId: 'node-golden-node',
    sequenceNumber: 1,
    operationType: 'CREATE' as const,
    entityType: 'task',
    entityId: 'task-golden-1',
    payload: { title: 'Golden Task', priority: 1 },
    createdAt: '2026-10-20T12:00:00.000Z',
  };

  const expectedV1 = '4f9d8b86970ebe6094ea7a4609f71f03b2fce7c7859b0ddb6407bdf6469bf326';
  const expectedV2 = 'b0bf712d5858c33372647c69ca4888b49369f87566a6104145a096332677095f';
  const expectedV3Empty = '2625608f230f4fbd7d06e88c2a8c43182f4db4f14985c51db0c860fe2bd91f08';
  const expectedV3Deps = '59f310b3976d1245ca9b7223e36bfc4fbab2197c9de4dac51c338f16f84f1910';

  describe('Golden Vectors (Frozen v1, v2, and v3)', () => {
    it('produces bit-for-bit identical v1 checksum matching frozen golden vector', () => {
      const checksum = computeOperationChecksum({
        ...goldenBase,
        schemaVersion: 1,
      });
      assert.strictEqual(checksum, expectedV1);
    });

    it('produces bit-for-bit identical v2 checksum matching frozen golden vector', () => {
      const checksum = computeOperationChecksum({
        ...goldenBase,
        schemaVersion: 2,
      });
      assert.strictEqual(checksum, expectedV2);
    });

    it('produces bit-for-bit identical v3 checksum with empty causal dependencies', () => {
      const checksum = computeOperationChecksum({
        ...goldenBase,
        schemaVersion: 3,
        causalDependencies: [],
      });
      assert.strictEqual(checksum, expectedV3Empty);
    });

    it('produces bit-for-bit identical v3 checksum with populated causal dependencies', () => {
      const checksum = computeOperationChecksum({
        ...goldenBase,
        schemaVersion: 3,
        causalDependencies: ['op-dep-001', 'op-dep-002'],
      });
      assert.strictEqual(checksum, expectedV3Deps);
    });
  });

  describe('Schema v3 Checksum Generation & Tamper Detection', () => {
    const validV3Op: Operation = {
      ...goldenBase,
      status: 'PENDING',
      appliedAt: null,
      schemaVersion: 3,
      causalDependencies: ['op-dep-001', 'op-dep-002'],
      checksum: expectedV3Deps,
    };

    it('verifies intact schema v3 operation', () => {
      assert.strictEqual(verifyOperationIntegrity(validV3Op), true);
    });

    it('detects tampering when adding a causal dependency', () => {
      const tampered: Operation = {
        ...validV3Op,
        causalDependencies: ['op-dep-001', 'op-dep-002', 'op-dep-003'],
      };
      assert.strictEqual(verifyOperationIntegrity(tampered), false);
    });

    it('detects tampering when removing a causal dependency', () => {
      const tampered: Operation = {
        ...validV3Op,
        causalDependencies: ['op-dep-001'],
      };
      assert.strictEqual(verifyOperationIntegrity(tampered), false);
    });

    it('detects tampering when clearing causal dependencies to empty array', () => {
      const tampered: Operation = {
        ...validV3Op,
        causalDependencies: [],
      };
      assert.strictEqual(verifyOperationIntegrity(tampered), false);
    });

    it('detects tampering when reordering causal dependencies', () => {
      const tampered: Operation = {
        ...validV3Op,
        causalDependencies: ['op-dep-002', 'op-dep-001'],
      };
      assert.strictEqual(verifyOperationIntegrity(tampered), false);
    });

    it('detects tampering when modifying a single dependency ID', () => {
      const tampered: Operation = {
        ...validV3Op,
        causalDependencies: ['op-dep-001', 'op-dep-999'],
      };
      assert.strictEqual(verifyOperationIntegrity(tampered), false);
    });

    it('detects tampering when changing schemaVersion between v2 and v3', () => {
      assert.strictEqual(
        verifyOperationIntegrity({ ...validV3Op, schemaVersion: 2 }),
        false
      );
      const validV2Op: Operation = {
        ...goldenBase,
        status: 'PENDING',
        appliedAt: null,
        schemaVersion: 2,
        checksum: expectedV2,
      };
      assert.strictEqual(verifyOperationIntegrity(validV2Op), true);
      assert.strictEqual(
        verifyOperationIntegrity({ ...validV2Op, schemaVersion: 3, causalDependencies: [] }),
        false
      );
    });
  });

  describe('Causal Dependency Validation Rules', () => {
    it('schema v1 and v2 reject non-empty causal dependencies', () => {
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-1'], 1),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Schema version 1 operations must not specify causal dependencies.')
      );

      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-1'], 2),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Schema version 2 operations must not specify causal dependencies.')
      );
    });

    it('schema v1 and v2 accept undefined, null, or empty array', () => {
      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies(undefined, 1));
      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies(null, 1));
      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies([], 1));

      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies(undefined, 2));
      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies(null, 2));
      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies([], 2));
    });

    it('schema v3 requires causalDependencies to be an array', () => {
      const invalidTypes = [undefined, null, 'op-1', 123, { op: '1' }, true];
      for (const val of invalidTypes) {
        assert.throws(
          () => OperationValidator.validateCausalDependencies(val, 3),
          (err: Error) =>
            err instanceof InvalidOperationError &&
            err.message.includes("Schema version 3 operations require 'causalDependencies' to be an array.")
        );
      }
    });

    it('schema v3 accepts empty array when there are no known causal predecessors', () => {
      assert.doesNotThrow(() => OperationValidator.validateCausalDependencies([], 3));
    });

    it('schema v3 rejects empty or whitespace-only dependency strings', () => {
      assert.throws(
        () => OperationValidator.validateCausalDependencies([''], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must contain non-empty strings.')
      );
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['   '], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must contain non-empty strings.')
      );
      assert.throws(
        () => OperationValidator.validateCausalDependencies([123 as unknown as string], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must contain non-empty strings.')
      );
    });

    it('schema v3 rejects untrimmed dependency strings', () => {
      assert.throws(
        () => OperationValidator.validateCausalDependencies([' op-1'], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must not contain untrimmed whitespace.')
      );
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-1 '], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must not contain untrimmed whitespace.')
      );
    });

    it('schema v3 rejects self-dependencies', () => {
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-self'], 3, 'op-self'),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes("Operation cannot depend on itself: 'op-self'.")
      );
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-a', 'op-self'], 3, 'op-self'),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes("Operation cannot depend on itself: 'op-self'.")
      );
    });

    it('schema v3 rejects duplicate dependencies', () => {
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-1', 'op-1'], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes("Duplicate causal dependency: 'op-1'.")
      );
    });

    it('schema v3 rejects unsorted dependencies', () => {
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-2', 'op-1'], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must be strictly lexicographically sorted.')
      );
      assert.throws(
        () => OperationValidator.validateCausalDependencies(['op-a', 'op-c', 'op-b'], 3),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes('Causal dependencies must be strictly lexicographically sorted.')
      );
    });

    it('schema v3 accepts strictly sorted, unique, trimmed dependencies', () => {
      assert.doesNotThrow(() =>
        OperationValidator.validateCausalDependencies(['op-1', 'op-2', 'op-3'], 3, 'op-current')
      );
    });
  });

  describe('OperationValidator Integration with Schema v3', () => {
    it('validateCreateInput accepts schema v3 with valid causalDependencies', () => {
      const input: CreateOperationInput = {
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-1',
        payload: { title: 'Test' },
        schemaVersion: 3,
        causalDependencies: ['op-001', 'op-002'],
      };
      assert.doesNotThrow(() => OperationValidator.validateCreateInput(input));
    });

    it('validateCreateInput rejects schema v3 without causalDependencies array', () => {
      const input: CreateOperationInput = {
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-1',
        payload: { title: 'Test' },
        schemaVersion: 3,
      };
      assert.throws(
        () => OperationValidator.validateCreateInput(input),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes("Schema version 3 operations require 'causalDependencies' to be an array.")
      );
    });

    it('validateOperation accepts valid complete schema v3 operation', () => {
      const op: Operation = {
        operationId: 'op-valid-v3',
        nodeId: 'node-A',
        sequenceNumber: 1,
        operationType: 'CREATE',
        entityType: 'task',
        entityId: 'task-1',
        payload: { title: 'Test' },
        status: 'PENDING',
        createdAt: '2026-10-20T12:00:00.000Z',
        appliedAt: null,
        schemaVersion: 3,
        causalDependencies: ['op-dep-1'],
        checksum: computeOperationChecksum({
          operationId: 'op-valid-v3',
          nodeId: 'node-A',
          sequenceNumber: 1,
          operationType: 'CREATE',
          entityType: 'task',
          entityId: 'task-1',
          payload: { title: 'Test' },
          createdAt: '2026-10-20T12:00:00.000Z',
          schemaVersion: 3,
          causalDependencies: ['op-dep-1'],
        }),
      };
      assert.doesNotThrow(() => OperationValidator.validateOperation(op));
    });

    it('validateOperation rejects schema v3 with missing causalDependencies array', () => {
      const op = {
        operationId: 'op-invalid-v3',
        nodeId: 'node-A',
        sequenceNumber: 1,
        operationType: 'CREATE' as const,
        entityType: 'task',
        entityId: 'task-1',
        payload: { title: 'Test' },
        status: 'PENDING' as const,
        createdAt: '2026-10-20T12:00:00.000Z',
        appliedAt: null,
        schemaVersion: 3,
        checksum: 'a'.repeat(64),
      };
      assert.throws(
        () => OperationValidator.validateOperation(op as unknown as Operation),
        (err: Error) =>
          err instanceof InvalidOperationError &&
          err.message.includes("Schema version 3 operations require 'causalDependencies' to be an array.")
      );
    });
  });
});
