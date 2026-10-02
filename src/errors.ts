export class MeshVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshVaultError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidOperationError extends MeshVaultError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

export class OperationIntegrityError extends MeshVaultError {
  constructor(message: string) {
    super(`Integrity verification failed: ${message}`);
    this.name = 'OperationIntegrityError';
  }
}

export class InvalidOperationStateError extends MeshVaultError {
  constructor(message: string) {
    super(`Invalid operation state: ${message}`);
    this.name = 'InvalidOperationStateError';
  }
}

export class EntityNotFoundError extends MeshVaultError {
  constructor(entityType: string, entityId: string) {
    super(`Entity of type '${entityType}' with ID '${entityId}' was not found.`);
    this.name = 'EntityNotFoundError';
  }
}

export class EntityAlreadyExistsError extends MeshVaultError {
  constructor(entityType: string, entityId: string) {
    super(`Entity of type '${entityType}' with ID '${entityId}' already exists.`);
    this.name = 'EntityAlreadyExistsError';
  }
}

export class DuplicateOperationError extends MeshVaultError {
  constructor(operationId: string) {
    super(`Operation with ID '${operationId}' already exists in the log.`);
    this.name = 'DuplicateOperationError';
  }
}

export class DatabaseError extends MeshVaultError {
  constructor(message: string, public readonly cause?: unknown) {
    super(`Database error: ${message}`);
    this.name = 'DatabaseError';
  }
}

export class NetworkError extends MeshVaultError {
  constructor(message: string, public readonly statusCode?: number, public readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class UnsupportedSchemaVersionError extends MeshVaultError {
  constructor(public readonly version: unknown) {
    super(`Unsupported operation schema version: '${String(version)}'.`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export class VersionMismatchError extends MeshVaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VersionMismatchError';
  }
}
