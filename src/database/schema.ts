export const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS node_info (
  node_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_entity_type ON records(entity_type);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  operation_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  applied_at TEXT,
  checksum TEXT NOT NULL DEFAULT '',
  error_message TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_node_seq ON operations(node_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_operations_entity ON operations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_operations_node_status ON operations(node_id, status);
CREATE INDEX IF NOT EXISTS idx_operations_node_seq_range ON operations(node_id, sequence_number ASC);
`;
