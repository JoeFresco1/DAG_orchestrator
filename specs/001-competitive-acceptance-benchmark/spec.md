# Feature Specification: Competitive Acceptance Benchmark

**Feature Branch**: `001-competitive-acceptance-benchmark`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P0-1: a reproducible competitive acceptance benchmark — fixed repository snapshots and specifications, compared against a single-agent baseline and selected orchestrators, scored by independent behavioral acceptance of the final integrated checkout."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run the benchmark suite and get an honest report (Priority: P1)

A maintainer points the benchmark suite at its fixed repository snapshots and specifications, runs Lightweight DAG and the defined baselines under recorded settings, and receives a report that scores each run by independent behavioral acceptance against the final integrated checkout. Incomplete runs are reported as incomplete, never as successes.

**Why this priority**: Without a trustworthy end-to-end run-and-score loop, no comparative claim is possible; this is the MVP that produces publishable evidence.

**Independent Test**: Execute the suite on one snapshot with Lightweight DAG and the single-agent baseline, then verify the report marks incomplete work as incomplete and attributes every scored task to its acceptance evidence.

**Acceptance Scenarios**:

1. **Given** the benchmark suite with fixed snapshots, **When** a maintainer runs it for one orchestrator configuration, **Then** a report is produced containing per-task success, integration success, human intervention, elapsed time, repair attempts, and observed cost or token usage, with unavailable measurements explicitly marked.
2. **Given** a run in which some tasks never finished, **When** the suite scores the run, **Then** unfinished tasks are counted as incomplete and the run's success rate reflects that.
3. **Given** a scored run, **When** the maintainer inspects any accepted task, **Then** the report shows the behavioral acceptance check that passed and the integrated source revision it ran against.

---

### User Story 2 - Compare Lightweight DAG against defined baselines (Priority: P2)

A maintainer runs the same snapshot set through Lightweight DAG, a single-agent baseline, and selected orchestrators with comparable worker settings, and publishes a comparison that names the comparison set, exact versions, models, harness settings, repetitions, and variance.

**Why this priority**: The comparative claim is the point of the suite, but it depends on the single-run loop from Story 1 working honestly first.

**Independent Test**: Run two or more systems on the same snapshot and confirm the report identifies each system's versions, settings, repetition count, and variance, and preserves failed attempts.

**Acceptance Scenarios**:

1. **Given** results for Lightweight DAG and at least one baseline, **When** the comparison view is generated, **Then** every column names the system, tested commit or version, model, harness version, and settings used.
2. **Given** a metric that could not be measured for one system, **When** the comparison is rendered, **Then** the cell reads as unavailable rather than being filled with a guess or zero.
3. **Given** repeated runs of the same configuration, **When** results are aggregated, **Then** the report shows repetition count and variance instead of a single run presented as definitive.

---

### User Story 3 - Preserve failed attempts and scenario coverage (Priority: P3)

The suite covers the scenario families that distinguish orchestrators — parallel independent edits, producer/consumer changes, integration defects, reviewer false positives, merge conflicts, provider failure, and interrupted execution — and retains failed attempts and stated limitations as part of the published record.

**Why this priority**: Scenario coverage and preserved failures make the benchmark resistant to cherry-picked demos; they harden evidence produced by Stories 1-2.

**Independent Test**: Inspect the suite's scenario catalog and a completed run's artifacts to confirm each scenario family is represented and failed attempts remain retrievable.

**Acceptance Scenarios**:

1. **Given** the benchmark catalog, **When** a maintainer reviews it, **Then** each scenario family from the suite definition is represented by at least one fixed snapshot with its specification.
2. **Given** a failed attempt within a scored run, **When** the published artifacts are inspected, **Then** the attempt and its failure reason are preserved alongside the final scores.
3. **Given** a limitation of the benchmark (for example, an unmeasurable cost), **When** the report is published, **Then** the limitation is stated in the report itself.

---

### Edge Cases

- What happens when a compared orchestrator cannot be installed or run in the benchmark environment? The system records it as not run with the reason, rather than omitting it silently or scoring it as zero.
- What happens when a behavioral acceptance check itself is flaky? The suite re-runs the check a defined number of times and reports the inconsistency instead of picking a favorable outcome.
- What happens when cost or token usage is not exposed by a harness? The report marks that measurement unavailable for that system and proceeds with the remaining metrics.
- What happens when a snapshot's specification is ambiguous enough that two workers solve it differently but validly? Acceptance is judged by the snapshot's behavioral checks, not by diff similarity.
- What happens when the benchmark is re-run after a tool upgrade? Results are stored per configuration identity; upgraded versions produce new entries rather than overwriting old ones.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a benchmark suite of fixed repository snapshots, each paired with a specification and independent behavioral acceptance checks that run against the final integrated checkout.
- **FR-002**: The suite MUST include at least one scenario from each family: parallel independent edits, producer/consumer changes, integration defects, reviewer false positives, merge conflicts, provider failure, and interrupted execution.
- **FR-003**: The system MUST support running each snapshot through Lightweight DAG, a single-agent baseline, and at least one selected orchestrator under comparable, recorded worker settings.
- **FR-004**: The system MUST score runs by independent behavioral acceptance of the integrated result; incomplete runs MUST be reported as incomplete and MUST NOT contribute to success counts.
- **FR-005**: The system MUST record, per run: exact repository snapshot, tool commit or version, model identifiers, harness versions, settings, repetition count, and variance for aggregated metrics.
- **FR-006**: The system MUST publish per-run metrics for task success, integration success, human intervention, elapsed time, repair attempts, and observed cost or token usage, marking any unavailable measurement explicitly.
- **FR-007**: The system MUST preserve failed attempts and benchmark limitations as part of the exportable report artifacts.
- **FR-008**: The benchmark MUST be runnable as an entirely local package that exports reports as files; it MUST NOT require a hosted telemetry service.

### Key Entities

- **Benchmark Case**: A fixed repository snapshot plus its specification, behavioral acceptance checks, and scenario family label.
- **Benchmark Run**: One execution of one case by one system configuration, including settings, repetitions, and per-task outcomes.
- **Comparison Report**: An exportable document binding runs to their configurations, metrics, unavailable measurements, failed attempts, and stated limitations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can execute the full suite on one system configuration with a single documented command and receive a complete report without manual data collation.
- **SC-002**: 100% of scored tasks in published reports trace to a behavioral acceptance result and an integrated source revision; zero unfinished tasks are counted as successes.
- **SC-003**: Every published comparison entry names its comparison set, versions, models, settings, repetitions, and variance; unavailable measurements appear as explicit "unavailable" entries in 100% of cases.
- **SC-004**: Failed attempts remain retrievable from published artifacts for 100% of runs that had them.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): new capability. No existing benchmark suite was found in the inspected code.
- The single-agent baseline is a capable coding agent operating on the same snapshots without any orchestrator; selected orchestrators are chosen and named per published comparison, not hardcoded as a permanent roster.
- Competitor capabilities come from documentation and selected source review, not independent measurement; the benchmark exists to replace documentation claims with observed results.
- Lightweight boundary: a separate benchmark package with exportable reports; no hosted service, no telemetry, no changes to core acceptance contracts.
- Cost measurement depends on what each harness exposes; the benchmark reports availability per system rather than requiring a uniform usage API.
