# Feature Specification: Crash-Recovery Certification

**Feature Branch**: `002-crash-recovery-certification`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P0-2: crash-consistent recovery certification — inject process termination at consequential boundaries and recover through supported commands, preserving accepted work, attribution, and history, with ambiguous external effects reconciled rather than blindly repeated."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Certify recovery by killing workers at every consequential boundary (Priority: P1)

A maintainer runs a certification campaign that terminates processes at each consequential boundary — worker launch, result capture, verdict persistence, commit, merge, and finalization — and then recovers through the supported recovery commands. After recovery, accepted work, attempt and budget history, and salvageable failed-work artifacts are intact, and the run converges without manual file surgery.

**Why this priority**: The reliable-execution documentation distinguishes stage replay tests from a full crash campaign; this story is the campaign itself and the MVP that converts documented recovery into demonstrated recovery.

**Independent Test**: Run a small multi-task run under the campaign with a kill injected at each of the six boundaries, recover via the supported commands, and verify accepted tasks, attempt history, and salvage artifacts survive each kill.

**Acceptance Scenarios**:

1. **Given** a running execution with injected termination at worker launch, **When** the maintainer recovers through supported commands, **Then** accepted completed tasks remain completed, the interrupted task is requeued or resumable, and no accepted result is lost.
2. **Given** injections at result capture, verdict persistence, commit, merge, and finalization, **When** recovery completes for each, **Then** attempt counts, retry and timeout history, and budget consumption recorded before the kill remain accurate afterward.
3. **Given** a task that failed before the kill with salvageable artifacts, **When** the run is recovered, **Then** the failed work's salvage remains retrievable and the failure reason is preserved.

---

### User Story 2 - Recovered state is protected and every accepted task stays attributable (Priority: P2)

After a crash and recovery, Git state is reconciled with the durable run records: every accepted task remains attributable to its evidence and its commit, and a worker that was interrupted before the kill can never later overwrite the recovered state — a late-exiting process, a stale worktree, or a delayed write.

**Why this priority**: Attribution and overwrite protection are what make recovery trustworthy rather than merely convenient; they depend on Story 1's campaign surfacing the real races.

**Independent Test**: Kill a worker mid-task, recover, complete the task through a fresh attempt, then resume the orphaned process path (or simulate its late writes) and confirm recovered records and commits are unchanged.

**Acceptance Scenarios**:

1. **Given** a recovered run in which a task was accepted, **When** the maintainer inspects the task, **Then** the accepted result references its evidence and the commit it was integrated in.
2. **Given** an interrupted worker whose process exits after recovery has requeued its task, **When** the worker's late result arrives, **Then** the recovered state is not overwritten and the late result is recorded as stale or discarded per the recovery protocol.
3. **Given** a crash during merge or finalization, **When** recovery runs, **Then** the working tree and integration branch are reconciled with the durable records so that Git state and recorded state agree.

---

### User Story 3 - Ambiguous external effects enter reconciliation instead of silent repetition (Priority: P3)

When a crash occurs at a boundary where a worker's external command may or may not have taken effect — for example a kill between command dispatch and result capture — recovery routes that work into an explicit reconciliation step or an explicit intervention prompt, instead of blindly re-running the command.

**Why this priority**: Blind repetition of arbitrary commands is the dangerous failure mode; reconciliation protects correctness after the core campaign (Stories 1-2) already preserves state.

**Independent Test**: Kill a worker after its command was dispatched but before the result was captured, recover, and confirm the task enters reconciliation or explicit intervention rather than an automatic re-run.

**Acceptance Scenarios**:

1. **Given** a kill injected between command dispatch and result capture, **When** recovery processes the task, **Then** the task is marked ambiguous and routed to reconciliation or explicit intervention, and the command is not silently re-executed.
2. **Given** a task in reconciliation, **When** the maintainer resolves it, **Then** the resolution is recorded and the run proceeds with an explicit human decision in the history.
3. **Given** a kill at a boundary with no external side effects (for example, before launch), **When** recovery runs, **Then** the task is safely requeued without entering reconciliation.

---

### Edge Cases

