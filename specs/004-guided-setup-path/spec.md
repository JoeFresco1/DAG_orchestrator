# Feature Specification: Guided Setup Path

**Feature Branch**: `004-guided-setup-path`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P0-4: one clear path from goal to accepted result — a guided setup that previews the plan, execution mode, checks, review policy, isolation, and budgets, recommends a profile without silently enabling costly stages, and keeps existing low-level commands usable."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One documented path from goal to accepted integrated diff (Priority: P1)

A new user with a real repository runs the guided setup, states their goal, and is walked through: choosing an execution mode, previewing the generated plan, selecting checks and review policy, isolation, and budgets. They execute the run and, at the end, locate the accepted integrated diff from the guided output. The entire journey follows one documented path with no steps that require knowledge of the low-level command surface.

**Why this priority**: This is the coherence layer over ordinary, planned, reliable, and factory runs; without it, capability exists but entry does not.

**Independent Test**: On a fresh clone of a real repository, follow only the documented guided path from goal to accepted integrated diff and confirm the diff is reachable and correct at the end.

**Acceptance Scenarios**:

1. **Given** a real repository and a stated goal, **When** the user completes guided setup, **Then** the system previews the plan, chosen execution mode, checks, review policy, isolation setting, and budgets before anything executes.
2. **Given** the previewed configuration, **When** the user confirms and the run executes, **Then** the run completes (or reports honest incompleteness) and the guided output points to the accepted integrated diff.
3. **Given** the completed run, **When** the user inspects the configuration that produced it, **Then** the configuration is ordinary inspectable project files, not opaque internal state.

---

### User Story 2 - Preflight explains what is unavailable and why work is blocked (Priority: P2)

Before execution, the guided path runs a preflight that reports unavailable worker tools, missing prerequisites (for example Git configuration or harness installation), and — during a run — why any specific task is blocked, in plain language a new user can act on.

**Why this priority**: Preflight turns silent stalls into actionable messages; it protects the Story 1 journey on imperfect machines.

**Independent Test**: Remove or hide one worker tool from the environment, run guided setup on a real repository, and confirm preflight names the missing tool and its effect before execution starts.

**Acceptance Scenarios**:

1. **Given** an environment missing a required worker tool, **When** the user runs guided preflight, **Then** the report names the unavailable tool, what it was needed for, and how the guided path degrades or proceeds without it.
2. **Given** a run in which a task becomes blocked, **When** the user asks the guided path why, **Then** the answer states the concrete blocking condition (unsatisfied dependency, gate, or missing prerequisite) rather than a generic status.
3. **Given** a fully provisioned environment, **When** preflight runs, **Then** it reports ready and the run proceeds without prompting for optional components.

---

### User Story 3 - Profiles recommend without coercing and low-level commands stay intact (Priority: P3)

The guided setup defines what each execution mode guarantees, recommends a profile for the user's goal, and never silently enables costly stages (reliable-execution or factory features). Users who prefer the existing low-level commands can ignore the guided path entirely, and the guided path's output is inspectable configuration those same commands consume.

**Why this priority**: Trust and non-regression; the guided path must extend the proven command surface, not replace or silently upgrade it.

**Independent Test**: Run guided setup to a recommended profile, diff the resulting configuration before and after confirmation, and confirm no costly stage was enabled without explicit selection; separately, run the pre-existing low-level commands on the same project and confirm they behave unchanged.

**Acceptance Scenarios**:

1. **Given** a user's stated goal, **When** the guided setup recommends a profile, **Then** the recommendation states what the chosen mode guarantees and names the costly stages it did not enable.
2. **Given** a user who declines optional costly stages, **When** the configuration is written, **Then** no reliable-execution or factory feature is enabled beyond what was explicitly accepted.
3. **Given** a project configured through the guided path, **When** existing low-level run and inspection commands are invoked, **Then** they operate on the guided configuration exactly as on hand-written configuration.

---

### Edge Cases

- What happens when the repository is already configured (a run file or settings exist)? Guided setup detects existing configuration, offers to review or extend it, and never overwrites it silently.
- What happens when the user's goal maps to no executable checks in the repository? The guided path says checks are missing and either stops or offers to proceed with explicit acknowledgment, never fabricating acceptance criteria.
- What happens when a recommended profile's prerequisites are only partially available? Preflight lists each missing prerequisite and the guided path offers degraded profiles explicitly chosen by the user, not silently substituted.
- What happens when the guided run fails or is interrupted? The user is pointed at the same recovery and status commands a low-level user would use; the guided path adds explanation, not a separate recovery mechanism.
- What happens when the guided path and a hand-edited configuration disagree? The on-disk configuration is authoritative; the guided path re-reads and reports it rather than maintaining a parallel copy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a guided setup that, before execution, previews the plan, execution mode, checks, review policy, isolation, and budgets for a stated goal in a real repository.
- **FR-002**: The system MUST document what each execution mode (ordinary, planned, reliable, factory) guarantees, and the guided path MUST recommend a profile for the user's goal without silently enabling costly stages.
- **FR-003**: The guided path MUST end at the accepted integrated diff: on completion it points the user to the integrated, accepted result, or reports honest incompleteness.
- **FR-004**: A preflight MUST report unavailable worker tools, missing prerequisites, and (during a run) the concrete reason any task is blocked, in actionable language.
- **FR-005**: The guided path MUST produce ordinary inspectable configuration consumed by existing commands; it MUST NOT create opaque state or a second configuration authority.
- **FR-006**: All existing low-level commands MUST remain usable and unchanged in behavior on projects configured through the guided path.
- **FR-007**: The guided path MUST be entirely local and CLI-first: no account, cloud service, or external setup beyond already-installed worker tools.
- **FR-008**: Optional costly stages (reliable-execution and factory features) MUST be enabled only by explicit user selection during the guided path; profiles recommend, they do not coerce.

### Key Entities

- **Setup Profile**: A named, recommended configuration selecting execution mode, checks, review policy, isolation, and budgets, with a stated guarantee set and explicitly excluded costly stages.
- **Preflight Report**: A pre-execution (and mid-run) assessment listing unavailable tools, missing prerequisites, and concrete blocking conditions, each with its effect on the guided path.
- **Guided Configuration**: The inspectable project files the guided path writes or extends, consumed identically by guided and low-level commands.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user on a fresh real repository can go from goal to accepted integrated diff following one documented guided path, with zero required detours into undocumented commands.
- **SC-002**: 100% of missing worker tools and prerequisites are reported by preflight before execution begins; zero silent stalls occur for causes preflight could detect.
- **SC-003**: Zero costly stages appear in any guided-written configuration that the user did not explicitly select; every recommendation names what it did not enable.
- **SC-004**: Every configuration produced by the guided path is readable, editable, and fully honored by the existing low-level command surface, verified on at least one real repository.
- **SC-005**: The mode-guarantee documentation covers all four execution modes, and each guided recommendation cites the guarantee set it is based on.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs usability work. The underlying run, plan, review, worktree, and budget machinery already exists as low-level commands; the missing piece is the coherent guided entry point, preflight explanations, and mode-guarantee documentation that sit on top of them.
- Lightweight boundary (from the roadmap): CLI-first orchestration over existing commands; no account or service setup; no opaque state.
- No competitor inspiration is claimed for this feature; the four execution modes are the project's own ordinary, planned, reliable, and factory capabilities.
- Precondition: planning must inventory the existing command surface and configuration files first, and the guided path must be specified as a layer over those exact commands rather than a new execution engine.
- The "one documented path" is a single document plus the guided commands; it assumes worker tools are installed by the user's environment and only their absence is reported, not remediated.
