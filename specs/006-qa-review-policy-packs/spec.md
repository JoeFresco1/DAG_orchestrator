# Feature Specification: QA and Review Policy Packs

**Feature Branch**: `006-qa-review-policy-packs`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P1-6: reusable QA and review policy packs — opt-in, versioned local profiles that package existing checks and reviewers for common stacks and change types (TypeScript, Python, API contracts, migrations, CLI behavior, security-sensitive paths), with declared prerequisites and limits, fail-closed expansion, and visible overrides."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Apply a pack and get ordinary inspectable checks and reviewers (Priority: P1)

A maintainer opts a run into a named pack — for example the TypeScript pack or the API-contract pack. The pack expands into the ordinary checks and reviewer commands the tool already runs, visible through existing inspection commands before anything executes, and expansion fails closed: a missing test suite, a selection that matched zero tests, a reviewer that produced no verdict, and a tool that is unavailable each surface as an explicit failure or unavailable result, never as a pass.

**Why this priority**: Expansion is the mechanism every other story depends on; a pack that can pass without executing anything would manufacture false confidence, so the fail-closed loop is the MVP.

**Independent Test**: Apply a pack whose test command points at a nonexistent test path and confirm the expanded check reports failure rather than success, then confirm the expanded checks and reviewers are listed with their command text before launch.

**Acceptance Scenarios**:

1. **Given** a run with a pack selected, **When** the pack is expanded, **Then** every expanded entry appears as an ordinary check or reviewer command with its command text visible through existing inspection commands before launch.
2. **Given** a pack whose test selection matches zero tests, **When** the check runs, **Then** the result is an explicit failure naming the zero selection, not a pass.
3. **Given** a pack entry requiring a tool that is unavailable, **When** that entry is reached, **Then** it reports unavailable with the missing tool named, and no entry passes by being skipped.
4. **Given** a pack reviewer that emits no verdict, **When** review results are collected, **Then** the missing verdict is recorded as a failure rather than as an absence.

---

### User Story 2 - Override one check without weakening acceptance unnoticed (Priority: P2)

A maintainer disagrees with a single pack entry — for example excluding one lint rule for a legacy directory. They override that individual entry; the override is recorded against the pack's name and version and stays visible in the run record, and a pack's required acceptance cannot be dropped by an override without an explicit, recorded acknowledgment.

**Why this priority**: Overrides are what make packs usable on real codebases; the value is usability plus a visible trail, so it follows a trustworthy expansion loop.

**Independent Test**: Override one check and confirm the run record lists the override with pack name, version, and replaced command; attempt to drop a required verdict and confirm it is refused without explicit acknowledgment and that any acknowledgment is recorded.

**Acceptance Scenarios**:

1. **Given** an applied pack, **When** a user disables or replaces one check, **Then** the run record lists the override with pack name, pack version, and the original command.
2. **Given** a user attempting to remove a pack's required verdict, **When** the override is submitted, **Then** the system requires an explicit acknowledgment that is recorded, and without it the required verdict remains required.
3. **Given** a run with overrides, **When** acceptance is inspected, **Then** required acceptance is reported per original requirement with overrides marked, never collapsed into an unqualified pass.

---

### User Story 3 - Inspect prerequisites, limits, and opt-in scope of the shipped catalog (Priority: P3)

A maintainer reviews each pack's declared prerequisites (tools, project shape) and limits (which change types or paths it covers) before selecting it, and the shipped catalog covers the six roadmap categories: TypeScript, Python, API contracts, migrations, CLI behavior, and security-sensitive paths. Packs activate only where explicitly selected.

**Why this priority**: Catalog breadth and prerequisite transparency are additive polish on a trustworthy expansion mechanism; a pack running where it does not apply is noise.

**Independent Test**: List the pack catalog with prerequisites and limits, select a pack in a project missing a prerequisite, and confirm an explicit unmet-prerequisite result instead of partial silent execution.

**Acceptance Scenarios**:

1. **Given** the pack catalog, **When** a maintainer inspects a pack, **Then** its prerequisites and limits are shown before selection.
2. **Given** a project missing a declared prerequisite, **When** the pack is selected, **Then** the run reports the unmet prerequisite by name and does not partially execute the pack silently.
3. **Given** no pack selected, **When** a run starts, **Then** no pack checks or reviewers are added to it.

