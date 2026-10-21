# Feature Specification: Source-Bound Acceptance Receipts

**Feature Branch**: `003-acceptance-receipts`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P0-3: source-bound acceptance receipts — a portable export binding a task's accepted specification, worker attempt, checks, reviewer verdicts, source revision, integration result, and policy version, with stale evidence shown explicitly and an offline inspection command."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Export a receipt and answer "what passed, against which code?" (Priority: P1)

After a task is accepted, a maintainer exports a compact receipt that binds the task's accepted specification, the worker attempt that produced the work, the checks that ran, the reviewer verdicts, the source revision that was tested, the integration result, and the policy version in force. The receipt is portable — a colleague can receive the file and see exactly what was accepted and against which code.

**Why this priority**: The receipt is the core deliverable — a single portable answer consolidating planning, reliable-execution, and factory evidence; staleness and retention build on it.

**Independent Test**: Accept a task in a real run, export its receipt, and verify every bound element (spec, attempt, checks, verdicts, revision, integration, policy version) is present and references real evidence.

**Acceptance Scenarios**:

1. **Given** an accepted task with checks and reviewer verdicts, **When** the maintainer exports a receipt, **Then** the receipt contains the accepted specification, worker attempt identity, each executed check with its result, each reviewer verdict, the source revision that was tested, the integration result, and the policy version.
2. **Given** an exported receipt, **When** the maintainer inspects any evidence reference in it, **Then** the reference resolves to the actual stored evidence (check output, verdict record, commit).
3. **Given** a task that was never accepted, **When** the maintainer attempts to export a receipt, **Then** no acceptance receipt is produced and the command explains why.

---

### User Story 2 - Stale evidence is visible and cannot silently authorize completion (Priority: P2)

After a receipt is exported, relevant source or contract changes occur — the receipt's tested revision is superseded, a file the checks exercised changes, or the policy version changes. The system marks the receipt's evidence as stale, and an old receipt no longer silently authorizes treating the work as still accepted: re-verification or an explicit override is required.

**Why this priority**: A receipt that silently stays valid after relevant changes is worse than no receipt; this story makes the binding trustworthy.

**Independent Test**: Export a receipt, modify a source file relevant to the accepted task or advance the policy version, then attempt to rely on the old receipt and confirm it is reported stale and does not authorize completion without re-verification.

**Acceptance Scenarios**:

1. **Given** an exported receipt, **When** the source revision it binds is superseded by changes relevant to the task, **Then** inspection reports the receipt as stale and names the change that invalidated it.
2. **Given** a stale receipt, **When** a consumer attempts to use it to claim the work is still accepted, **Then** the system refuses the silent authorization and requires re-verification or an explicit, recorded override.
3. **Given** a change irrelevant to the receipt's task, **When** the receipt is inspected, **Then** it is not marked stale by that change.

---

### User Story 3 - Retain referenced evidence and inspect receipts offline (Priority: P3)

A maintainer enables an optional retention policy so that evidence referenced by active receipts is protected from cleanup, and uses an offline inspection command that explains a receipt's validity — bound elements, evidence resolution, and staleness — without invoking any LLM or network service.

**Why this priority**: Offline inspection and retention harden portability and longevity; they depend on the receipt format from Story 1 and staleness rules from Story 2.

**Independent Test**: Export a receipt, run evidence cleanup under the retention policy, and confirm referenced evidence survives; then inspect the receipt on a machine with no network and no model access and receive a full validity explanation.

**Acceptance Scenarios**:

1. **Given** an exported receipt with a retention policy enabled, **When** evidence cleanup runs, **Then** evidence referenced by the receipt is retained and unprotected evidence is eligible for cleanup as before.
2. **Given** a receipt file, **When** the inspection command runs in an offline environment, **Then** it prints the bound elements, which evidence references resolve, and the receipt's validity status, using no LLM calls and no network access.
3. **Given** a receipt whose referenced evidence was deleted without the retention policy, **When** inspection runs, **Then** the receipt is reported as unverifiable with the missing references named, rather than reported valid.

---

### Edge Cases

