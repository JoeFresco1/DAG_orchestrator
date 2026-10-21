# Feature Specification: Run Timeline and Bounded Workflow Composition

**Feature Branch**: `016-run-timeline-composition`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P2-16: run timeline and bounded workflow composition — a timeline separating waiting, implementation, review, repair, merge, and gate time; reusable canonical plan fragments under one validated schema; conditional branches and bounded item expansion only where templates cannot express a real coding workflow cleanly."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See where a run's time actually went (Priority: P1)

A maintainer opens a run and sees a timeline that separates waiting, implementation, review, repair, merge, and gate time, derived from the run's recorded events. Durations add up to the observed run span, and any segment whose underlying events are missing is explicitly marked as such rather than silently zeroed or estimated.

**Why this priority**: The timeline is the first half of the roadmap item and the foundation everything else reasons about; it delivers value alone by making stalls, review queues, and repair loops visible.

**Independent Test**: Run a small graph with a forced failure and repair, then confirm the timeline reports distinct durations for implementation, review, repair, and waiting, and marks any segment with missing event data.

**Acceptance Scenarios**:

1. **Given** a completed run with recorded events, **When** the timeline view is generated, **Then** waiting, implementation, review, repair, merge, and gate durations are reported, each derived from recorded events.
2. **Given** a run whose event log is incomplete for some interval, **When** the timeline is rendered, **Then** the affected segments are explicitly marked as missing data; no duration is invented to fill a gap.
3. **Given** a task that failed and was retried, **When** the timeline is inspected, **Then** repair time is separated from implementation time for that task.

---

### User Story 2 - Compose runs from reusable canonical plan fragments under one schema (Priority: P2)

A maintainer authors a plan by assembling canonical, reusable plan fragments; templates, viewer authoring, and agent-generated plans all validate against the same schema before they can become executable tasks. A fragment that fails validation is rejected with named problems, whichever surface produced it.

**Why this priority**: One validated schema is the precondition for safe composition; it depends on nothing from Story 1 and can ship independently, but it is ranked P2 because the timeline delivers the roadmap's first observable win.

**Independent Test**: Submit the same fragment through template compilation, viewer authoring, and an agent-generated plan, and confirm all three are accepted or rejected identically by one validator with the same error messages.

**Acceptance Scenarios**:

1. **Given** a canonical plan fragment, **When** it is submitted via template compilation, viewer authoring, or agent generation, **Then** one validated schema judges it, and acceptance or rejection is identical across the three surfaces.
2. **Given** an invalid fragment, **When** validation runs, **Then** the rejection names the specific problems and the fragment does not enter the executable run.
3. **Given** an existing planning manifest, **When** it is compiled, **Then** its tasks retain their existing ownership, budgets, and amendment rules unchanged by the shared schema.

---

### User Story 3 - Add bounded branches and item expansion where templates fall short (Priority: P3)

Where a template cannot cleanly express a real coding workflow, a maintainer adds an optional conditional branch or a bounded item expansion. Optional branch failures are visible and cannot satisfy mandatory requirement acceptance, and expanded tasks preserve ownership, attempt identity, budgets, and stopped-amendment rules exactly as hand-authored tasks do.

**Why this priority**: Branches and expansion are additive expressiveness on top of validated fragments; they are last because templates cover most workflows and the roadmap demands they ship only where templates cannot express one cleanly.

**Independent Test**: Author a plan with one optional failing branch and mandatory requirements elsewhere, run it, and confirm the failure is visible, mandatory acceptance is unaffected, and expanded items behave like normal tasks under ownership, retries, and amendment rules.

**Acceptance Scenarios**:

1. **Given** a plan with an optional conditional branch whose condition selects a failing path, **When** the run completes, **Then** the branch failure is visible in run status and does not satisfy any mandatory requirement acceptance.
2. **Given** a bounded item expansion over a declared list, **When** expansion runs, **Then** each expanded task preserves ownership, attempt identity, budgets, and stopped-amendment rules of a normal task.
3. **Given** an unbounded or unvalidated expansion request, **When** the plan is validated, **Then** it is rejected with named problems rather than scheduled.

---

### Edge Cases

