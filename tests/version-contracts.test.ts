import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  MIN_SUPPORTED_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  isSupportedSchemaVersion,
} from '../src/operations/types.js';
import {
  MeshVaultError,
  UnsupportedSchemaVersionError,
  VersionMismatchError,
} from '../src/errors.js';

describe('Phase 5 Step 2 — Version Contracts & Types', () => {
  it('exports valid schema version constants', () => {
    assert.strictEqual(MIN_SUPPORTED_SCHEMA_VERSION, 1);
    assert.strictEqual(CURRENT_SCHEMA_VERSION, 2);
    assert.deepStrictEqual(Array.from(SUPPORTED_SCHEMA_VERSIONS), [1, 2]);
  });

  it('validates supported operation schema versions (1 and 2)', () => {
    assert.strictEqual(isSupportedSchemaVersion(1), true);
    assert.strictEqual(isSupportedSchemaVersion(2), true);
  });

  it('detects unsupported schema versions', () => {
    assert.strictEqual(isSupportedSchemaVersion(0), false);
    assert.strictEqual(isSupportedSchemaVersion(3), false);
    assert.strictEqual(isSupportedSchemaVersion(99), false);
    assert.strictEqual(isSupportedSchemaVersion(-1), false);
  });

  it('detects malformed schema version values', () => {
    assert.strictEqual(isSupportedSchemaVersion('1'), false);
    assert.strictEqual(isSupportedSchemaVersion(1.5), false);
    assert.strictEqual(isSupportedSchemaVersion(null), false);
    assert.strictEqual(isSupportedSchemaVersion(undefined), false);
    assert.strictEqual(isSupportedSchemaVersion(NaN), false);
    assert.strictEqual(isSupportedSchemaVersion({}), false);
  });

  it('instantiates UnsupportedSchemaVersionError with correct hierarchy and metadata', () => {
    const error = new UnsupportedSchemaVersionError(99);
    assert.ok(error instanceof MeshVaultError);
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'UnsupportedSchemaVersionError');
    assert.strictEqual(error.version, 99);
    assert.strictEqual(error.message, "Unsupported operation schema version: '99'.");
  });

  it('instantiates VersionMismatchError with correct hierarchy and metadata', () => {
    const error = new VersionMismatchError('Peer node supports versions [1], local node uses [2].');
    assert.ok(error instanceof MeshVaultError);
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'VersionMismatchError');
    assert.strictEqual(error.message, 'Peer node supports versions [1], local node uses [2].');
  });
});
