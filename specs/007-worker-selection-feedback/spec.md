# Feature Specification: Evidence-Based Worker Selection and Decomposition Feedback

**Feature Branch**: `007-worker-selection-feedback`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-7: evidence-based worker selection and decomposition feedback — record outcomes by worker profile, task boundary, reviewer profile, and defect category, and recommend narrower tasks or a different authorized worker when comparable failures recur, citing attempts and verdicts with sample size and uncertainty."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record acceptance outcomes with infrastructure separated (Priority: P1)

A maintainer running tasks through harness chains and reviewers gets a project-local record of each attempt keyed by worker profile (harness, model, variant), task boundary attributes, reviewer profile, and defect category, with infrastructure failures — spawn failure, timeout, stall, kill, signal death — recorded separately from implementation failures.

**Why this priority**: Every recommendation must cite real attempts; a record that mixes infrastructure noise into implementation failure would make any advice built on it misleading. This is the foundation.

**Independent Test**: Drive one task to a stall timeout and another to a genuine failing check, then inspect the record and confirm both attempts appear with distinct failure kinds and the same profile key dimensions.

**Acceptance Scenarios**:

1. **Given** an attempt that fails its acceptance check, **When** the attempt completes, **Then** the record stores the worker profile, task boundary attributes, reviewer profile, defect category, and failure kind implementation.
2. **Given** an attempt killed by a stall timeout or dying by signal, **When** it is recorded, **Then** the failure kind is infrastructure and it is excluded from implementation-failure counts.
3. **Given** a run with attempts, **When** the record is inspected, **Then** every attempt retrievable from attempt logs carries a failure kind and profile keys, with no unclassified attempt other than an explicitly labeled unclassified defect category.

---

### User Story 2 - Get recommendations that cite attempts and verdicts (Priority: P2)

When comparable implementation failures recur for one class of task, the tool offers a recommendation to split the task narrower or to use a different worker already authorized in the project's configuration, citing the actual attempt identifiers and independent reviewer verdicts behind it and showing sample size and uncertainty. Below a stated minimum sample it reports insufficient data instead of recommending.

**Why this priority**: This is the visible payoff of Story 1's record; it cannot exist before outcomes are recorded, so it comes second.

**Independent Test**: Inject repeated comparable failures with reviewer rejections and confirm a recommendation names attempt identifiers, verdicts, sample size, and uncertainty; then run with a single failure and confirm an insufficient-data result instead of a recommendation.

**Acceptance Scenarios**:

1. **Given** recurrent comparable implementation failures for one task class with independent reviewer rejections, **When** recommendations are computed, **Then** the recommendation names the contributing attempt identifiers and their verdicts and displays sample size and uncertainty.
2. **Given** only one observed failure, **When** recommendations are computed, **Then** the output reports insufficient sample instead of offering a recommendation.
3. **Given** failures that are all infrastructure, **When** recommendations are computed, **Then** no worker-selection or decomposition recommendation is produced.
4. **Given** a displayed recommendation, **When** a maintainer inspects its options, **Then** it offers only narrower task decomposition or a worker already authorized in the project's configuration.

---

### User Story 3 - Keep recommendations explicit and non-escalating (Priority: P3)

A maintainer acts on a recommendation by hand. Nothing about displaying or following a recommendation upgrades to a more expensive model, resets a retry budget, or relaxes acceptance on its own; any such change happens only through an explicit user command and is recorded as user action.

**Why this priority**: These are negative guarantees enforced by the absence of automation; they are independently testable once recommendations can be displayed.

**Independent Test**: Run a recurring-failure scenario with recommendations enabled and verify that the harness chain, retry counters, and required checks remain unchanged until an explicit configuration command is issued.

**Acceptance Scenarios**:

