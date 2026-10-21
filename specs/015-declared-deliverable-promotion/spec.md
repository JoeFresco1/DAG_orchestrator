# Feature Specification: Declared Deliverable Checks and Controlled Promotion

**Feature Branch**: `015-declared-deliverable-promotion`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-15: declared deliverable checks and controlled promotion — extend existing ownership contracts, worktrees, and merge authority with an explicit declared-deliverable report; for non-Git artifacts, optionally stage outputs and promote them only after checks pass."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Surface unexpected writes and bind deliverables to the checked attempt (Priority: P1)

A maintainer runs a task whose spec declares its deliverables. When the run finishes, a declared-deliverable report compares what was actually written against what was declared: unexpected writes are surfaced before acceptance, and each declared deliverable is bound to the specific checked attempt and its evidence, so acceptance refers to exactly the files that were verified.

**Why this priority**: The deliverable report is the missing contract that makes existing ownership, worktrees, and merge authority auditable; it is the MVP for honest filesystem-effect visibility.

**Independent Test**: Run a task that writes one declared file and one undeclared file, and confirm the report flags the undeclared write and refuses to bind acceptance to the attempt until it is reconciled.

**Acceptance Scenarios**:

1. **Given** a task with declared deliverables, **When** the attempt finishes and only declared outputs were written, **Then** the report binds each deliverable to the checked attempt and its checks before acceptance completes.
2. **Given** a task whose attempt wrote a file outside its declared deliverables, **When** the report is generated, **Then** the unexpected write is surfaced before acceptance, and acceptance does not proceed until the write is declared, reverted, or explicitly reconciled.
3. **Given** an accepted attempt, **When** the deliverable report is inspected, **Then** every accepted deliverable names the attempt identity and the checks that passed against it.

---

### User Story 2 - Stage and promote non-Git artifacts only after checks pass (Priority: P2)

For work that produces non-Git artifacts, a maintainer optionally enables staged promotion: outputs are written to a staging area, checks run against the staged outputs, and promotion into the project happens only after checks pass. A rejected or interrupted promotion retains its staged evidence and reports a clear reconciliation status instead of leaving a half-promoted result silently in place.

**Why this priority**: Promotion safety depends on the report and binding from Story 1; it is the extension beyond Git deliverables and is only pursued where a real non-Git use case exists.

**Independent Test**: Enable staged promotion for one non-Git artifact, fail a check, and confirm nothing is promoted while the staged evidence and a reconciliation status remain available; then pass checks and confirm clean promotion.

**Acceptance Scenarios**:

1. **Given** staged promotion enabled for a non-Git deliverable, **When** checks pass against the staged outputs, **Then** the outputs are promoted and the report records the promotion as bound to that attempt.
2. **Given** a check failure against staged outputs, **When** promotion is evaluated, **Then** nothing is promoted, the staged evidence is retained, and the run reports a reconciliation status naming what remains staged.
3. **Given** a promotion interrupted mid-way, **When** the run state is inspected, **Then** the interruption is recorded with recoverable staged evidence and an explicit reconciliation status; the system never reports the deliverable as cleanly promoted.

---

### User Story 3 - State the enforcement level honestly (Priority: P3)

In every deliverable report and promotion result, the tool states whether its enforcement is validation, isolation, or actual filesystem authority, and never claims an operating-system sandbox it does not provide. A maintainer can tell at a glance what the guarantee does and does not cover.

**Why this priority**: Honest enforcement labeling protects every claim Stories 1-2 make; it ships as a labeling requirement on the same reports rather than as an independent journey.

**Independent Test**: Inspect deliverable and promotion outputs and confirm each names its enforcement level and makes no sandbox claim beyond what the tool actually enforces.

**Acceptance Scenarios**:

1. **Given** any deliverable report, **When** a maintainer reads it, **Then** the enforcement level (validation, isolation, or filesystem authority) is stated explicitly.
2. **Given** the tool does not provide an OS sandbox, **When** any output is produced, **Then** no message or report advertises sandboxing; unexpected-write detection is described at the level it is actually enforced.

---

### Edge Cases