- What happens when the crash campaign is interrupted itself? Completed injection iterations are retained; the campaign reports which boundaries were exercised and which were not, rather than claiming full coverage.
- What happens when recovery finds a commit on the integration branch with no matching durable record? The run enters explicit intervention; the commit is neither adopted nor discarded silently.
- What happens when an orphaned worker holds a worktree lock after recovery? The supported orphan-reaping path breaks the lock and records the reap; recovery does not stall indefinitely.
- What happens when repeated injections at the same boundary produce different outcomes (sometimes captured, sometimes lost)? All observed outcomes are recorded; certification requires that every outcome preserves accepted work and attribution, not that outcomes be identical.
- What happens when the local durable store itself is unreadable after a kill? Recovery fails closed with an explicit error and does not mark any task accepted on partial state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support a certification campaign that injects process termination at each consequential boundary: worker launch, result capture, verdict persistence, commit, merge, and finalization.
- **FR-002**: After each injected kill, recovery MUST be performable exclusively through supported recovery commands; the campaign MUST NOT require hand-editing of durable state.
- **FR-003**: Recovery MUST preserve all previously accepted work, attempt and budget history, and salvageable failed-work artifacts.
- **FR-004**: Every accepted task MUST remain attributable to its acceptance evidence and the commit in which it was integrated after recovery.
- **FR-005**: A worker interrupted by a kill MUST NOT be able to overwrite recovered state when it later exits or flushes delayed writes; late results are recorded as stale or discarded per the recovery protocol.
- **FR-006**: Recovery MUST reconcile Git state (working tree, worktrees, integration branch) with the durable run records so the two agree after recovery.
- **FR-007**: Work whose external command may or may not have taken effect at the time of the kill MUST be routed to explicit reconciliation or explicit intervention; the system MUST NOT blindly repeat such commands.
- **FR-008**: The campaign MUST report which injection boundaries were exercised, the outcomes observed, and any boundaries not exercised; incomplete campaigns MUST be reported as incomplete.
- **FR-009**: The certification MUST run entirely locally against the project's durable store and Git repository; it MUST NOT promise exactly-once execution of arbitrary external commands.

### Key Entities

- **Injection Boundary**: One of the six consequential process boundaries (launch, result capture, verdict persistence, commit, merge, finalization) at which the campaign can terminate a process.
- **Certification Campaign**: A structured execution of injected kills across boundaries, recording per-iteration outcomes, recovery actions, and coverage of each boundary.
- **Reconciliation Outcome**: The disposition of work with ambiguous external effects after recovery: reconciled automatically, explicitly intervened by a human, or safely requeued — never silently repeated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A single documented campaign command exercises all six injection boundaries on a representative multi-task run and produces a coverage report; unexercised boundaries are explicitly marked, never claimed.
- **SC-002**: Across all injected kills in a completed campaign, 100% of previously accepted tasks remain accepted with intact evidence references and commit attribution; zero accepted results are lost or altered.
- **SC-003**: In 100% of injected kills, attempt and budget history recorded before the kill remains accurate after recovery, and salvageable failed-work artifacts remain retrievable.
- **SC-004**: 100% of tasks with ambiguous external effects land in an explicit reconciliation or intervention record; zero are silently re-executed.
- **SC-005**: No post-recovery inspection finds Git state (integration branch or worktree contents) disagreeing with the durable records for any accepted task.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring. Recovery, resume, retry, and orphan-reaping commands already exist and are documented; what is missing is the injected-failure certification campaign and the overwrite/race hardening it exposes, not a new recovery system.
- Lightweight boundary (from the roadmap): strengthen the existing local store and recovery protocol; do not promise exactly-once execution for arbitrary external commands.
- No competitor inspiration is claimed for this feature; it exists to satisfy the constitution's requirement that recovery features be certified by injected-failure tests, not unit tests alone.
- Precondition: the campaign must inventory which recovery commands and durable-record fields already exist (per the classification above) and build on them rather than introducing a parallel recovery path.
- Ambiguity detection assumes boundaries can be distinguished as side-effect-free (safe to requeue) versus consequential (possible external effect); boundary classification is defined by the campaign configuration, not inferred at runtime from arbitrary command output.
