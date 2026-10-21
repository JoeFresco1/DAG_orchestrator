# Lightweight DAG Constitution

## Core Principles

### I. Project-Local and Lightweight
The core must remain usable with a CLI, a project folder, Git, and installed worker tools. Advanced planning, reliable execution, factory evaluation, and the viewer are optional capabilities, not prerequisites. No feature may require a cloud control plane, accounts, an external database, message broker, or vector store.

### II. Evidence-Bound Acceptance
Every accepted result must be attributable to its specification, executed checks, reviewer verdicts, and source revision. Measurements of risk, evidence, confidence, and convergence must remain separately interpretable. The project must never present a single universal code-quality grade that hides missing evidence or unresolved defects.

### III. Preserve Proven Contracts
Completion-driven scheduling, arbitrary command workers, harness fallback chains, per-task worktrees, planning manifests, review and repair machinery, retry/timeout/stall/recovery controls, and project-local persistent state are foundational. New work extends these contracts; it must not introduce a second scheduler, reviewer system, or persistent-state authority that duplicates them.

### IV. Smallest Missing Piece
Before implementing any roadmap candidate, classify it as already delivered, needs runtime wiring, needs usability work, or new capability by inspecting the actual command path and tests. Implement the smallest missing increment. Competitor-inspired ideas are hypotheses until verified against this codebase.

### V. Honest Claims
Public comparisons must name the comparison set, tested versions, workloads, settings, and results, and must mark unavailable measurements explicitly. Competitor documentation describes claimed capabilities, not independently measured reliability. Failed attempts and limitations are part of the record, not noise to discard.

## Constraints

- Deferred outright: required cloud control plane, accounts, tenancy, or billing; required external database, broker, or vector store; agent social/chat infrastructure unrelated to task acceptance; automatic self-modification of acceptance policies or uncontrolled model escalation; a universal code-quality score; a duplicate scheduler, reviewer system, or state authority.
- Optional capabilities must never silently enable costly stages; profiles recommend, they do not coerce.
- Ownership, review, retry, and evidence contracts must survive every refactor; preservation beats parity with competitor feature counts.

## Development Workflow

- Specs live in `specs/NNN-short-name/` and pass the Spec Kit quality checklist before planning.
- Each spec states its lightweight boundary and its roadmap classification (delivered / wiring / usability / new).
- Behavioral acceptance runs against the final integrated checkout; incomplete runs score as incomplete.
- Recovery, reuse, and receipt features must be certified by injected-failure or stale-evidence tests, not by unit tests alone.

## Governance

This constitution supersedes ad-hoc practices for specification and planning work. Amendments require an updated article, a dated note in the amendment log below, and a migration plan for specs already in flight. Reviewers of `/speckit.plan` and `/speckit.tasks` output must flag work that violates these principles.

**Amendment Log**

- 2026-10-13: v1.0.0 ratified from the October 2026 roadmap ("Lightweight DAG: roadmap toward a leading coding-agent orchestrator").

**Version**: 1.0.0 | **Ratified**: 2026-10-13 | **Last Amended**: 2026-10-13
