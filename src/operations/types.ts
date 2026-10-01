export type OperationType = 'CREATE' | 'UPDATE' | 'DELETE';

export type OperationStatus = 'PENDING' | 'APPLIED' | 'FAILED';

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
}

export interface CreateOperationInput<T = Record<string, unknown>> {
  operationType: OperationType;
  entityType: string;
  entityId: string;
  payload: T;
  operationId?: string;
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