1. **Given** a recommendation displayed, **When** the run continues without user action, **Then** the harness chain, retry budgets, and required checks remain unchanged.
2. **Given** a maintainer wants a stronger or more expensive model, **When** it takes effect, **Then** it happened through an explicit configuration command and is recorded as user action.
3. **Given** a recommendation, **When** following it would require loosening acceptance, **Then** no acceptance change occurs and the required checks still decide completion.

---

### Edge Cases

- What happens when two attempts share a harness but differ in model or variant? Profiles are keyed per model and variant as well; attempts from different profiles are never merged into one sample.
- What happens when a failure's defect category cannot be determined? It is recorded as unclassified and excluded from category-specific recommendations rather than guessed into one.
- What happens when a single attempt has both an infrastructure trigger and an implementation defect? The primary failure kind drives counting, with secondary causes retained on the record.
- What happens when reviewers disagree on one attempt (one rejects, one passes)? The individual verdicts are cited as they stand; the recommendation never collapses them into a single grade.
- What happens with no history at all, or history only from archived runs? The output is an insufficient-data notice; imported history from another run is cited with its source run identifier.
- What happens when comparable failures recur but the worker pool contains only the worker already failing? The recommendation offers narrower decomposition only, with the sample and uncertainty shown.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST record attempt outcomes in project-local storage keyed by worker profile, task boundary attributes, reviewer profile, and defect category.
- **FR-002**: The system MUST classify every attempt as infrastructure failure or implementation failure, and every count derived from the record MUST keep the two separate.
- **FR-003**: Recommendations MUST cite the contributing attempt identifiers and their independent reviewer verdicts and MUST display sample size and uncertainty; below a defined minimum sample the output MUST be an insufficient-data notice instead of a recommendation.
- **FR-004**: Recommendation content MUST be limited to narrower task decomposition and to selection among workers already authorized in the project's configuration.
- **FR-005**: The system MUST NOT perform an automatic expensive-model upgrade, retry-budget reset, or acceptance relaxation; such changes occur only through explicit user commands and are recorded as user action.
- **FR-006**: Recommendations MUST NOT alter required checks, verdict requirements, or acceptance state of any task.
- **FR-007**: Observations and recommendations MUST remain optional, project-local data with no global ranking service and no network submission of project outcomes.

### Key Entities

- **Attempt Observation**: One recorded attempt, binding worker profile, task boundary attributes, reviewer profile, defect category, failure kind, and the source run it belongs to.
- **Worker Recommendation**: An advisory proposing narrower decomposition or an authorized alternate worker, carrying its contributing attempt identifiers, verdicts, sample size, and uncertainty.
- **Failure Attribution**: The infrastructure-versus-implementation classification attached to each attempt and preserved in every derived count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attempts in a test run carry a failure kind and worker-profile key; defect categories appear as either a named category or an explicit unclassified label, with 0 silently omitted attempts.
- **SC-002**: 100% of displayed recommendations cite at least one attempt identifier with its verdicts and show sample size and uncertainty; 0 recommendations appear below the minimum sample.
- **SC-003**: In an injected repeated-comparable-failure scenario, a recommendation naming narrower decomposition or an authorized alternate worker appears; in a single-failure scenario, none appears.
- **SC-004**: With recommendations enabled across the test suite, 0 automatic model upgrades, retry-budget resets, or acceptance relaxations occur.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring. Harness-chain fallback, attempt logs, the runner's infrastructure-versus-implementation distinction, and model-router calibration with sample size and uncertainty already exist; what is missing is a durable outcome record keyed by the four roadmap dimensions and a recommendation surface that cites it. Confirm by inspecting the relevant tests and command paths before implementing.
- Lightweight boundary: optional project-local observations and explicit recommendations; no global ranking service.
- No competitor is named for this roadmap item; the opportunity is framed internally, so no competitor claim is carried into this specification.
- Precondition: inventory the existing outcome data first — attempt logs, event history, and router calibration inputs — so recommendations cite existing evidence rather than a parallel store.
- Recommendations are advisory only; the existing harness chain and runner remain the sole authorities on execution order, retries, and acceptance.
