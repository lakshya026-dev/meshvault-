# MeshVault

An offline-first distributed synchronization system. Nodes keep working locally while disconnected, then exchange the operations they are missing when connectivity returns, without duplicating operations or losing history.

Built in TypeScript on Node.js and SQLite, with minimal dependencies. This is a learning and portfolio project on distributed systems, developed in small, tested phases.

## The problem

Imagine three devices. Node A loses its connection. Node B keeps creating and updating records on its own. Node C is offline for hours. All three must keep working, and when they reconnect they need to exchange what each is missing and end up consistent, with the full history of changes preserved.

## How it works

MeshVault is **operation-based**. Every change is recorded as an immutable operation (`CREATE`, `UPDATE`, `DELETE`) in an append-only log. The current record is the materialized state; the log is what makes synchronization, integrity checking and future conflict resolution possible.

```text
              MeshVault Node A
            +------------------+
            | Node identity    |
            | SQLite (WAL)     |
            | Operation log    |
            | Local CRUD       |
            +--------+---------+
                     |
                 HTTP sync
          +----------+----------+
          |                     |
   +------v-------+     +-------v------+
   | MeshVault B  |     | MeshVault C  |
   | SQLite + log |     | SQLite + log |
   +--------------+     +--------------+
```

### Key design decisions

- **Persistent node identity.** A restarted node is the same node, not a new participant.
- **Operation ID vs. checksum.** The ID identifies an operation; the SHA-256 checksum verifies its contents. They are deliberately separate.
- **Canonical serialization.** Payload keys are sorted recursively, so logically equal payloads always hash identically.
- **Per-origin sequence numbers.** Each node numbers its own operations. Peers track progress per origin, so sync is incremental ("give me node A's operations after sequence 25").
- **Idempotent processing.** Replaying an applied operation is a no-op. The same ID with different content is rejected as an integrity error.
- **Sequence-gap rejection.** An operation that skips ahead of what a node has seen from that origin is refused.
- **Versioned operation schema.** The format can evolve (v1, v2, v3) without invalidating old checksums; each version has its own checksum contract.
- **Causal dependencies instead of timestamps.** Clocks across offline nodes cannot establish ordering, so v3 operations carry explicit dependencies.

## Status

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Local node: identity, SQLite, CRUD, CLI/REPL | Done |
| 2 | Operation engine: validation, checksums, lifecycle, replay | Done |
| 3 | Sync: status and operation endpoints, per-origin sequences, bidirectional sync, batching | Done |
| 4 | Reliability: idempotent receive, retry and backoff | Done |
| 5 | Operation schema versioning and safe migrations | Done |
| 6.1 | Schema v3: causal dependency metadata, checksum contract, structural validation | Done |
| 6.2 | Persistence and safe migration of causal dependencies | Done |
| 6.3 | Causal engine: graph validation, conflict detection, deterministic materialization | Planned |
| 7 | Failure recovery | Planned |
| 8 | Network simulator | Planned |
| 9 | Dashboard | Planned |
| 10 | Stress testing and demo | Planned |

The automated suite (168 tests across 27 suites on the committed code) covers validation, integrity, replay, queries, migrations, restart behavior, sync and the CLI.

## Operation engine

### Lifecycle

```text
              User / Application Action
                          |
              Validate input (OperationValidator)
                          |
              Assign node ID and sequence number
                          |
              Compute deterministic SHA-256 checksum
                          |
              BEGIN IMMEDIATE TRANSACTION
                          |
              1. INSERT operation (status: PENDING)
                          |
              2. Apply to records (CREATE / UPDATE / DELETE)
                          |
              3. UPDATE operation: status = APPLIED, applied_at = now
                          |
              COMMIT (atomic)
```

State transitions:

- `PENDING -> APPLIED`: normal execution, or reconciliation of an unfinished operation.
- `PENDING -> FAILED`: precondition or execution failure (error message retained).
- `APPLIED -> APPLIED`: replay is a deterministic no-op.
- `APPLIED` with a tampered checksum: rejected with `OperationIntegrityError`.

### Integrity

Each operation carries a SHA-256 checksum over its canonical fields. Changing the payload, entity, sequence number, node ID or timestamp invalidates it. The checksum formula is versioned (v1: 8 fields, v2: 9, v3: 10, including canonical causal dependencies), and older formulas are never changed so historical operations stay verifiable.

### Queries

Operations can be queried by ID, sequence number, node, status, entity, and by sequence range, with independent sequence counters per node.

## Getting started

Requires Node.js 24 (uses the built-in `node:sqlite`).

```bash
npm install
npm run build     # compile TypeScript
npm test          # run the test suite
npm start         # interactive REPL
```

### CLI

```bash
npm run cli -- node-id                                   # show this node's ID
npm run cli -- create task task-001 '{"title":"Learn Distributed Systems","priority":1}'
npm run cli -- update task task-001 '{"priority":2}'
npm run cli -- delete task task-001
npm run cli -- records                                   # list records
npm run cli -- operations                                # operation log
npm run cli -- operation <operation_id>                  # inspect one operation
npm run cli -- verify <operation_id>                     # verify its checksum
npm run cli -- applied | pending | failed                # filter by status
```

### Interactive REPL

```text
$ npm start
meshvault> node-id
meshvault> create task task-001 {"title":"Learn Distributed Systems"}
meshvault> verify <operation_id>
meshvault> records
meshvault> exit
```

<!-- TODO: document the sync commands (sync <peer-url>, sync-status) and how to run node-A / node-B / node-C locally on ports 3001-3003 with separate databases (data/node-a.db etc.). -->

## Project layout

```text
src/
  config/        persistent node identity
  database/      SQLite setup (WAL), schema, migrations
  operations/    types, canonical serialization, integrity, validation, operation manager
  sync/          synchronization manager
  errors.ts      typed domain errors
  index.ts       CLI and REPL
tests/           automated tests (node:test)
data/            local SQLite database (gitignored)
```

## Current limitations

- Causal dependencies are validated structurally and stored, but not yet used to detect or resolve concurrent edits. There is no conflict resolution yet.
- Dependency graph cycle detection is not implemented.
- `DELETE` removes the record row (the operation stays in the log); there are no tombstones yet.
- No authentication between peers and no WebSocket transport.
- Single active writer per database.
- A record is identified by the pair `(entity_type, id)`.

## Roadmap

The next milestone is Phase 6.3, the causal engine: validating the dependency graph, detecting concurrent operations on the same record, and deriving record state deterministically from the operation history. Recovery, a network simulator, a dashboard and a stress-test demo follow.

## License

TODO
