# MeshVault

MeshVault is an offline-first distributed synchronization system designed to maintain consistent shared state across intermittently connected devices, edge nodes, and central servers.

> **Important Boundary Notice:** Network synchronization, remote peers, CRDTs, and conflict resolution are intentionally **NOT** part of Phase 2.  
> Phase 2 focuses strictly on building a robust, validated, deterministic, offline-first **Operation Engine**.

---

## Phase 2: Operation Engine / Advanced Operation Handling

Phase 2 hardens the standalone local node foundation into a robust, deterministic, cryptographically validated operation engine. Every state mutation is represented as an immutable, tamper-evident operation with explicit lifecycle states, canonical serialization, and deterministic replay semantics.

---

## Key Capabilities Implemented in Phase 2

1. **Strong Operation Validation**:
   - Dedicated validation layer (`OperationValidator`) enforcing structural, type, and semantic constraints.
   - Immediate rejection of malformed operations (empty IDs, non-integer or <1 sequence numbers, invalid operation types, malformed payloads, invalid ISO timestamps).
   - Typed domain errors (`InvalidOperationError`, `EntityNotFoundError`, `EntityAlreadyExistsError`, `DuplicateOperationError`, `OperationIntegrityError`, `InvalidOperationStateError`).

2. **Cryptographic Integrity & SHA-256 Checksums**:
   - Deterministic SHA-256 checksums computed across canonical operation fields:  
     `operationId:nodeId:sequenceNumber:operationType:entityType:entityId:canonicalPayload:createdAt`.
   - Tamper detection: any mutation to payload, entity ID, sequence number, node ID, or timestamp invalidates the checksum.
   - Built-in verification via `verifyOperationIntegrity()` and CLI `verify <opId>`.

3. **Canonical Payload Serialization**:
   - Deterministic JSON serializer (`canonicalize`) that recursively sorts object keys lexicographically.
   - Logical equivalence: `{ "title": "A", "priority": 1 }` and `{ "priority": 1, "title": "A" }` produce the exact same canonical string and SHA-256 hash.

4. **Explicit Operation Lifecycle**:
   - Operations transition cleanly through states:
     - `PENDING`: Stored in durable operation log, awaiting application or reconciliation.
     - `APPLIED`: Durably applied to local state, with `appliedAt` timestamp recorded.
     - `FAILED`: Marked if an operation fails execution preconditions, retaining `errorMessage`.
   - Transitions:
     - `PENDING -> APPLIED`
     - `PENDING -> FAILED`
   - Deterministic replay: An operation already marked `APPLIED` cannot be re-applied to alter state.

5. **Hardened Idempotency & Safe Replay**:
   - **New Operation**: Stored as `PENDING`, applied to local state, transitioned to `APPLIED`.
   - **Replay of APPLIED Operation**: Verifies checksum integrity against stored record. If identical, executes a deterministic no-op without mutating state.
   - **Conflicting/Tampered Operation**: If incoming operation shares an existing `operationId` but has different content or checksum, it is rejected with `OperationIntegrityError`.
   - **Reconcile PENDING Operation**: Safely resumes uncompleted operations to `APPLIED`.

6. **Advanced Querying & Filtering**:
   - Query by operation ID (`getOperation`)
   - Query by sequence number (`getOperationBySequence`)
   - Query by node (`getOperationsByNode`)
   - Query by status (`getOperationsByStatus`, `getPendingOperations`, `getAppliedOperations`, `getFailedOperations`)
   - Query by entity (`getOperationsByEntity`)
   - Query operations after sequence range (`getOperationsAfterSequence`)
   - Independent sequence counter per node (`(node_id, sequence_number)` unique index)

7. **Zero-Loss Database Schema Migration**:
   - Backward-compatible schema evolution adds `checksum` and `error_message` columns automatically without resetting existing data.

---

## Architecture

