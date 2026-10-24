# MeshVault Phase 6.3: Causal Engine Design (6.3a)

Status: design only. No code changes in this step.

## Goal

Make every node that holds the same set of operations derive the same record state, regardless of the order in which operations arrived. This property is convergence.

Out of scope: vector clocks, CRDT libraries, authentication, new transports, changing the v1/v2/v3 checksum formulas, changing CURRENT_SCHEMA_VERSION (stays 2).

## Current behavior (from the audit)

- `applyOperation` mutates `records` on arrival. UPDATE shallow-merges the payload; UPDATE or DELETE on a missing record is a silent no-op that is still marked APPLIED.
- Concurrent edits are resolved by arrival order only.
- `causalDependencies` is stored and checksummed but never read.
- There is no per-entity head or revision.

## Definitions

- **Entity**: the pair `(entityType, entityId)`.
- **Dependency**: a v3 operation lists, in `causalDependencies`, the operation IDs of the heads of its own entity that its node had applied when the operation was created. A head is an operation that no other known operation of that entity depends on.
- **Ancestor**: A is an ancestor of B if B depends on A directly or through a chain.
- **Concurrent**: neither is an ancestor of the other.
- **Root**: an operation with no dependencies. All v1/v2 operations are roots. Dependencies are never invented for legacy operations.
- **Order key**: `(nodeId ascending, sequenceNumber ascending)`. Timestamps are never used for ordering.

## Rules

### 1. Dependencies are same-entity only
A dependency that points to an operation of a different entity is invalid and the operation is rejected. A v3 operation may not depend on itself (already validated in 6.1).

### 2. Ingestion and buffering
- A received operation is validated, integrity-checked and sequence-checked exactly as today (duplicate handling, per-origin gap rule, checksum).
- If all its dependencies are stored locally, it becomes materializable.
- If any dependency is missing, it is stored with status `PENDING_DEPENDENCY` and is not materialized. It still counts for per-origin sequence continuity, because it arrived in sequence order. When a missing dependency arrives, waiting operations of that entity are re-evaluated and released.
- If adding an operation would create a cycle in the entity's graph, it is rejected as malformed.
- A new status value needs a migration that adds nothing destructive and keeps existing rows unchanged.
- Buffered operations never expire automatically. Sync status should report how many operations are waiting.

### 3. State derivation
For one entity, take all materializable operations and order them like this:
1. Topological order: an operation comes after all its dependencies.
2. Among operations that are ready at the same time, pick the smallest order key first.

Then replay in that order:
- CREATE sets the record to its payload.
- UPDATE shallow-merges its payload into the record (later in the order wins on overlapping fields; fields touched by only one operation are all kept).
- DELETE marks the entity deleted.

`records` is a cache of this result. It can always be rebuilt from `operations`. After any change to an entity's materializable set, re-derive that entity and rewrite its cache row.

### 4. Deletes
- Delete wins over concurrent updates: if a DELETE is not followed by a CREATE that descends from it, the entity is deleted, and updates that are ancestors of or concurrent with the DELETE have no visible effect.
- An UPDATE that depends on a DELETE (without a CREATE in between) is ignored for state purposes and is kept in the log.
- A CREATE that descends from a DELETE re-creates the entity. State restarts from that CREATE and only operations descending from it apply.
- Operations are never physically removed from the log.

### 5. Concurrent creates
Two concurrent CREATEs of the same entity are both kept. The state is derived by the same replay: the later CREATE in order replaces the earlier one entirely (a CREATE sets the record, it does not merge).

### 6. Legacy operations
v1/v2 operations are roots. Several legacy operations on the same entity are ordered by the order key. No dependencies are added, no checksums change.

### 7. Protocol compatibility
Causal metadata is never stripped to make an operation look compatible with an older peer. Unsupported operations follow the existing rejection path.

## Worked example

Record `device-1` exists from operation `C` (CREATE `{status: "active", location: "Lab A"}`, node-A, seq 1).

- node-A offline: `U1` UPDATE `{location: "Lab B"}`, depends on `[C]`, node-A, seq 2.
- node-B offline: `U2` UPDATE `{status: "maintenance"}`, depends on `[C]`, node-B, seq 1.

`U1` and `U2` are concurrent. Order: `C`, then `U1` (node-A < node-B), then `U2`. Result: `{status: "maintenance", location: "Lab B"}` on every node, no matter which arrived first.

If node-A had also sent `U3` UPDATE `{location: "Lab C"}` depending on `[U1]`, and node-B's `U2` also set `location: "Lab D"`, the overlap is `location`. `U2` sorts after `U3`, so `location` is `"Lab D"` everywhere.

If `D` (DELETE, depends on `[C]`) is concurrent with `U1`, the entity is deleted everywhere.

If `U1` arrives at a node before `C`, `U1` is stored as `PENDING_DEPENDENCY` and applied once `C` arrives.

## Test requirements

- Convergence: apply the same set of operations in many shuffled arrival orders; the derived records are identical.
- Update before create is buffered and later applied; nothing is lost.
- Delete wins over a concurrent update; CREATE after DELETE restores the entity.
- Cycles are rejected; cross-entity dependencies are rejected.
- Overlapping fields resolve by order key; disjoint fields are both kept.
- Legacy v1/v2 data behaves as before and gains no dependencies.
- v1/v2/v3 checksum formulas and CURRENT_SCHEMA_VERSION = 2 are unchanged.
- Rebuilding `records` from `operations` yields the same cache as incremental updates.

## Implementation split

- **6.3b**: dependency graph validation (missing, cross-entity, cycles), `PENDING_DEPENDENCY` status with migration, release of buffered operations. No change to state derivation yet.
- **6.3c**: deterministic derivation, delete and re-create semantics, cache rebuild, convergence tests.
