# Feature Specification: Incremental Reuse of Verified Project Knowledge

**Feature Branch**: `008-verified-knowledge-reuse`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-8: incremental reuse of verified project knowledge — a new run explicitly imports still-valid facts, known non-issues, and accepted contracts from prior runs, previewing reused and invalidated items with reasons bound to source hashes, contracts, and relevant dependency changes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preview and import still-valid knowledge from a prior run (Priority: P1)

A maintainer starting a new run names a prior run as a source and sees a preview: which facts, known non-issues, and accepted contracts are still valid — each bound to the source run, source commit, and evidence hashes — and which are invalidated, each with a reason. On confirmation, only the still-valid items enter the new run.

**Why this priority**: This is the entire value — a new run begins with verified context instead of re-investigating — and the invalidation preview is inseparable from it, because importing stale claims would be worse than importing nothing.

**Independent Test**: Import from a prior run covering an unchanged subsystem, confirm reused items display hash-bound provenance, and confirm an item whose supporting evidence changed appears as invalidated with its reason.

**Acceptance Scenarios**:

1. **Given** a prior run with recorded facts and accepted contracts, **When** a new run opens an import preview, **Then** each reused item lists its source run, source commit, and evidence hashes.
2. **Given** an item whose supporting file differs from its bound hash, **When** the preview is computed, **Then** the item is listed as invalidated with the changed evidence named.
3. **Given** a preview, **When** the maintainer confirms the import, **Then** only items marked reused are imported and the import records the source run identifier against them.

---

### User Story 2 - Changed or missing evidence invalidates exactly the affected claim (Priority: P2)

When a supporting file is deleted, an accepted contract changes, or a relevant dependency moves, only the claims whose evidence or contract is affected become invalid; unrelated claims stay reusable, and invalidated items retain their original provenance rather than being rewritten or erased.

**Why this priority**: Precise invalidation is what makes reuse trustworthy; it builds on the source bindings established in Story 1.

**Independent Test**: Modify one evidence file and delete another, then confirm only the claims bound to them flip to invalidated with reasons while unaffected claims remain reusable and the original evidence provenance survives on the invalidated items.

**Acceptance Scenarios**:

1. **Given** a candidate claim bound to a file hash, **When** that file's content no longer matches the bound hash, **Then** the claim is invalidated before import with the changed supporting evidence named as the reason.
2. **Given** a candidate claim bound to an accepted contract, **When** that contract differs in the current tree, **Then** the claim is invalidated and the contract difference is named as the reason.
3. **Given** claims unaffected by the observed changes, **When** the preview runs, **Then** they remain marked reusable and their evidence bindings are unchanged.

---

### User Story 3 - Reuse narrows duplicate investigation but never substitutes for acceptance (Priority: P3)

Imported knowledge feeds planning and context assembly so a new run does not repeat investigations already settled, while every required current check and reviewer verdict still runs and still decides completion on its own.

**Why this priority**: The anti-substitution guarantee is what keeps reuse honest; it is a negative guarantee tested once the import flow exists.

**Independent Test**: Run a task whose subsystem has imported verified facts and confirm its required checks execute and their results — not the import — determine whether the task completes.

**Acceptance Scenarios**:

1. **Given** imported knowledge marking a subsystem's behavior as verified, **When** a dependent task runs, **Then** its required checks execute and their results are recorded as the basis for acceptance.
2. **Given** an imported claim, **When** acceptance for a task is computed, **Then** the claim contributes no pass, no score, and no waived check.
3. **Given** investigation questions already answered by reused items, **When** planning context is assembled, **Then** those questions are marked covered with references to the reused items.

---

### Edge Cases

- What happens when the source run's logs were pruned but its knowledge files remain? Claims whose supporting evidence files are missing are invalidated for missing evidence; claims with intact bindings preview normally.
- What happens when the source run belongs to a different repository root? The import is refused with the root mismatch named rather than binding hashes from another project.
- What happens when the same claim is proposed by two source runs, or by a run that itself imported it? The preview shows both provenances; conflicting values are flagged for a choice instead of silently preferring one.
- What happens when a claim's evidence file is unchanged but a dependency of its contract changed? The relevant dependency change invalidates the claim with that change named as the reason.
- What happens when a run imports nothing, or every candidate is invalidated? The preview still reports each decision and reason; an empty import is a valid outcome, not an error.
- What happens when previously imported knowledge turns out to be wrong? The imported claim never satisfied acceptance, so current checks remain the sole basis of completion and the error surfaces through them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A new run MUST be able to explicitly import facts, known non-issues, and accepted contracts from a named prior run; nothing imports automatically.
- **FR-002**: Every candidate item MUST carry a source binding: source run identifier, source commit, evidence hashes, and contract identity where applicable, plus the relevant dependency state considered.
- **FR-003**: Before import, the system MUST preview reused and invalidated items with a per-item reason, and the import MUST apply only the items confirmed as reused.
- **FR-004**: Changed or missing supporting evidence, changed contracts, or relevant dependency changes MUST invalidate the affected claims only, and invalidated items MUST retain their original provenance.
- **FR-005**: Imported knowledge MUST NOT substitute for required current acceptance checks or verdicts; it MAY narrow planning context and mark duplicate investigation as covered with references.
- **FR-006**: Reuse state MUST live in project-owned files with optional embedded indexing; no mandatory vector database, cloud service, or unbounded conversation memory.
- **FR-007**: Invalidation decisions MUST be deterministic given the same evidence, contract, and dependency state, and MUST be reproducible from the recorded bindings.

### Key Entities

- **Knowledge Claim**: A fact, known non-issue, or accepted contract proposed for reuse, with a validity decision (reused or invalidated), a reason, and its retained provenance.
- **Source Binding**: The provenance linking a claim to its source run, source commit, evidence hashes, contract identity, and considered dependency state.
- **Import Preview**: The pre-import listing of reused and invalidated items with per-item reasons, confirmed by the user before anything enters the new run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of previewed items carry a validity decision and a reason, and 100% of reused items display source run, source commit, and evidence hashes.
- **SC-002**: In a stale-evidence test that modifies one supporting file and removes another, 0 claims with changed or missing evidence import as valid, and only the claims bound to that evidence flip to invalidated.
- **SC-003**: In reuse-enabled runs, 0 imported claims affect acceptance outcomes — required checks execute and decide completion in 100% of tested cases.
- **SC-004**: For a new run over an unchanged subsystem, all prior verified items preview as reusable with references available to planning context, and 0 items are imported without a validity decision.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring. Project memory with hash-bound evidence, negative-evidence records, impact analysis, and certification invalidation already exist in the factory flow, but no run-scoped import and preview workflow connecting them to a new run appears on the command path. Confirm by inspecting tests and command paths before implementing.
- Lightweight boundary: project-owned files and optional embedded indexing; no mandatory vector database or unbounded conversation memory.
- No competitor is named for this roadmap item; the opportunity is framed internally, so no competitor claim is carried into this specification.
- Precondition: inventory the existing knowledge, negative-evidence, impact, and certification-invalidation components first and reuse their binding and invalidation semantics rather than defining a parallel format.
- Reuse is one hop: a new run imports from explicitly named prior runs; chained imports must be cited with their origin, not flattened into anonymous knowledge.
