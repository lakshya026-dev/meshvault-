export type OperationType = 'CREATE' | 'UPDATE' | 'DELETE';

export type OperationStatus = 'PENDING' | 'APPLIED' | 'FAILED';

export const MIN_SUPPORTED_SCHEMA_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 2;
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlyArray<number> = [1, 2, 3];

export function isSupportedSchemaVersion(version: unknown): version is number {
  return (
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    SUPPORTED_SCHEMA_VERSIONS.includes(version)
  );
}

export interface Operation<T = Record<string, unknown>> {
  operationId: string;
  nodeId: string;
  sequenceNumber: number;
  operationType: OperationType;
  entityType: string;
  entityId: string;
  payload: T;
  status: OperationStatus;
  createdAt: string;
  appliedAt: string | null;
  checksum: string;
  errorMessage?: string | null;
  /** Explicit operation schema version. Always set on normalized/persisted operations. */
  schemaVersion: number;
  /** Direct causal predecessors for this entity (required array for schema v3+). */
  causalDependencies?: string[];
}

export interface CreateOperationInput<T = Record<string, unknown>> {
  operationType: OperationType;
  entityType: string;
  entityId: string;
  payload: T;
  operationId?: string;
  schemaVersion?: number;
  causalDependencies?: string[];
}

export interface RecordEntity<T = Record<string, unknown>> {
  id: string;
  entityType: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface NodeInfo {
  nodeId: string;
  createdAt: string;
}