- What happens when a run's events are recorded but arrive out of order or duplicated? The timeline derives from event identity and timestamps with defined tie-breaking; anomalies are flagged rather than double-counted.
- What happens when a task has no events in some phase (for example review never started)? That segment reports zero duration with a "not entered" marker, distinguishable from missing data.
- What happens when a template fragment is edited after runs reference it? Prior runs keep their compiled snapshot; new runs validate the edited fragment under the same schema.
- What happens when a conditional branch depends on a review verdict that is later amended by repair? The branch condition evaluates the authoritative current verdict from run state, not a stale copy.
- What happens when an expansion would exceed task-count or budget bounds? Validation refuses the expansion with named problems before any task is scheduled.
- What happens when viewer authoring and template compilation disagree due to version skew? The shared schema version is recorded on each compiled plan, and plans compiled under an older schema version are re-validated or explicitly marked, never silently trusted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST derive run timelines from recorded events, separating waiting, implementation, review, repair, merge, and gate durations, and MUST explicitly mark any segment whose data is missing rather than inventing a duration.
- **FR-002**: Templates, viewer authoring, and agent-generated plans MUST validate against one shared schema; a fragment rejected by one surface MUST NOT be accepted by another, and rejections MUST name the specific problems.
- **FR-003**: The system MUST support reusable canonical plan fragments that compile into the existing planning-manifest and task contracts without changing ownership, budgets, or amendment rules.
- **FR-004**: The system MUST support optional conditional branches whose failures are visible in run status and MUST NOT satisfy mandatory requirement acceptance.
- **FR-005**: The system MUST support bounded item expansion in which each expanded task preserves ownership, attempt identity, budgets, and stopped-amendment rules; unbounded expansions MUST be rejected at validation.
- **FR-006**: The DAG core and CLI MUST remain the sole authoritative scheduler and state store; branches, fragments, and expansions MUST NOT introduce a second scheduler, chat subsystem, agent-persona marketplace, Postgres, or remote daemon.
- **FR-007**: Conditional branches and item expansion MUST be enabled only where templates cannot express the workflow cleanly, and their use MUST be visible in the compiled plan.

### Key Entities

- **Timeline Segment**: A phase-level duration (waiting, implementation, review, repair, merge, gate) derived from recorded run events, carrying either a computed duration or an explicit missing-data marker.
- **Plan Fragment**: A reusable, canonical unit of plan content (tasks, dependencies, budgets) validated by the shared schema and compilable into existing planning manifests.
- **Shared Plan Schema**: The single validation contract all authoring surfaces — templates, viewer, agents — must pass, versioned and recorded on each compiled plan.
- **Branch**: An optional conditional path in a compiled plan whose failure is recorded but cannot satisfy mandatory acceptance.
- **Expansion**: A bounded, validated fan-out that materializes ordinary tasks from a declared item list under existing task contracts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of completed runs with recorded events, the timeline reports all six phase durations derived from those events, and every gap is explicitly marked as missing data; zero durations are fabricated.
- **SC-002**: The same fragment submitted through template compilation, viewer authoring, and agent generation produces identical validation outcomes in 100% of test cases under the one shared schema.
- **SC-003**: Injected-failure tests show optional branch failures are visible in run status and change zero mandatory acceptance outcomes across all cases.
- **SC-004**: Expanded tasks pass the same ownership, attempt-identity, budget, and amendment checks as hand-authored tasks in 100% of expansion tests; zero unbounded expansions reach scheduling.
- **SC-005**: No run requires any service beyond the CLI, project folder, Git, and installed worker tools; the compiled plan remains fully inspectable as project-local state.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring — run events and planning manifests already exist per the proven contracts, but phase-separated timeline composition, the single shared fragment schema, branches, and bounded expansion are missing increments, to be confirmed by inspecting actual command paths and tests before implementation.
- Lightweight boundary: the DAG core and CLI stay authoritative; no required chat subsystem, agent-persona marketplace, Postgres, or remote daemon; timeline, fragments, branches, and expansion are optional project-local capabilities layered on existing state.
- Competitor inspiration: Dagents' live trace views, shared node catalog, branches, and subflows are hypotheses from documentation; only the timeline, single-schema composition, and bounded branch/expansion concepts are adopted, scoped to what this codebase can enforce.
- The roadmap directive to add conditional branches or bounded item expansion "only where templates cannot express a real coding workflow cleanly" is an explicit precondition: planning MUST justify each branch or expansion against a named workflow a template cannot express, and MUST NOT ship them as default authoring conveniences.
- Timeline phases map to existing recorded event kinds (task start/finish, review verdicts, repair requeues, merge steps, gate opens/approvals); where an event kind does not yet exist, the segment is marked missing-data until the event is recorded, not approximated.
