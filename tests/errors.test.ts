import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseManager } from '../src/database/db.js';
import { NodeConfig } from '../src/config/node.js';
import { OperationManager } from '../src/operations/operation-manager.js';
import {
  InvalidOperationError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  DuplicateOperationError,
} from '../src/errors.js';
import { OperationType } from '../src/operations/types.js';
import { getUniqueTestDbPath, cleanupTestFile } from './test-utils.js';

describe('Error Handling', () => {
  function createTestNode(dbPath: string) {
    const db = new DatabaseManager({ dbPath });
    const config = new NodeConfig(db, 'node-err-test');
    const opManager = new OperationManager(db, config);
    return { db, config, opManager };
  }

  it('rejects invalid operation types', () => {
    const dbPath = getUniqueTestDbPath('err_op_type');
    const { db, opManager } = createTestNode(dbPath);

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'INVALID_TYPE' as unknown as OperationType,
          entityType: 'task',
          entityId: 'task-1',
          payload: {},
        });
      },
      (err: unknown) => {
        return err instanceof InvalidOperationError && err.message.includes('Invalid operation type');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects missing or empty entityId', () => {
    const dbPath = getUniqueTestDbPath('err_entity_id');
    const { db, opManager } = createTestNode(dbPath);

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'CREATE',
          entityType: 'task',
          entityId: '',
          payload: { title: 'Test' },
        });
      },
      (err: unknown) => {
        return err instanceof InvalidOperationError && err.message.includes('Entity ID');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects missing or empty entityType', () => {
    const dbPath = getUniqueTestDbPath('err_entity_type');
    const { db, opManager } = createTestNode(dbPath);

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'CREATE',
          entityType: '',
          entityId: 'task-1',
          payload: { title: 'Test' },
        });
      },
      (err: unknown) => {
        return err instanceof InvalidOperationError && err.message.includes('Entity type');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects invalid payload format', () => {
    const dbPath = getUniqueTestDbPath('err_payload');
    const { db, opManager } = createTestNode(dbPath);

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'CREATE',
          entityType: 'task',
          entityId: 'task-1',
          payload: null as unknown as Record<string, unknown>,
        });
      },
      (err: unknown) => {
        return err instanceof InvalidOperationError && err.message.includes('Payload must be a valid JSON object');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects duplicate operation ID', () => {
    const dbPath = getUniqueTestDbPath('err_dup_op');
    const { db, opManager } = createTestNode(dbPath);

    opManager.createOperation({
      operationId: 'op-fixed-123',
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-1',
      payload: { title: 'First' },
    });

    assert.throws(
      () => {
        opManager.createOperation({
          operationId: 'op-fixed-123',
          operationType: 'CREATE',
          entityType: 'task',
          entityId: 'task-2',
          payload: { title: 'Second' },
        });
      },
      (err: unknown) => {
        return err instanceof DuplicateOperationError && err.message.includes('op-fixed-123');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects CREATE for an already existing entity', () => {
    const dbPath = getUniqueTestDbPath('err_exist_ent');
    const { db, opManager } = createTestNode(dbPath);

    opManager.createOperation({
      operationType: 'CREATE',
      entityType: 'task',
      entityId: 'task-duplicate',
      payload: { title: 'First' },
    });

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'CREATE',
          entityType: 'task',
          entityId: 'task-duplicate',
          payload: { title: 'Second' },
        });
      },
      (err: unknown) => {
        return err instanceof EntityAlreadyExistsError && err.message.includes('task-duplicate');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects UPDATE for non-existent entity', () => {
    const dbPath = getUniqueTestDbPath('err_update_nonexist');
    const { db, opManager } = createTestNode(dbPath);

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'UPDATE',
          entityType: 'task',
          entityId: 'task-does-not-exist',
          payload: { status: 'done' },
        });
      },
      (err: unknown) => {
        return err instanceof EntityNotFoundError && err.message.includes('task-does-not-exist');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });

  it('rejects DELETE for non-existent entity', () => {
    const dbPath = getUniqueTestDbPath('err_delete_nonexist');
    const { db, opManager } = createTestNode(dbPath);

    assert.throws(
      () => {
        opManager.createOperation({
          operationType: 'DELETE',
          entityType: 'task',
          entityId: 'task-does-not-exist',
          payload: {},
        });
      },
      (err: unknown) => {
        return err instanceof EntityNotFoundError && err.message.includes('task-does-not-exist');
      }
    );

    db.close();
    cleanupTestFile(dbPath);
  });
});