```text
meshvault/
│
├── src/
│   ├── config/
│   │   └── node.ts              # Persistent node identity management (atomic transaction)
│   │
│   ├── database/
│   │   ├── db.ts                # DatabaseManager with node:sqlite, WAL, migrations, & transactions
│   │   └── schema.ts            # DDL schemas and multi-column indexes
│   │
│   ├── operations/
│   │   ├── types.ts             # Domain models (Operation, OperationType, OperationStatus)
│   │   ├── canonical.ts         # Deterministic canonical JSON serializer
│   │   ├── integrity.ts         # SHA-256 checksum calculation & verification
│   │   ├── validator.ts         # OperationValidator for parameters and structural integrity
│   │   └── operation-manager.ts # Operation creation, validation, storage, replay, & queries
│   │
│   ├── errors.ts                # Typed domain errors
│   └── index.ts                 # CLI entry point and interactive REPL
│
├── data/
│   └── meshvault.db             # Local SQLite database (WAL mode)
│
├── tests/
│   ├── database.test.ts         # Schema & transaction rollback tests
│   ├── errors.test.ts           # Validation & error handling tests
│   ├── integrity.test.ts        # Checksum & canonical payload tests
│   ├── node-identity.test.ts    # Node identity persistence tests
│   ├── operations.test.ts       # Operations lifecycle, sequence, and atomicity tests
│   ├── queries.test.ts          # Querying and multi-node sequence tests
│   ├── replay-lifecycle.test.ts # Replay, tamper detection, & state machine tests
│   ├── repl-parser.test.ts      # Command line parser tests
│   ├── restart.test.ts          # Mandatory restart persistence verification
│   └── test-utils.ts            # Test isolation utilities
│
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Database Schema (Phase 2)

```sql
CREATE TABLE IF NOT EXISTS node_info (
  node_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_records_entity_id_type ON records(entity_type, id);

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
```

---

## Operation Lifecycle & State Machine

```text
                  User / Application Action
                              ↓
              Validate Input (OperationValidator)
                              ↓
                Assign Persistent Node ID
                              ↓
            Assign Monotonic Sequence Number
                              ↓
          Compute Deterministic SHA-256 Checksum
                              ↓
           BEGIN IMMEDIATE DATABASE TRANSACTION
                              ↓
          1. INSERT INTO operations (status: 'PENDING')
                              ↓
          2. Apply to 'records' State (CREATE / UPDATE / DELETE)
                              ↓
          3. UPDATE operations SET status = 'APPLIED', applied_at = now
                              ↓
             COMMIT DATABASE TRANSACTION (Atomic)
```

### State Transitions:
* `PENDING -> APPLIED`: Normal execution and replay of unapplied operations.
* `PENDING -> FAILED`: Precondition or execution failure.
* `APPLIED -> APPLIED`: Deterministic no-op replay (state is not altered).
* `APPLIED (tampered)`: Checksum mismatch throws `OperationIntegrityError`.

---

## Installation & Setup

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build
```

---

## CLI Usage

### Direct Commands
```bash
# Check current Node ID
npm run cli -- node-id

# Create a record (auto-computes SHA-256 checksum and marks APPLIED)
npm run cli -- create task task-001 '{"title":"Learn Distributed Systems","priority":1}'

# View all records
npm run cli -- records

# Update a record
npm run cli -- update task task-001 '{"priority":2}'

# Delete a record
npm run cli -- delete task task-001

# View operation log
npm run cli -- operations

# Inspect an individual operation
npm run cli -- operation <operation_id>

# Verify cryptographic integrity of an operation
npm run cli -- verify <operation_id>

# Filter operations by status
npm run cli -- applied
npm run cli -- pending
npm run cli -- failed
```

### Interactive REPL
```bash
npm start
```
```text
meshvault> node-id
meshvault> create task task-001 {"title":"Learn Distributed Systems"}
meshvault> operation op-001-xxxx
meshvault> verify op-001-xxxx
meshvault> records
meshvault> exit
```

---

## Automated Testing

Run the full automated test suite (54 tests across 10 suites):

```bash
npm test
```

### Test Suites:
1. `tests/validation.test.ts`: Input and operation schema validation.
2. `tests/integrity.test.ts`: Deterministic hashing, canonicalization, and tamper detection.
3. `tests/operations.test.ts`: Operation creation, state application, and rollback atomicity.
4. `tests/queries.test.ts`: Multi-criteria querying and multi-node sequence isolation.
5. `tests/replay-lifecycle.test.ts`: Idempotent replay, modified operation rejection, and PENDING reconciliation.
6. `tests/database.test.ts`: Table DDL, index integrity, and transaction commit/rollback.
7. `tests/node-identity.test.ts`: Node ID generation and persistent identity.
8. `tests/restart.test.ts`: End-to-end restart persistence across state, operations, and checksums.
9. `tests/errors.test.ts`: Domain error validation.
10. `tests/repl-parser.test.ts`: CLI/REPL command line parsing.

---

## Limitations (Phase 2 Boundaries)

1. **Standalone Offline Operation**: No remote synchronization, WebSocket, or REST transport is present.
2. **Local Sequence Numbers**: Sequence numbers are strictly node-local. Distributed vector clocks and conflict resolution belong to future phases.
3. **Single Active Writer**: Single node process per SQLite database file via WAL mode.
4. **Canonical Entity Identity**: A record is identified by the pair `(entity_type, id)`.
   CREATE, UPDATE, DELETE, replay, and idempotency checks use both fields. The
   compatibility `getRecord(id)` lookup returns a record only when that ID is
   unambiguous.
