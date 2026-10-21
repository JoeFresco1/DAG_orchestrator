# Feature Specification: Terminal-Failure Dependency Edges

**Feature Branch**: `005-terminal-failure-edges`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-5: explicit completion and failure dependency conditions — edges that fire on success, failure, or any terminal outcome, used for diagnostic, cleanup, reporting, and escalation nodes, with documented semantics for cancellation, skip, and gate rejection."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a diagnostic node after its producer fails (Priority: P1)

A run author attaches a failure-conditional edge from a diagnostic task to a producer task. When the producer fails, the diagnostic task becomes ready and runs — collecting logs, inspecting state, or filing a report — without the failed output ever being treated as accepted input to the diagnostic work. Success-only dependents of the producer keep their current blocked-on-failure behavior.

**Why this priority**: This is the distinguishing capability — recovery-adjacent diagnostics that today cannot be expressed without hand-wiring; everything else extends this semantics.

**Independent Test**: Create a run whose producer fails on its first attempt, with a failure-conditional diagnostic dependent, and confirm the diagnostic runs exactly after the failure while ordinary dependents stay blocked.

**Acceptance Scenarios**:

1. **Given** a producer task and a dependent with a failure edge condition, **When** the producer fails and retries are exhausted, **Then** the dependent becomes ready and runs.
2. **Given** the same dependent, **When** the producer instead completes successfully, **Then** the failure-conditional dependent does not run (and any success-conditional dependents proceed as before).
3. **Given** the diagnostic dependent's inputs, **When** it runs after the producer's failure, **Then** the producer's failed output is not presented as accepted input; the dependent receives failure context, not acceptance.

---

### User Story 2 - CLI and viewer explain edge conditions and readiness (Priority: P2)

A maintainer inspecting a run sees, in both the CLI and the viewer, each non-default edge condition and its effect on readiness: which edges fire on success only, which on failure, which on any terminal outcome, and why a given task is or is not ready given its upstream outcomes.

**Why this priority**: Silent semantics breed wrong mental models; visibility is what makes the new edges trustworthy for real graphs.

**Independent Test**: Build a run with one edge of each condition, then query the CLI and open the viewer and confirm each edge's condition and its readiness effect are stated in both.

**Acceptance Scenarios**:

1. **Given** a run containing edges of each condition type, **When** the maintainer inspects a task's dependencies in the CLI, **Then** each dependency edge's condition is shown along with whether it currently blocks, fires, or is satisfied.
2. **Given** the same run, **When** the maintainer opens the viewer, **Then** non-default edge conditions are visually distinguished and explained, matching the CLI's descriptions.
3. **Given** a task that is not ready, **When** the maintainer asks why, **Then** the answer names the specific unsatisfied edge condition and its upstream task's outcome.

---

### User Story 3 - Cancellation, skip, and gate rejection have explicit edge semantics (Priority: P3)

The terminal outcomes of cancellation, skip, and gate rejection are classified and documented with respect to edge conditions: for each, it is explicit whether failure-conditional and any-terminal edges fire, and default success-only dependencies retain exactly their current behavior throughout.

**Why this priority**: These terminal kinds are the ambiguous cases; documenting and fixing their semantics prevents the feature from having holes while hardening the default path against regression.

**Independent Test**: For each of cancellation, skip, and gate rejection, run a small graph with failure-conditional and any-terminal dependents and verify behavior matches the documented classification; separately, verify a success-only graph behaves identically to before the feature.

**Acceptance Scenarios**:

1. **Given** a documented classification of cancellation, skip, and gate rejection, **When** any of these terminal outcomes occurs on a producer, **Then** its failure-conditional and any-terminal dependents behave exactly as documented.
2. **Given** a graph using only default (success) dependencies, **When** the run executes, **Then** readiness and scheduling behavior are unchanged from before edge conditions existed.
3. **Given** the documentation of edge semantics, **When** a maintainer reads it, **Then** every terminal outcome kind (success, failure, cancellation, skip, gate rejection) has a stated effect on each edge condition.

---

### Edge Cases

