# Feature Specification: Content-Bound Check Reuse

**Feature Branch**: `014-content-bound-check-reuse`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-14: content-bound reuse for safe deterministic work — cache eligible deterministic analysis or read-only checks against declared inputs, tool versions, environment identity, policy, and source hashes, kept separate from authoritative acceptance receipts."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reuse a deterministic check only when nothing it depends on changed (Priority: P1)

A maintainer runs a deterministic read-only check (for example a lint or static analysis command) under the content-bound cache. On a second run where the declared inputs, tool versions, environment identity, policy, and source hashes are identical, the cached result is reused and the report identifies the original run and source of every reused result. If any captured input changed, is unavailable, or was incompletely captured, the check executes fresh and reports a cache miss rather than a reused answer.

**Why this priority**: Safe reuse on unchanged inputs is the entire value of the feature; without miss-on-change enforcement, reuse would be unsound and the rest of the roadmap item is moot.

**Independent Test**: Run the same eligible check twice against an unchanged checkout and confirm the second run reuses the recorded result with provenance, then modify one declared input and confirm the third run is a cache miss that re-executes.

**Acceptance Scenarios**:

1. **Given** an eligible deterministic check whose declared inputs and source hashes are unchanged since a prior run, **When** a maintainer runs the check again, **Then** the run reuses the cached result and the run report states the original run and source of the reused result.
2. **Given** a changed declared input, **When** the check runs, **Then** the result is a cache miss and the check executes normally.
3. **Given** an input that cannot be hashed or was incompletely captured for a prior cache entry, **When** the check runs, **Then** the result is a cache miss; incomplete capture never qualifies for reuse.

---

### User Story 2 - Inspect, bound, and delete the cache (Priority: P2)

A maintainer can list what the project-local cache holds — what each entry is bound to, which run produced it, when it was created — enforce a bounded retention policy, and delete entries or the whole cache without affecting any authoritative run history or acceptance receipts.

**Why this priority**: An inspectable, deletable, bounded cache is what makes the optional capability safe to enable in a real project; without it, Story 1's reuse would be an opaque black box.

**Independent Test**: Populate the cache with several entries, list them with their bindings and provenance, apply the retention bound, delete one entry, and confirm run history and receipts are untouched.

**Acceptance Scenarios**:

1. **Given** one or more cache entries, **When** the maintainer inspects the cache, **Then** each entry shows its binding inputs, originating run, and creation metadata.
2. **Given** a retention bound, **When** entries exceed it, **Then** the oldest or expired entries are evicted per the stated policy and the eviction is visible in inspection output.
3. **Given** cache entries, **When** the maintainer deletes an entry or the cache, **Then** the deletion succeeds and no run record, receipt, or task state changes.

---

### User Story 3 - Never reuse what is not deterministic or not authoritative (Priority: P3)

Side-effecting commands, current approvals, and code-writing agent tasks are not reused by default, and a stale receipt never authorizes a new integrated checkout: reuse is confined to eligible deterministic checks and remains visibly distinct from acceptance evidence.

**Why this priority**: This is the safety rail that makes Stories 1-2 trustworthy; it is prioritized last only because it is exercised as refusal-by-default alongside the core reuse path rather than as a standalone journey.

**Independent Test**: Attempt reuse on a side-effecting command, an approval state, and a code-writing task, and verify each is excluded by default; present a stale receipt against a new checkout and verify it is not accepted.

**Acceptance Scenarios**:

1. **Given** a command classified as side-effecting or a task whose worker is a code-writing agent, **When** the run completes, **Then** no cache entry is created by default.
2. **Given** an existing cache entry, **When** a maintainer's current approval state would otherwise be satisfied by it, **Then** the approval is not granted from the cache entry.
3. **Given** a receipt recorded against a prior checkout, **When** a new integrated checkout is evaluated, **Then** the stale receipt does not authorize acceptance; acceptance continues to derive only from checks executed against that checkout.

