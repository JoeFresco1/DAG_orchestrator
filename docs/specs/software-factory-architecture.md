# Software factory architecture (foundation)

This document maps the software-factory capabilities in
[`software-factory-v0.1.md`](software-factory-v0.1.md) onto the current DAG
Orchestrator. It establishes storage and code extension points before adding
the later graph, risk, review, defect, certification, and learning features.

## Design boundary

The current DAG remains the only execution substrate. Its dependency graph,
`DagRunner`, executor, retries, reviews, worktree handling, recovery, and
convergence behavior continue to own task execution. Factory components add
domain data, analysis, and policy inputs around those mechanisms. A factory
review or verification action that needs execution is represented by an
ordinary DAG task and is launched through the existing runner. Do not add a
second executor, readiness loop, or scheduler.

Keep the public CLI and `Run` storage format at `storageVersion: 2` for this
foundation. The existing `Run.id` is the association key for factory data; no
extra field is required in the run definition or state. Future in-memory
attachment can be introduced as an optional `Run.factory` link only alongside
a deliberate storage-version migration and normalization of older run files.

## Storage and traceability

`store.runPaths(file)` maps the existing run file to its `.d` sidecar. The
current definition stores authored run and task configuration; `state.json`
stores changing task execution state; `events.jsonl` and `logs/` retain
event/attempt history. Factory records belong under a namespaced directory
inside that same sidecar, for example:

```text
<run>.d/
  factory/
    manifest.json
    graphs/requirement-v1.json
    graphs/code-v1.json
    graphs/execution-v1.json
    graphs/defect-v1.json
    evidence/<sha256>
```

The manifest is factory-owned and has its own schema version, independent of
`Run.storageVersion`. It records the owning `runId` and the versioned artifact
references. This keeps factory schema evolution out of the CLI run format and
allows artifacts to be loaded lazily. Small summaries may later be cached on
the in-memory `Run`, but the sidecar remains the source of truth. Write factory
files atomically using the existing store's temp-write/fsync/rename pattern;
do not put graph payloads into the frequently rewritten task state or event
ring.

`src/factory/contracts.ts` defines the initial shared identity and evidence
contract:

- Entity IDs use `<graph-kind>:v1:<stable-key>`, where graph kind is
  `requirement`, `code`, `execution`, or `defect`. Keys are deterministic and
  opaque to consumers. A schema change that changes identity semantics uses a
  new version namespace rather than silently changing old IDs.
- Evidence IDs use `evidence:v1:<lowercase-sha256>`. An evidence reference
  carries its evidence kind, a stable URI or run-relative location, and the
  SHA-256 of the bytes. Evidence records point to existing sources—spec text,
  code, attempt/review logs, commands, or Git commits—rather than copying
  unbounded transcripts into graph edges. Validate the hash when content is
  read; retaining the reference alone does not prove the source is available.
- Graph entities and relationships can point to evidence IDs. Cross-graph
  edges then preserve the trace path from requirement to code, execution task,
  observation/defect, root cause, and remediation without conflating the four
  graphs described in source-spec section 13.

The contract deliberately defines identifiers and evidence references only;
graph entity schemas, indexing, scoring, policy, and storage I/O belong to
later phases in the recommended sequence (section 33).

## Existing code extension points

### `src/runner.ts`

- `DagRunner.start()` performs run validation, recovery, and lock acquisition.
  Future factory startup checks or sidecar recovery hooks belong at this
  lifecycle boundary, while preserving current lock ownership and recovery.
- `DagRunner.loop()` is the run-level convergence driver. Factory policy may
  prepare review decisions before an existing review pass or inspect settled
  outcomes here. It must call the current task loop and reuse its convergence
  and stop semantics.
- `DagRunner.runTasks()` is the sole dependency-aware scheduler. A future
  router should annotate/select work before the existing ready-task launch
  loop; launch eligibility still comes from `topoSort`, `depsMet`, gate and
  failure policy, concurrency, and the wall-clock budget.
- `DagRunner.executeTask()` and `runPhase()` are the execution/review phase
  seams. Attach provenance and factory evidence to the existing task attempt,
  plan, reviewer, and command outcomes here. Run factory verification by
  creating ordinary tasks or using the existing reviewer phase, not by
  spawning a separate worker pool.

### `src/store.ts`

- `runPaths()` is the path-layout extension point. Add a `factory` directory
  path here when factory persistence is introduced; it must remain derived
  from the same run file and inside its `.d` sidecar.
- `definitionOf()` and `stateOf()` explicitly select persisted fields.
  Preserve that split: factory graph/evidence payloads should initially use
  separate sidecar files and a factory schema version. If a future migration
  adds a `Run.factory` field, update normalization, serializers, and migration
  tests together and bump `STORAGE_VERSION` as required.
- `loadRun()` and `saveRun()` are the coordinated load/persist seams. Add
  version checks, validation, and atomic sidecar writes there or in a focused
  factory store called by these seams; preserve the existing run lock and
  state-write guarantees. `mutate()` remains the serialized read-modify-write
  path for CLI/server edits.

### `src/graph.ts`

- `depsMet()`, `depUnusable()`, and `gateBlocks()` define task-level
  eligibility. `getReady()` combines them for graph queries and display.
- `topoSort()` supplies deterministic dependency order; `transitiveDepIds()`
  and `transitiveDependentIds()` support provenance and invalidation context.
- Extend these pure task-graph functions only when a factory policy needs a
  DAG-level query. The requirement, code, and defect graphs remain separate
  domain graphs with explicit typed links; do not overload task `deps` with
  non-task relationships or put a second readiness algorithm here.

## Incremental delivery order

Follow section 33 rather than implementing the full control plane at once:
first reduce review waste with risk, review routing, coherent units, and
compiled context; then normalize and verify findings; then connect root causes
to remediation; then add project memory, baselines, impact, and recertification;
then learning and telemetry; finally budgets, information gain, confidence,
and convergence policy. Each phase should persist reproducible evidence and
reuse the existing DAG's task and review lifecycle.
