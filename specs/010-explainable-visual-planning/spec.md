# Feature Specification: Explainable Visual Planning and Templates

**Feature Branch**: `010-explainable-visual-planning`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P2-10: enhance the existing viewer with dependency explanations, critical-path and blocker views, budget visibility, evidence links, and templates for common coding workflows; graph editing stays optional; optional local viewer with full CLI parity and no separate workflow format."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand why any node is not moving (Priority: P1)

An operator opens the viewer (or runs the equivalent CLI command) while a run is in progress and sees, for every node that is not ready, a concrete explanation: which prerequisite tasks are unfinished and in what state, which approval gate is unanswered and what it asks, which resource limit (concurrency, worktree budget) is saturated and at what usage, or which planning hold (plan phase pending or failed) is stopping launch. A blocker view groups stalled work by blocking reason, and a critical-path view names the longest dependency chain so the operator knows which tasks actually gate the run.

**Why this priority**: Diagnosing stalls is the daily job of an orchestrator operator; an unexplained "blocked" badge is the single largest source of guesswork. This story is the MVP — it delivers value with no editing and no templates.

**Independent Test**: Build a run containing a failed prerequisite, an unanswered gate, a concurrency-limited task, and a task whose plan phase has not finished; confirm each shows its specific explanation in the viewer and that the same explanations are reproducible from a documented CLI command.

**Acceptance Scenarios**:

1. **Given** a task whose prerequisite is still running or failed, **When** the operator inspects the node, **Then** the explanation names the specific predecessor task ids and their current statuses.
2. **Given** a task held by an unanswered gate, **When** the operator inspects the node, **Then** the explanation shows the gate question and its approval state, and changes once the gate is approved.
3. **Given** a task not launching because the concurrency limit is reached, **When** the operator inspects the node, **Then** the explanation names the resource limit and its current usage against the limit.
4. **Given** a task waiting on a pending or failed planning phase, **When** the operator inspects the node, **Then** the explanation states the planning hold and the plan phase status rather than a generic blocked label.
5. **Given** a run with several blocking reasons, **When** the operator opens the blocker view, **Then** tasks are grouped by blocking reason category and the critical-path view names the tasks on the longest dependency chain.

---

### User Story 2 - See budgets and evidence without leaving the run (Priority: P2)

An operator watching a run sees budget visibility per task and per run — retries, timeout, silence limits, elapsed time against those limits — and evidence links from each task to its real local artifacts: attempt logs, review verdicts, diffs, receipts, and plan output. Where a value or artifact is not available (a harness reported no usage, a log was pruned), the viewer marks it unavailable instead of showing an empty or invented value.

**Why this priority**: Budget and evidence visibility builds directly on Story 1's explanations and makes the viewer the place where acceptance evidence is inspectable; it is valuable but not required to diagnose a stall.

**Independent Test**: Open a run with completed, running, and pruned-log tasks; confirm limits and elapsed values render per task, artifact links open the underlying local files, and missing artifacts are labeled unavailable.

**Acceptance Scenarios**:

1. **Given** a task with retries, timeout, and silence settings, **When** the operator inspects it, **Then** the budget panel shows each configured limit and the elapsed value against it.
2. **Given** a task whose harness reported no cost or usage, **When** the budget panel renders, **Then** the cost reads as unavailable rather than zero or blank.
3. **Given** a completed task with attempts, review verdicts, and receipts, **When** the operator follows its evidence links, **Then** each link resolves to the actual local artifact it names.
4. **Given** a task whose attempt log was pruned, **When** the operator follows its evidence link, **Then** the link is explicitly marked unavailable instead of failing silently.

---

### User Story 3 - Start from a template and refine safely (Priority: P3)

A maintainer picks a template for a common coding workflow (for example, spec → plan → implement → review → verify), compiles it through the same validation the CLI uses, and gets a normal run file. If the run file is not locked, the maintainer may optionally adjust the graph in the viewer — adding a dependency, editing a brief — and every such edit is refused, with the lock holder named, while a run is active; once a run is stopped, edits follow the existing stopped-amendment rules.

**Why this priority**: Templates and editing accelerate setup but depend on Stories 1-2 (a trustworthy view) and are explicitly optional in the roadmap; a product is viable without them.

**Independent Test**: Compile a template and confirm the resulting manifest passes the CLI's existing validation unchanged; then attempt a viewer edit during an active run and confirm it is refused with the lock holder named.

**Acceptance Scenarios**:

1. **Given** a template for a common coding workflow, **When** the maintainer compiles it, **Then** the output is the same manifest format the CLI validates and runs, with no second graph format introduced.
2. **Given** a template whose tasks violate the decomposition budget, **When** compilation runs, **Then** it fails with the same validation errors the CLI reports for a hand-authored manifest, and no run file is created.
3. **Given** an active run holding the lock, **When** the maintainer attempts a graph edit in the viewer, **Then** the edit is refused and the refusal names the lock holder.
4. **Given** a stopped run, **When** the maintainer edits the graph in the viewer, **Then** the edit is applied under the existing stopped-amendment rules and is equally possible through the CLI.