---

### Edge Cases

- What happens when two selected packs expand to the same underlying check? Both entries are reported with their pack provenance; overlap is shown explicitly rather than silently deduplicated.
- What happens when a pack file is edited after runs used it? Runs record the pack name and version they expanded; an edited pack becomes a new version and does not rewrite old run records.
- What happens when an override replaces a check with a command that itself fails? The replacement fails like any other check; an override never exempts a command from execution.
- What happens when an entry's precondition cannot be evaluated (for example, no diff available because the task ran without worktree isolation)? The entry runs or reports unevaluable; an unevaluable condition never expands into a pass.
- What happens when a prerequisite tool exists but is broken or unauthenticated? The execution error is recorded as unavailable with the reason; it cannot become a pass.
- What happens when a pack is selected for a task whose change type falls outside the pack's declared limits? The out-of-scope entry reports not applicable with the limit cited, and the task's required acceptance is unaffected.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support opt-in policy packs defined as versioned local configuration files, each expanding into ordinary checks and reviewer commands.
- **FR-002**: Every pack expansion MUST be fully inspectable before execution through existing task and reviewer inspection commands, including each expanded command's text.
- **FR-003**: Pack execution MUST fail closed: missing tests, zero selected tests, missing verdicts, and unavailable tools MUST surface as explicit failure or unavailable results and MUST NOT be recorded as passes.
- **FR-004**: Users MUST be able to override individual pack entries; each override MUST be recorded with the pack name and version and remain visible in the run record.
- **FR-005**: An override MUST NOT remove a pack's required acceptance without explicit recorded acknowledgment, and weakened acceptance MUST remain visibly marked as weakened.
- **FR-006**: Packs MUST declare prerequisites and limits; an unmet prerequisite MUST produce an explicit result naming it rather than partial silent execution.
- **FR-007**: Pack results MUST report through the existing checks, reviewer verdicts, and scoring surfaces; packs MUST NOT introduce a second rubric or a competing quality grade.
- **FR-008**: Pack selection MUST be explicit per run or task; no pack stage may enable itself automatically or run unannounced.
- **FR-009**: Packs MUST be usable entirely from local files, with no marketplace, registry, or network fetch required.

### Key Entities

- **Policy Pack**: A named, versioned set of checks and reviewer commands for a stack or change type, with declared prerequisites and limits; applied only by explicit opt-in.
- **Pack Expansion**: The concrete list of checks and reviewers a pack resolves to for a given task, inspectable before execution and attributable to the pack name and version.
- **Pack Override**: A recorded substitution or disablement of one pack entry, attributed to the pack and version, carrying an acknowledgment whenever it touches required acceptance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of packs applied in a test project, every expanded check and reviewer command is visible with its command text before launch through existing inspection commands.
- **SC-002**: Across a test matrix covering missing tests, zero selected tests, a missing verdict, and an unavailable tool, 0 cases result in a pass and all 4 are reported explicitly.
- **SC-003**: 100% of overrides appear in the run record with pack name and version, and 0 required verdicts are dropped without a recorded acknowledgment.
- **SC-004**: The shipped catalog covers all six named categories — TypeScript, Python, API contracts, migrations, CLI behavior, and security-sensitive paths — each with published prerequisites and limits.
- **SC-005**: 0 runs activate a pack without an explicit selection recorded in the run's configuration.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): new capability. Reviewer attachment, `when` conditions, and plan checks already exist as primitives, but no named pack entity, pack expansion command, or override accounting appears in the inspected command surface; composing those primitives with fail-closed expansion and a recorded override trail is the smallest missing increment.
- Lightweight boundary: versioned local configuration files; no mandatory plugin marketplace; the existing scoring system is kept rather than adding a competing rubric.
- Competitor inspiration: Lindy's named QA gates are a documentation-level hypothesis — claimed capability, not verified against this codebase or measured; pack semantics here are defined by this specification, not by parity with that claim.
- Prerequisite and limit content for the six shipped packs must be derived from an inventory of the check and reviewer commands this repository already supports; the feature adds no new testing frameworks, linters, or services.
- Packs expand into the existing reviewer and check mechanisms; they do not introduce a parallel reviewer system or state authority, preserving proven contracts.