- What happens when the policy version under which a task was accepted no longer exists? Inspection reports the recorded policy version and flags that it cannot be re-evaluated under that policy, rather than silently re-evaluating under the current policy.
- What happens when a receipt's source revision is rewritten (for example, a rebase) so the commit hash no longer resolves? Inspection reports the receipt as unresolvable against the current repository and names the missing revision.
- What happens when two receipts bind overlapping evidence and only one is protected by retention? Retention applies per receipt reference; deleting an unprotected receipt does not unprotect shared evidence still referenced by a protected receipt.
- What happens when a check listed in a receipt is re-run after export and produces a different result? The receipt records the result as executed at acceptance time; the new result does not rewrite the receipt and staleness rules apply to the receipt's original binding.
- What happens when export is requested for a task accepted before receipts existed? The system reports insufficient recorded evidence to bind a receipt rather than fabricating references from partial state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST export, for each accepted task, a compact receipt binding: the accepted specification, the worker attempt, every executed check with its result, every reviewer verdict, the source revision tested, the integration result, and the policy version in force at acceptance.
- **FR-002**: Receipts MUST reference existing stored evidence; every reference MUST resolve to real check output, verdict records, or commits, and unresolvable references MUST be reported on inspection.
- **FR-003**: Receipts MUST be exportable and inspectable as local files without a network service, database, or LLM invocation.
- **FR-004**: The system MUST detect, per receipt, whether relevant source or contract changes since the bound revision invalidate the evidence, and MUST mark such receipts stale, naming the invalidating change.
- **FR-005**: A stale receipt MUST NOT silently authorize treating its task as still accepted; re-verification or an explicit, recorded override is required.
- **FR-006**: Staleness MUST be scoped: changes irrelevant to the receipt's task and binding MUST NOT mark that receipt stale.
- **FR-007**: The system MUST provide an optional retention policy under which evidence referenced by active receipts is protected from cleanup; the policy is opt-in and MUST NOT change cleanup behavior for unreferenced evidence.
- **FR-008**: Receipts MUST build on the existing evidence hashes and sidecar records; export MUST NOT duplicate or replace the existing acceptance and review state authorities.

### Key Entities

- **Acceptance Receipt**: A portable record binding one accepted task to its specification, worker attempt, executed checks, reviewer verdicts, tested source revision, integration result, and policy version.
- **Evidence Reference**: A pointer from a receipt to stored evidence (check output, verdict record, commit); resolvable against the local store and repository.
- **Staleness Determination**: The per-receipt verdict — current or stale — computed from relevant changes since the bound revision and policy version, with the invalidating change named.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of exported receipts contain all seven bound elements and every evidence reference resolves; receipts for tasks with insufficient recorded evidence are refused rather than partially generated.
- **SC-002**: A single documented inspection command explains any receipt's validity offline, with zero LLM invocations and zero network calls.
- **SC-003**: After a relevant change to a receipt's bound source, 100% of inspections of that receipt report it stale with the invalidating change named; zero stale receipts authorize completion silently.
- **SC-004**: Irrelevant changes produce zero false staleness marks on unaffected receipts in a mixed corpus of receipts.
- **SC-005**: With retention enabled, 100% of evidence referenced by active receipts survives cleanup; cleanup of unreferenced evidence behaves as it did before the policy existed.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring. Evidence hashes, sidecar records, reviewer verdicts, and integration results already exist as acceptance inputs; the missing piece is the portable receipt export, staleness computation, and offline inspection command that bind them.
- Lightweight boundary (from the roadmap): build on existing hashes and sidecars; retention is an explicit optional policy protecting evidence that active receipts reference.
- No competitor inspiration is claimed for this feature; the consolidation goal comes from the project's own evidence-bound acceptance principle.
- Precondition: planning must inventory which evidence artifacts (check outputs, verdicts, commits, policy records) already carry hashes or identifiers, and receipts must bind those existing identifiers rather than introducing a second evidence format.
- "Relevant changes" for staleness are defined against the receipt's own binding (the tested revision, the files its checks exercised, and its policy version); the exact relevance rule is fixed at implementation and documented, not learned or model-driven.