- What happens when a producer with both failure-conditional and success-conditional dependents fails? Failure-conditional dependents fire; success-conditional dependents remain blocked; the distinction is shown in CLI and viewer.
- What happens when a failure-conditional dependent itself fails? Its own edge conditions apply recursively; the graph does not special-case diagnostics.
- What happens when a task is skipped upstream and a failure-conditional dependent waits on it? Behavior follows the documented classification of skip; the dependent's readiness is computed from that classification, not treated as an error.
- What happens when an edge condition references an outcome the runner cannot distinguish (for example, a kill whose kind is unknown at recovery time)? The system maps it to the documented default terminal kind for recovery-interrupted work and states that mapping in the run record.
- What happens when a gate is rejected and an any-terminal cleanup node waits on the gated task? The cleanup node fires per its condition; the rejection reason remains available as failure context.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Dependency edges MUST support an explicit condition attribute with at least three values: success (the default), failure, and any terminal outcome.
- **FR-002**: Task readiness MUST be derived from edge conditions and upstream outcomes: a dependent becomes ready when its incoming edges' conditions are met per their respective outcomes.
- **FR-003**: A failure-conditional dependent MUST run after its producer's terminal failure without the producer's failed output being presented as accepted input to the dependent.
- **FR-004**: Any-terminal edges MUST fire on every terminal outcome kind, enabling cleanup, reporting, and escalation nodes.
- **FR-005**: Cancellation, skip, and gate rejection MUST each have an explicitly documented classification determining whether failure-conditional and any-terminal edges fire; the classification MUST be enforced consistently by the runner.
- **FR-006**: Edges with the default success condition MUST retain exactly the current readiness and scheduling behavior; the feature MUST NOT change behavior for graphs that use only default edges.
- **FR-007**: Both the CLI and the viewer MUST display each non-default edge condition and explain its effect on a task's readiness, including why a specific task is currently blocked.
- **FR-008**: The extension MUST remain a small addition to graph edge semantics; it MUST NOT introduce a general event bus, arbitrary triggers, or a second scheduling mechanism.

### Key Entities

- **Dependency Edge**: An ordered relation between two tasks carrying a condition attribute (success default, failure, or any terminal) that governs when the dependent becomes ready.
- **Edge Condition**: The predicate on an upstream task's outcome that fires an edge; evaluated only against terminal outcomes recorded by the runner.
- **Terminal Outcome Classification**: The documented mapping of each outcome kind (success, failure, cancellation, skip, gate rejection, recovery-interrupted kill) to which edge conditions it satisfies.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A diagnostic task with a failure-conditional edge runs after its producer's terminal failure in 100% of test runs, and the producer's failed output is never delivered to it as accepted input.
- **SC-002**: A graph composed solely of default success dependencies schedules and readies tasks identically to pre-feature behavior, verified on at least one existing multi-task run fixture.
- **SC-003**: 100% of non-default edges are visible with their condition and readiness effect in both the CLI and the viewer; zero non-default edges exist that the CLI cannot explain.
- **SC-004**: Every terminal outcome kind has a documented, implemented edge-condition classification, and behavior in tests matches the documentation for each of success, failure, cancellation, skip, and gate rejection.
- **SC-005**: No mechanism beyond edge conditions on graph dependencies is introduced; readiness remains a pure function of the graph, upstream outcomes, and conditions.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): new capability. Current scheduling treats a failed predecessor as blocking its dependents; edge conditions on terminal outcomes are expected to be absent, but planning must inventory the existing dependency and readiness model first, per the roadmap's own "if equivalent semantics are not already available" caveat, and implement only the missing increment.
- Lightweight boundary (from the roadmap): a small extension to graph semantics, not a general event bus.
- Competitor inspiration: Dagain's distinction between successful and terminal dependencies is a hypothesis from competitor documentation, not verified behavior; this spec defines semantics for this codebase on its own terms.
- Default success edges are the compatibility contract: any ambiguity during implementation is resolved in favor of preserving current success-only behavior.
- Failure-conditional dependents receive failure context (exit code, failure kind, logs) through the existing task context channels, not through a new data-flow mechanism.
