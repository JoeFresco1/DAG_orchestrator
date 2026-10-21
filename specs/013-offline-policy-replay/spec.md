# Feature Specification: Offline Policy Replay and Decision Explanation

**Feature Branch**: `013-offline-policy-replay`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-13: evaluate a copy of a recorded run under alternative review thresholds or budget policies without executing commands, add explanations for why a worker launched, a reviewer was selected, evidence was rejected, or repair was requested, keep replay mutation-free, distinguish recorded-fact conclusions from live-rerun cases, and identify policy version and actual evidence in every explanation — after first inventorying current audit/replay capabilities to avoid duplication."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Replay a recorded run under a different policy without running anything (Priority: P1)

A maintainer takes a completed (or stopped) run and asks: what would our review-threshold or budget policy have done here? The system evaluates a copy of the recorded run under the alternative policy supplied for the invocation, using only the run's existing local events, and prints the divergences — which tasks would have launched differently, which reviews would have been skipped or added, which budgets would have been exceeded. No worker is launched, no command is executed, the original run file and sidecar are untouched, and no acceptance evidence is created. Every conclusion is marked either supported by recorded facts or requiring a live rerun.

**Why this priority**: This is the roadmap's P1 item and the safety property everything else rests on — a replay that can execute or mutate is not a replay. This story is the MVP.

**Independent Test**: Compute a checksum of a run's file and sidecar, replay it under an alternative threshold, and confirm the checksums are unchanged, no worker process spawned, no new events appended, and each conclusion carries a support marking.

**Acceptance Scenarios**:

1. **Given** a recorded run with its event history, **When** the maintainer replays it under an alternative review threshold, **Then** the output lists the decisions that would differ, each marked supported by recorded facts, without executing any task command.
2. **Given** a run being replayed, **When** the replay finishes, **Then** the original run file and sidecar state are byte-for-byte unchanged and no acceptance evidence has been created.
3. **Given** a conclusion that depends on data never recorded (for example, a counterfactual worker behavior), **When** the output is produced, **Then** it is explicitly marked as requiring a live rerun instead of being asserted.
4. **Given** a budget policy variant, **When** the replay evaluates recorded attempts against it, **Then** exceedances are reported with the recorded figures that triggered them, and figures that were never recorded are marked unavailable.

---

### User Story 2 - Explain why recorded decisions happened (Priority: P2)

A maintainer reviewing a past run asks four kinds of question: why did that worker launch, which reviewer was selected and on what basis, why was that evidence rejected, and why was repair requested? For each, the system produces an explanation that names the policy version in effect and the actual evidence (events, verdicts, receipts) the decision relied on, reading directly from the run's recorded history.

**Why this priority**: Explanations are read-only use of the same recorded history replay uses, so they are lower risk and lower urgency than the replay engine, but they are what makes replay results trustworthy to a human.

**Independent Test**: Pick one recorded instance of each decision type and confirm its explanation names a policy version and cites specific recorded evidence, or explicitly states that the needed history is unavailable.

**Acceptance Scenarios**:

1. **Given** a recorded worker launch, **When** the maintainer requests an explanation, **Then** it names the policy version in effect, the task's satisfied prerequisites or gate approvals, and the events that record them.
2. **Given** a recorded reviewer selection, **When** the explanation is produced, **Then** it names the policy version and the selection inputs (when-clauses, diff facts, verdict mode) as recorded, not as reconstructed guesses.
3. **Given** a recorded evidence rejection, **When** the explanation is produced, **Then** it identifies the actual evidence evaluated — check results, verdicts, receipts — and the rule that rejected it.
4. **Given** a recorded repair request, **When** the explanation is produced, **Then** it names the rejection or failure that triggered it and the policy version governing repair.
5. **Given** a decision whose supporting history was rotated away, **When** the explanation is produced, **Then** it marks that history unavailable rather than inferring a reason.

---

### User Story 3 - Keep replay and explanations as local, reusable artifacts (Priority: P3)

A maintainer saves a replay result or explanation as a local file alongside the project so a policy discussion can cite the actual output later, and re-runs it on demand. Everything runs offline against the recorded events in the project folder — there is no event-streaming service, no daemon, and no background evaluation.

**Why this priority**: Persisting and re-reading outputs strengthens the record but adds no new capability; the feature is complete without it, which makes it P3.

**Independent Test**: Run a replay with network access unavailable, save its output to a file, and re-read it later alongside the run's history with no service running.

**Acceptance Scenarios**:

1. **Given** a replay result, **When** the maintainer saves it, **Then** it is written as a local file that names the source run, the policy variant, and the support markings of its conclusions.
2. **Given** a machine with no network access, **When** replay and explanation commands run, **Then** they complete using only the project's local recorded events.
3. **Given** a saved replay output, **When** it is read later after further runs have been archived, **Then** it remains interpretable as a snapshot tied to the source run and policy variant, without re-execution.

---

### Edge Cases