---

### Edge Cases

- What happens when a tool version or environment identity cannot be determined for a run? The check is not eligible for reuse; the run proceeds uncached and reports why eligibility was denied.
- What happens when two concurrent runs race on the same cache key? One result is retained with its own provenance; a reader never observes a partially written entry.
- What happens when a cache entry's stored record is corrupt or unreadable? The entry is treated as a miss, quarantined or evicted, and the miss is reported.
- What happens when a maintainer disables the cache entirely? All checks execute; no entry is read or written, and no behavior differs from a cache-free run.
- What happens when an eligible check's output depends on something outside the declared inputs (for example a network resource)? That check is not deterministic under declared inputs and must not be marked eligible; if misclassified, a changed-outside input surfaces as a false reuse until eligibility is corrected — the report always names the original run so the reuse can be audited.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST cache results of eligible deterministic analysis or read-only checks, keyed by declared inputs, tool versions, environment identity, policy, and source hashes.
- **FR-002**: The system MUST treat any changed, unavailable, or incompletely captured binding input as a cache miss and MUST execute the check fresh in that case.
- **FR-003**: The system MUST record, on every reused result, the original run and source that produced it, and MUST surface that provenance in run reports.
- **FR-004**: The system MUST NOT reuse results for side-effecting commands, current approvals, or code-writing agent tasks by default.
- **FR-005**: The system MUST keep cache records separate from authoritative acceptance receipts; a cache entry MUST NOT serve as, replace, or upgrade an acceptance receipt, and a stale receipt MUST NOT authorize a new integrated checkout.
- **FR-006**: The system MUST provide project-local inspection of cache entries (bindings, provenance, age), a bounded retention policy with visible eviction, and deletion of single entries or the whole cache without mutating run history or task state.
- **FR-007**: The cache MUST be entirely optional and project-local; no cloud service, external database, or vector store may be required, and disabling the cache MUST leave all existing behavior intact.
- **FR-008**: The system MUST exclude from reuse any check whose inputs or environment cannot be fully captured, and MUST report the eligibility denial reason.

### Key Entities

- **Cache Entry**: A reusable result for one eligible check, bound to declared inputs, tool versions, environment identity, policy, and source hashes, with provenance pointing at the original run and source; never an acceptance receipt.
- **Eligibility Decision**: The recorded determination that a check is deterministic and fully capturable (or not), including the denial reason when reuse is refused.
- **Reuse Provenance**: The report-visible attribution of a reused result to its originating run and source.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In repeated identical runs of an eligible check, 100% of reused results in reports name their original run and source; zero reused results appear without provenance.
- **SC-002**: Changing, removing, or incompletely capturing any declared binding input forces a fresh execution in 100% of tested cases; zero stale results are reused across a changed input.
- **SC-003**: Side-effecting commands, approval states, and code-writing agent tasks produce zero cache entries by default across the test suite.
- **SC-004**: A maintainer can enumerate and delete all cache entries with documented commands, and deletion changes zero run records, receipts, or task states.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): new capability — a project-local content-bound cache; existing valid-memory reuse remains a separate capability and is presumed present but distinct, to be confirmed by inspecting the actual command path and tests before implementation.
- Lightweight boundary: optional project-local cache with explicit inspection, bounded retention, and deletion; no cloud, database, broker, or vector store; existing valid-memory reuse is out of scope and must not be replaced or merged into this cache.
- Competitor inspiration: Taskflow's project-scoped cross-run memoization is a hypothesis drawn from documentation, not measured behavior; this feature is scoped to what this codebase's checks and receipts can honestly support.
- Eligibility is opt-in per check or per task classification, defaulting to exclusion when classification is ambiguous; the plan must pilot reuse only with checks whose inputs are completely capturable, never with partially observable commands.
- Acceptance receipts, review verdicts, and integrated-checkout authority keep their current contracts unchanged; reuse never interacts with approval gates except to be refused by them.
