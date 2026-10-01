# MeshVault

MeshVault is an offline-first distributed synchronization system designed to maintain consistent shared state across intermittently connected devices, edge nodes, and central servers.

> **Important Notice:** Synchronization is intentionally NOT implemented in Phase 1.  
> Phase 1 focuses strictly on the local standalone node foundation.

---

## Phase 1: Local Node Foundation

Phase 1 establishes a robust, durable, and crash-resilient local foundation for a MeshVault node that operates completely offline.

### What Phase 1 Implements

1. **Persistent Node Identity**: Every MeshVault node has a unique, persistent identifier stored locally in SQLite (`node_info` table). This identifier is generated once and preserved across application restarts.
2. **Durable Operation Log**: Every state mutation (`CREATE`, `UPDATE`, `DELETE`) is structured as an immutable operation, given a monotonically increasing sequence number, and stored durably in the `operations` table with status `PENDING`.
3. **Local State Engine**: A local key-value entity store (`records` table) that reflects the state produced by operations.
4. **Atomic Operation Creation & Application**: Operations are recorded and applied to local state within atomic database transactions, preventing state corruption or phantom operations upon crashes.
5. **Local Idempotency Protection**: Safe re-application of operations without duplicating or corrupting local state.
6. **Restart Resilience**: Database state, node identity, operation log, and sequence counters persist intact across restarts.
7. **Interactive & Command CLI**: A command-line interface for manual verification and demonstration.

---

## Architecture

The Phase 1 architecture follows a clean, decoupled layout designed for modular extension in future phases:

```text
meshvault/
│
├── src/
│   ├── config/
│   │   └── node.ts              # Node identity configuration and persistence
│   │
│   ├── database/
│   │   ├── db.ts                # Database connection, WAL pragma setup, and transaction manager
│   │   └── schema.ts            # DDL schemas and database indexes
│   │
│   ├── operations/
│   │   ├── types.ts             # Domain models (Operation, OperationType, RecordEntity)
│   │   └── operation-manager.ts # Operation creation, storage, and state application
│   │
│   ├── errors.ts                # Domain-specific error types
│   └── index.ts                 # CLI entry point and interactive REPL
│
├── data/
│   └── meshvault.db             # Local SQLite database (auto-created)
│
├── tests/
│   ├── database.test.ts         # Schema & transaction tests
│   ├── errors.test.ts           # Validation & error handling tests
│   ├── node-identity.test.ts    # Identity generation & restart persistence tests
│   ├── operations.test.ts       # Operations, state application, & idempotency tests
│   ├── restart.test.ts          # End-to-end restart verification test
│   └── test-utils.ts            # Test helpers for safe temporary SQLite databases
│
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Database Schema

MeshVault uses SQLite via Node.js built-in `node:sqlite` in WAL (Write-Ahead Logging) mode for durability and concurrent read performance.

### 1. `node_info` Table
Stores node identity metadata.
```sql
CREATE TABLE IF NOT EXISTS node_info (
  node_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
```

### 2. `records` Table
Stores current local materialized state.
```sql
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_entity_type ON records(entity_type);
```

### 3. `operations` Table
Stores the append-only local operation log.
```sql
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  operation_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_node_seq ON operations(node_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_operations_entity ON operations(entity_type, entity_id);
```

---

## Operation Lifecycle

```text
User / Application Action
          ↓
  Validate Input (type, entityId, payload)
          ↓
  Generate Operation ID (op-<seq>-<uuid>)
          ↓
  Assign Persistent Node ID
          ↓
  Assign Monotonic Sequence Number (MAX(seq) + 1)
          ↓
  BEGIN TRANSACTION
    ├── 1. INSERT INTO operations (status: 'PENDING')
    └── 2. Apply Operation to 'records' state
  COMMIT TRANSACTION
```

1. **CREATE**: Inserts record into `records`. If entity ID already exists, creation is rejected.
2. **UPDATE**: Merges new payload attributes into existing record `data` and updates `updated_at`. Target entity must exist.
3. **DELETE**: Removes record from `records`. Target entity must exist.
4. **Idempotency**: Applying an operation that has already been recorded and marked with `applied_at` is safely ignored without re-mutating state.

---

## Installation & Setup

### Prerequisites
- Node.js 22.5.0 or later (v24+ recommended, tested on Node v24.11.0)
- npm

### Installation
```bash
# Clone the repository
git clone <repository-url>
cd "Mesh Fault"

# Install development dependencies
npm install

# Compile TypeScript
npm run build
```

---

## How to Run

### Interactive REPL Mode
Start an interactive shell session:
```bash
npm start
```
Inside the interactive prompt:
```text
meshvault> node-id
meshvault> create task task-001 {"title":"Learn Distributed Systems"}
meshvault> records
meshvault> update task task-001 {"status":"completed"}
meshvault> operations
meshvault> pending
meshvault> delete task task-001
meshvault> exit
```

### Direct CLI Commands
You can also run commands directly:

```bash
# Check current Node ID
npm run cli -- node-id

# Create a record
npm run cli -- create task task-001 '{"title":"Learn Distributed Systems"}'

# List all local records
npm run cli -- records

# Update a record
npm run cli -- update task task-001 '{"status":"completed"}'

# View the full operation log
npm run cli -- operations

# View pending operations
npm run cli -- pending

# Delete a record
npm run cli -- delete task task-001
```

---

## How to Test

Run the full automated test suite using Node's test runner and `tsx`:

```bash
npm test
```

### Test Suites Included:
- **`tests/database.test.ts`**: Verifies database initialization, table creation, indexes, and transaction rollback/commit semantics.
- **`tests/node-identity.test.ts`**: Verifies node ID generation, custom ID assignment, and persistent identity across restarts.
- **`tests/operations.test.ts`**: Verifies sequence counter monotonicity, `CREATE`/`UPDATE`/`DELETE` execution, operation retrieval, pending filters, and idempotency protection.
- **`tests/restart.test.ts`**: Implements the mandatory Section 15 restart specification: creating 3 operations, closing the database, restarting, and verifying node ID, sequence counter, operation history, and local state.
- **`tests/errors.test.ts`**: Validates comprehensive domain error handling (invalid operation types, empty entity IDs, duplicate operation IDs, invalid payloads, non-existent entity updates/deletions).