- What happens when the run being replayed is still active and its run file is locked? Replay reads a copy and never writes; the lock does not block replay, and replay never contends for it.
- What happens when the recorded event history is truncated or pruned? The output states which decisions have incomplete history and marks their conclusions unavailable or requires-live-rerun; it never fills gaps with plausible defaults.
- What happens when the alternative policy is identical to the recorded one? The replay reports zero divergences and says so, rather than emitting an empty-looking report.
- What happens when a recorded decision cannot be attributed to any identifiable policy rule? The explanation marks the policy basis unavailable instead of reverse-engineering a rationale.
- What happens when the supplied policy variant is malformed or names an unknown knob? The invocation fails before evaluation with an error naming the invalid knob; the recorded run is never partially interpreted.
- What happens when replay conclusions are quoted later as if they were outcomes? Every conclusion carries its support marking and policy-variant identity, so a saved output can never be mistaken for a real run result.
- What happens when two policy variants are replayed over the same run? Each invocation is independent and read-only; outputs are distinguished by the variant each names.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an on-demand command that evaluates a copy of a recorded run under an alternative policy — review thresholds or budget policy supplied per invocation — using only that run's existing local recorded history.
- **FR-002**: Replay MUST NOT execute task commands, launch workers or reviewers, mutate the original run file or sidecar state, or create acceptance evidence; after any replay the original state is byte-for-byte unchanged.
- **FR-003**: Replay MUST mark every conclusion as either supported by recorded facts (citing the recorded event or artifact) or requiring a live rerun; no conclusion may be presented as certain when it depends on unrecorded data.
- **FR-004**: The system MUST produce explanations for four recorded decision types: worker launch, reviewer selection, evidence rejection, and repair request.
- **FR-005**: Each explanation MUST identify the policy version in effect and the actual recorded evidence it relied on; when required history is missing, the explanation MUST state that explicitly rather than infer a reason.
- **FR-006**: Replay and explanation MUST read only existing local events and state on demand; no event-streaming service, daemon, or background evaluation may be introduced.
- **FR-007**: Policy variants MUST be supplied per invocation and MUST NOT be written back into the run's recorded configuration; recorded decisions remain the authoritative history.
- **FR-008**: Malformed policy variants MUST fail before evaluation with an error naming the invalid knob, leaving the run untouched.
- **FR-009**: Replay outputs MUST carry the source run identity and the policy variant so saved outputs remain unambiguously distinguishable from real run results.
- **FR-010**: Before implementation, the current audit and replay capabilities of the codebase MUST be inventoried and recorded so this feature reuses them instead of duplicating a second explanation or audit path.

### Key Entities

- **Replay Scenario**: A read-only evaluation binding one recorded run, one policy variant, and the resulting divergences; each conclusion carries a support marking of recorded-fact or requires-live-rerun.
- **Decision Explanation**: The account of one recorded decision — decision type (launch, reviewer selection, evidence rejection, repair), policy version, cited evidence, and an availability state for any missing history.
- **Policy Variant**: The alternative review-threshold or budget-policy settings supplied for a single invocation, identified in outputs and never persisted into the run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of replay invocations leave the original run file and sidecar byte-for-byte unchanged and spawn zero worker processes, verified by checksum and process-count checks in automated tests.
- **SC-002**: 100% of replay conclusions carry a support marking (recorded-fact or requires-live-rerun) and, when marked recorded-fact, cite at least one specific recorded event or artifact; zero conclusions derive from missing history without a marking.
- **SC-003**: 100% of the four decision types produce an explanation naming a policy version and its actual evidence, or explicitly mark the required history unavailable; zero explanations invent a rationale.
- **SC-004**: Replay and explanation commands complete successfully with network access disabled in 100% of test runs, using only local recorded events.
- **SC-005**: An inventory of existing audit/replay capabilities is recorded and reviewed before implementation begins, and the delivered feature reuses those capabilities rather than adding a second audit or explanation authority.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): new capability, contingent on the inventory precondition. Append-only local event history, reviewer-selection policy logic, and per-policy version markers already exist in the code, but no offline replay command or decision-explanation surface was found in the inspected code.
- Precondition made explicit per the roadmap: inventory current audit and replay capabilities first (event history and its rotation/gc behavior, existing audit-style reports, reviewer-selection and repair policy paths) to avoid duplication; the inventory result may reclassify part of this feature as wiring rather than new work, and that reclassification is honored rather than overridden.
- Lightweight boundary (from the roadmap): on-demand processing of existing local events; no event-streaming service, no daemon, no cloud, and no mutation of recorded runs.
- Competitor inspiration (Taskflow's pure event-log replay and ledger-backed explainers) is a hypothesis until verified against this codebase; only the ideas of pure replay and evidence-cited explanation are taken, not a ledger storage design.
- Replay is a hypothetical evaluation, never an outcome: recorded decisions remain authoritative, and policy variants are per-invocation inputs that are never persisted into run state.
- The policy knobs in scope are exactly the review-threshold and budget-policy dimensions the roadmap names; no additional policy dimensions are invented for v1.