- What happens when a task's declared deliverable list is empty? The report still runs and surfaces any writes made by the attempt, so undeclared side effects cannot hide behind an empty declaration.
- What happens when an unexpected write is itself required by a downstream task? The writer's task must declare it; downstream tasks never silently adopt undeclared files, preserving ownership contracts.
- What happens when staging cannot be set up for a non-Git artifact (for example the tool lacks authority over the destination path)? Promotion is refused up front with the enforcement level stated, rather than degrading to unpromoted writes.
- What happens when a rejected promotion's staged evidence exceeds retention bounds? Eviction follows the declared retention policy and the reconciliation status updates to evidence-expired rather than pretending the promotion completed.
- What happens on concurrent tasks writing the same declared path? Existing worktree isolation applies; promotion into the shared project respects merge authority and conflicts are reported as reconciliation failures.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST produce a declared-deliverable report per attempt that compares declared deliverables against actual writes, binding each deliverable to the checked attempt identity and its checks.
- **FR-002**: The system MUST surface unexpected (undeclared) writes before acceptance and MUST NOT complete acceptance until each unexpected write is declared, reverted, or explicitly reconciled.
- **FR-003**: For non-Git artifacts, the system MUST optionally stage outputs and promote them only after checks pass; failed or interrupted promotion MUST retain recoverable staged evidence and MUST report an explicit reconciliation status.
- **FR-004**: The system MUST state, in every deliverable and promotion result, whether enforcement is validation, isolation, or filesystem authority, and MUST NOT advertise an operating-system sandbox it does not provide.
- **FR-005**: The system MUST reuse the existing runner, worktree isolation, and merge authority for deliverable checking and promotion; it MUST NOT introduce a second scheduler, reviewer system, or state authority.
- **FR-006**: Git deliverables MUST be fully supported via the existing merge authority; non-Git promotion MUST be added only for an actual, demonstrated use case and MUST remain optional.
- **FR-007**: Deliverable binding MUST preserve ownership contracts: downstream tasks consume only declared deliverables, and a deliverable's binding survives retries by referring to the specific attempt that produced it.
- **FR-008**: All deliverable and promotion records MUST live in the existing project-local run state; no cloud service, external database, or message broker may be required.

### Key Entities

- **Declared Deliverable**: An output path or artifact a task commits to producing, bound to the task's ownership contract and to the attempt that produced it.
- **Deliverable Report**: Per-attempt evidence comparing declared deliverables to actual writes, listing unexpected writes, check results, and the stated enforcement level.
- **Promotion**: The optional, post-check step that moves staged non-Git outputs into the project under existing merge authority, with a recorded status of promoted, rejected, interrupted, or reconciled.
- **Reconciliation Status**: The explicit state of any unfinished promotion, naming retained staged evidence and what remains to be done.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of accepted attempts have a deliverable report binding every accepted deliverable to its attempt identity and checks; zero acceptances complete with an unresolved unexpected write.
- **SC-002**: Injected-failure tests show that every rejected or interrupted promotion retains staged evidence and reports a non-clean reconciliation status; zero interrupted promotions are reported as promoted.
- **SC-003**: Every deliverable and promotion output states its enforcement level in 100% of cases, and zero outputs claim an OS sandbox the tool does not provide.
- **SC-004**: Git-deliverable flows complete with no regression to existing merge and review contracts; non-Git promotion ships only alongside a named, tested use case.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring — ownership contracts, worktrees, and merge authority already exist per the constitution's proven contracts; the declared-deliverable report and optional non-Git promotion are the missing increments to be confirmed against actual command paths before implementation.
- Lightweight boundary: reuse of the existing runner and integration (merge) authority; no OS sandbox is provided or claimed; no second scheduler, reviewer system, or state authority; nothing required beyond CLI, project folder, and Git.
- Competitor inspiration: Taskflow's admitted filesystem-effect transactions are a hypothesis from documentation; this feature adopts only the declared-report and staged-promotion concepts that this codebase can enforce honestly.
- The roadmap directive "start with Git deliverables; add non-Git transactions only for an actual use case" is a precondition: planning MUST NOT schedule non-Git promotion work until a concrete use case is named and recorded in the spec during planning.
- Unexpected-write detection operates at the level the tool can actually enforce (for example worktree-scoped observation and declared-path binding), not at kernel level; the enforcement label must match the real mechanism.
