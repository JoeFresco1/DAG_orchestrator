# Feature Specification: Integration Acceptance Boundary

**Feature Branch**: `009-integration-acceptance-boundary`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-9: a stronger integration acceptance boundary — targeted composed checks after relevant merges with preserved producer attribution, pre-launch dependency-visibility and file-overlap previews, and no passing local check presented as proof that the combined application passes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Composed checks prove merged compatibility with producer attribution (Priority: P1)

After tasks contributing to one area merge into the integration branch, the existing integration node runs targeted composed checks against the integrated result. When one fails, the report names the failing composed check, its evidence, and the producing tasks whose accepted outputs are implicated — and a passing local check from any producer is displayed as local evidence only, never as proof that the combined application passes.

**Why this priority**: This is the boundary itself — independently accepted tasks proving compatibility; without it, integration claims are unearned and downstream work consumes unverified combinations.

**Independent Test**: Create two tasks that are individually accepted but conflict when combined, wire an integration node over them, and confirm the composed check fails while naming both producers and the failing check.

**Acceptance Scenarios**:

1. **Given** tasks merged into the integration branch, **When** the integration node runs, **Then** composed checks execute against the integrated result and their results are recorded as integration evidence.
2. **Given** a composed check failure, **When** the result is reported, **Then** the failing check, its evidence, and the producing task identifiers with their acceptance verdicts are preserved.
3. **Given** a producer whose local checks passed, **When** integration results are displayed, **Then** the local pass is labeled local and only composed-check results support any claim about the combined application.

---

### User Story 2 - Route bounded repair without losing unrelated accepted work (Priority: P2)

An integration failure requeues only the implicated producers and the integration node through the existing repair rounds; unrelated tasks that were already accepted keep their accepted status, evidence, and receipts. Downstream tasks are scheduled against the accepted integrated prerequisites rather than pre-merge outputs.

**Why this priority**: Repair is the recovery path for the boundary, and it depends on Story 1's attribution to know what to requeue; mis-attributed repair would discard good work.

**Independent Test**: Inject an integration failure, run repair rounds, and confirm only the implicated producers and the integration node are requeued while unrelated accepted tasks remain accepted.

**Acceptance Scenarios**:

1. **Given** an integration failure attributed to specific producers, **When** repair rounds run, **Then** those failed producers and the integration node are requeued and unrelated tasks remain untouched.
2. **Given** repair succeeds within its rounds, **When** the integration node completes, **Then** downstream tasks consume the accepted integrated prerequisites instead of individual pre-merge outputs.
3. **Given** repair rounds exhausted, **When** the run reports, **Then** the failure and its attribution remain in history with previously accepted unrelated work intact.

---

### User Story 3 - Preview dependency visibility and file-overlap risk before launch (Priority: P3)

Before launch, a maintainer sees which tasks will be composed together and where independent tasks overlap on the same files, so composition surprises and edit collisions are visible while they are still cheap to fix.

**Why this priority**: Prevention reduces how often the Story 1-2 failure and repair loop runs, but it is additive on top of a working boundary, so it comes last.

**Independent Test**: Construct two independent tasks that touch the same files and run the preview, then confirm the overlap is reported with shared paths and the composition groups are listed.

**Acceptance Scenarios**:

1. **Given** a run containing integration nodes, **When** the preview is produced, **Then** composition groups listing which tasks feed which integration node are shown.
2. **Given** two independent tasks touching the same files, **When** the preview runs, **Then** the overlap is reported naming the shared paths.
3. **Given** no overlap between independent tasks, **When** the preview runs, **Then** it explicitly reports that no overlap was detected rather than showing nothing.

---

### Edge Cases

- What happens when a composed check is flaky and gives inconsistent results? The system re-runs it a defined number of times and reports the inconsistency as inconclusive; an inconclusive composed check is never recorded as a pass.
- What happens when a worktree merge conflicts during integration? The existing redo-on-new-base rounds apply, and only after those rounds are exhausted does the task fail, with attribution preserved either way.
- What happens when a failure stems from the interaction of three or more producers rather than one? All implicated producers are named with the interaction noted; the report never guesses a single owner.
- What happens when an integration node covers only one task, so nothing is really composed? Its result is still labeled as an integration check, and single-producer local passes remain labeled local.
- What happens when a downstream task could consume a producer's pre-merge output because its dependency omits the integration node? The preview flags the missing integration dependency before launch.
- What happens when a producer's local check passes but the composed check fails? Both results are displayed distinctly; only the composed failure governs the integration node's outcome.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: For integration nodes covering merged tasks, the system MUST run targeted composed checks against the integrated result after the relevant merges and record their results as integration evidence.
- **FR-002**: A composed-check failure MUST preserve producer attribution — the failing check, its evidence, and the implicated producing task identifiers with their acceptance verdicts — and retain it across retries and repair.
- **FR-003**: An integration failure MUST route through the existing bounded repair mechanism, requeuing only the implicated failed producers and the integration node; unrelated accepted work MUST remain accepted.
- **FR-004**: Downstream tasks MUST be scheduled against accepted integrated prerequisites rather than the pre-merge outputs of individual producers.
- **FR-005**: A pre-launch preview MUST show composition groups (dependency visibility) and file-overlap risk between tasks, reporting overlap state explicitly, including a "no overlap detected" result.
- **FR-006**: Reporting MUST distinguish local per-task check results from composed integration results, and a passing local check MUST NOT be presented as proof that the combined application passes.
- **FR-007**: The feature MUST extend the existing integration nodes, review and repair machinery, and event history without introducing a second scheduler, reviewer system, or persistent-state authority.

### Key Entities

- **Composed Check**: A check executed against the integrated result of merged tasks, distinct from any producer's local checks, whose result is the only basis for a combined-application claim.
- **Integration Evidence**: The record binding a composed-check result to its integrated revision, the producing tasks, and their acceptance verdicts.
- **Overlap Preview**: The pre-launch listing of composition groups and file overlaps among tasks, including explicit "no overlap detected" outcomes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of composed-check failures name the failing check and at least one producing task identifier with its acceptance verdict.
- **SC-002**: In an injected incompatibility test where two tasks are individually accepted but conflict when combined, 0 incompatibilities pass silently — each is caught by a composed check or reported inconclusive.
- **SC-003**: After bounded repair of an injected integration failure, 0 previously accepted unrelated tasks lose their accepted status.
- **SC-004**: The pre-launch preview is produced for 100% of runs containing integration nodes, listing composition groups and reporting overlap state explicitly, including "no overlap detected".
- **SC-005**: 0 report surfaces present a passing local check as combined proof — every combined-application claim traces to a composed-check result.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring. Integration nodes (`dag review --of`), repair rounds, worktree merge machinery, and graph lint warnings already exist, but post-merge composed checks, attribution-preserving failure reporting, and a pre-launch overlap preview do not appear on the inspected command surface. Confirm by inspecting tests and command paths before implementing.
- Lightweight boundary: existing integration nodes and repair mechanisms, with better contracts and reporting; no new scheduler, reviewer system, or state authority.
- No competitor is named for this roadmap item; the opportunity is framed internally, so no competitor claim is carried into this specification.
- Precondition: inventory the existing integration, repair, and lint command paths first — the roadmap's opportunity statement assumes this machinery exists, and the smallest increment extends it rather than replacing it.
- Composed check content is authored per run or project like existing check commands; the feature reports their results and attribution but does not invent check content automatically.