---

### Edge Cases

- What happens when a node is blocked by several reasons at once (failed prerequisite plus unanswered gate)? The explanation lists every applicable reason; the blocker view assigns the node to each matching group.
- What happens when a template compiles but produces a cycle or an oversized task? The compile fails with the CLI's existing validation errors, and the viewer shows those errors verbatim.
- What happens when the viewer is never started? Every explanation, view, and edit introduced by this feature remains reachable through a documented CLI command; the viewer adds nothing that is required only in the browser.
- What happens when a run's sidecar history was rotated or pruned? Explanations state which inputs are missing (for example, "plan output pruned") rather than inferring a reason.
- What happens when an edit races the runner acquiring the lock? The edit loses: the lock check runs immediately before the write, and a lost race is reported as a locked refusal, never a silent partial write.
- What happens when a budget or usage figure was never recorded for a task? The panel shows unavailable for that field only; the remaining fields still render.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: For every node that is not ready to run, the system MUST display an explanation that names at least one concrete blocking reason category — unmet prerequisite (with predecessor task ids and statuses), unapproved gate (with its question), resource limit (with limit and current usage), or planning hold (with plan phase status).
- **FR-002**: Every explanation and view introduced by this feature MUST be available through the CLI with the same content the viewer shows; the viewer is optional and MUST NOT be the sole path to any of them.
- **FR-003**: The system MUST provide a blocker view that groups non-ready tasks by blocking reason category and a critical-path view that names the tasks on the longest dependency chain of the current run.
- **FR-004**: The system MUST show budget visibility per task and per run — configured retries, timeout, and silence limits with elapsed values — marking any figure that was never recorded as unavailable.
- **FR-005**: The system MUST link each task to its local evidence artifacts (attempt logs, review verdicts, diffs, receipts, plan output) and MUST mark a link whose target is missing as unavailable rather than dropping it.
- **FR-006**: Templates MUST compile into the same manifest format the CLI validates and runs, passing the identical validation rules; an invalid template MUST surface the same errors a hand-authored manifest would.
- **FR-007**: The system MUST NOT introduce a separate workflow format or a second graph representation that the runner reads directly; templates are an input to the existing manifest path.
- **FR-008**: Viewer-initiated graph edits MUST be refused while a run is active, with the refusal naming the lock holder, and MUST otherwise follow the existing stopped-amendment rules; edits MUST NOT bypass the run file lock.
- **FR-009**: Graph editing MUST remain optional: the run is fully operable (inspect, explain, compile, amend) without ever entering an edit mode.

### Key Entities

- **Workflow Template**: A named, reusable input for a common coding workflow (brief structure and task skeleton) that compiles through the existing manifest validation; carries its compile result, never a parallel executable format.
- **Node Explanation**: The blocking account for one node — reason categories, referenced task ids/gates/limits/plan phases, and the availability state of any input it depends on.
- **Evidence Link**: A reference from a task to one local artifact (log, verdict, diff, receipt, plan output) with an availability state of available or unavailable.
- **Budget Snapshot**: Configured limits and elapsed values for a task or run, field by field, each independently marked recorded or unavailable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of non-ready nodes rendered in a run display at least one concrete explanation; zero nodes appear as blocked with only a generic label.
- **SC-002**: Every explanation, view, and template operation added by this feature is reproducible from a documented CLI command — parity verified for 100% of the feature's user-visible operations.
- **SC-003**: 100% of templates either produce a manifest that passes the CLI's existing validation unchanged or fail with the same validation errors the CLI reports; zero template-specific acceptance paths exist.
- **SC-004**: 100% of graph edit attempts made while a run is active are refused with the lock holder named, and inspection of the run file afterward shows zero edits applied.
- **SC-005**: 100% of evidence links and budget figures that lack underlying data are explicitly marked unavailable in the viewer and CLI rather than being omitted or shown as zero.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs usability work. The viewer (`dag serve` / `dag launch`), the stuck/dependency description helpers, and plan validation already exist; the missing increment is the presentation of explanations, template compilation entry points, and lock-aware editing on top of them.
- Lightweight boundary (from the roadmap): optional local viewer with full CLI parity; no separate workflow format; no required cloud, account, database, or background service — the viewer stays an optional capability.
- Competitor inspiration (Dagents' workflow canvas and reusable flows; Dagain's operator controls) is a hypothesis until verified against this codebase; only the explainability and template ideas are taken, not a canvas-first interaction model.
- Graph editing is explicitly optional per the roadmap; the MVP is explanations plus read-only views, and editing ships only if it can honor the existing lock and amendment rules unchanged.
- Templates are authored as local project files compiled through the existing manifest validation; template storage, discovery, and naming stay inside the project folder with no registry service.
