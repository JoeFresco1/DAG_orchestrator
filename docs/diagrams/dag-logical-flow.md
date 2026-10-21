# DAG logical flow

Current working-tree behavior, including the local review simplification changes.
The numbered diagrams below describe the legacy ordinary path. The opt-in
[lean profile](../lean-execution-profile.md) disables inferred task planning and
nested review/upstream repair redos, runs canonical local checks before review,
and rejects reviewer changes to the candidate source. Both paths retry malformed
marker review once through the reviewer alone, then record `review-protocol`
without regenerating implementation. Supported Codex bulk prompts use stdin;
other known coding adapters receive file references for large text arguments.
See the
[implementation status](../recommendations-implementation.md) for the completed workstreams and validation scope.
This describes the canonical planning path and ordinary DAG runner. Optional
reliability-controller recovery is shown separately; it does not run in addition
to the runner's normal review and repair loops.

## Lean execution path

```mermaid
flowchart TD
    A[Pinned shared baseline and normalized requirements] --> B[Deterministic graph admission and frozen definitions]
    B --> C[Ready tasks acquire ownership and resource capacity]
    C --> D[Persist attempt identity, shared budget and deadline]
    D --> E[Implement in an attempt-specific worktree]
    E --> F[Executable local checks and selected-test evidence]
    F --> G[Artifact risk selects exemption or one read-only reviewer]
    G --> H{Structured final report valid?}
    H -->|No| R[One review-only protocol retry]
    R -->|Still invalid| Q[Quarantine gate and pause failing adapter]
    H -->|Accepted| I[Prepare detached candidate from accepted head plus task]
    I --> J[Check actual candidate and already accepted boundaries]
    J -->|Failure| K[Retain rejected candidate and bounded shared-budget repair]
    K --> E
    J -->|Pass| L[Flush source-bound publication intent]
    L --> M[Conditional Git ref publication]
    M --> N[Persist acceptance receipt and task evidence]
    N --> O[Release success-dependent consumers]
    O --> C
    M -->|Crash or state write failure| P[Reconcile durable intent with accepted ref]
    P --> N
    O --> S[Declared composed and final requirement verification]
    S --> T[User-controlled promotion to main]
```

The initial implementation plus two repairs share one persisted allowance. A
task's 45-minute deadline also covers infrastructure retries and integration
queue waiting. Failed/skipped work remains distinct from integrated acceptance.
The detached candidate cannot publish when checks fail, source changes, its
attempt becomes obsolete, or the accepted head changes. Previously published
work is reconciled after interruption without another implementation dispatch.

## Overview

```mermaid
flowchart TD
    A[Specifications and repository instructions] --> B[Decompose into canonical planning manifest]
    B --> C[Deterministic plan validation]
    C --> D{Valid?}
    D -->|No| E[Report concrete findings and revise plan]
    E --> C
    D -->|Yes| F[Independent planning review when required or requested]
    F --> G[Compile admitted plan into existing DAG tasks]
    G --> H[Run admission, lock and isolation setup]
    H --> I[Schedule ready tasks within concurrency limit]
    I --> J[Execute and verify each task]
    J --> K[Land accepted work and record evidence]
    K --> I
    I -->|No runnable or active tasks| L[Evaluate convergence]
    L --> M[Configured final review and requirement evidence check]
    M --> N{All required work accepted?}
    N -->|Yes| O[Successful run]
    N -->|No| P[Failed, blocked, stopped or unfinished run]
```

Integration verification is an ordinary downstream task consuming completed
outputs. Its position comes from dependencies; there is no mandatory extra
integration agent after every task.

## 1. Decomposition and deterministic validation

```mermaid
flowchart TD
    A[Read specifications, instructions and established interfaces] --> B[Register original requirements and acceptance criteria]
    B --> C[Assign each criterion a local, integration or final verification owner]
    C --> D[Define small tasks with checks, inputs, outputs and ownership]
    D --> E[Validate schema, source revisions and sizing]
    E --> F[Resolve declared capabilities against baseline or producers]
    F --> G{Producer resolution}
    G -->|Verified baseline| H[No producer task dependency needed]
    G -->|Unique compatible producer| I[Add evidenced producer dependency]
    G -->|Missing, ambiguous or incompatible| X[Blocking finding]
    H --> J[Check coverage, interfaces, dependency reasons and cycles]
    I --> J
    J --> K[Lint acceptance paths and available static imports]
    K --> L{Inputs owned locally, upstream or pinned baseline?}
    L -->|No| X
    L -->|Yes| M[Record write exclusions without inventing semantic dependencies]
    M --> N{Blocking findings remain?}
    N -->|Yes| X
    N -->|No| O[Deterministically valid plan]
    X --> P[Revise plan while preserving original requirements]
    P --> E
```

Default sizing is 800 authored characters, at most two owned acceptance criteria,
and one output concern per task. Static lint is deliberately limited: dynamic
loaders, aliases and package scripts may require explicit `check.files` and can
produce nonblocking tracing warnings. Existing files need verified baseline
authority; their presence alone does not prove a prerequisite is available.

## 2. Independent planning review and compilation

```mermaid
flowchart TD
    A[Deterministically valid plan] --> B{Semantic review required or requested?}
    B -->|No| K[Compile plan]
    B -->|Yes| C[One independent reviewer reads authoritative contract and context]
    C --> D[Validate revision, evidence and specific findings]
    D --> E{Outcome}
    E -->|Pass| K
    E -->|Inconclusive or invalid response| S[Stop without approval]
    E -->|Concrete blocking failure| F{Correction helper enabled and unused?}
    F -->|No| S
    F -->|Yes| G[Apply one correction to blocking findings]
    G --> H{Plan changed and requirements preserved?}
    H -->|No| S
    H -->|Yes| I[Repeat deterministic validation]
    I -->|Invalid| S
    I -->|Valid| J[One semantic recheck]
    J -->|Pass| K
    J -->|Fail or inconclusive| S
    K --> L[Topologically create normal DAG tasks]
    L --> M[Attach manifest, revision and definition fingerprints]
    M --> N[Ready for run admission]
```

The correction helper is an optional API, not an automatic loop inside every
`dag plan review`. Review instructions reserve blocking for concrete execution
problems; polish and speculative suggestions remain nonblocking. A changed plan
must not silently reuse approval for an earlier revision. The project coordinator
may reuse accepted unchanged review packets using its existing evidence checks.

New canonical tasks retain configured reviewers but have `reviewRounds: 0`:
one review pass, no implicit implementation redo. Existing persisted policies
are preserved. Legacy manually authored DAGs remain supported without acquiring
a canonical planning contract automatically.

## 3. Run admission and parallel scheduling

```mermaid
flowchart TD
    A[Start or resume run] --> B[Validate attached plan, admission evidence and runtime settings]
    B --> C{Admitted?}
    C -->|No| S[Refuse launch with reason]
    C -->|Yes| D[Acquire run lock and recover interrupted task records]
    D --> E[Set up requested worktree isolation]
    E -->|Setup fails| S
    E -->|Ready| F[Scan pending and ready tasks in deterministic order]
    F --> G{Dependencies complete and approval gate open?}
    G -->|No| W[Leave task waiting]
    G -->|Yes| H{No planning hold or active write conflict?}
    H -->|No| W
    H -->|Yes| I{Concurrency slot and wall budget available?}
    I -->|Yes| J[Launch task]
    I -->|No| W
    J --> K[Task settles and frees slot]
    K --> F
    W --> L{Any task still running?}
    L -->|Yes| K
    L -->|No| M[Evaluate completed, failed, gated and blocked work]
```

Shared writes can exclude concurrent execution without adding a producer-consumer
edge. A freed slot is refilled immediately. Failed dependency handling follows
the configured policy; a blocked or skipped task does not become accepted work.

## 4. One task attempt

```mermaid
flowchart TD
    A[Begin attempt and capture dependency evidence] --> B[Create isolated task worktree when enabled]
    B --> C[Prepare environment and apply configured contract guard]
    C --> D[Probe declared prerequisites]
    D -->|Unavailable| X[Failure handling]
    D -->|Available| E{Task plan command configured?}
    E -->|Yes and ordinary runner| F[Run task implementation planning command]
    E -->|No or controller managed| G[Run worker command]
    F -->|Success| G
    F -->|Failure| X
    G --> H[Inspect grounded planning reports and enforce exit policy]
    H -->|Failure| X
    H -->|Proceed| I[Configured postcondition and contract guards]
    I --> J{Controller managed?}
    J -->|Yes| K[Controller owns semantic verification]
    J -->|No| L[Run configured task reviewers]
    L -->|Reject or infrastructure error| X
    L -->|Pass or no reviewer configured| M[Run canonical local and provided-capability checks]
    K --> M
    M -->|Fail| X
    M -->|Pass| N[Validate source revisions and write ownership]
    N -->|Invalid| X
    N -->|Valid| O[Commit and merge worktree when enabled]
    O -->|Conflict| X
    O -->|Landed| P[Record acceptance evidence and complete task]
```

Hard timeouts, silence policy and stop requests apply during subprocess phases.
Supported native `codex exec` prompts travel through stdin, including review
context, so the full specification does not overflow Windows command arguments.
Task-local checks run after reviewers so evidence describes the artifact being
landed. A task's local success does not satisfy downstream integration criteria.

## 5. Ordinary-runner failure routes

```mermaid
flowchart TD
    A[Attempt, reviewer or merge failure] --> B{Grounded planning defect triggers hold?}
    B -->|Yes| C[Hold task and preserve evidence]
    C --> D[Stop affected execution and propose correction]
    D --> E[Validate supported stopped amendment before continuation]
    B -->|No| F{Failure class}
    F -->|Worker or environment failure| G{Configured attempt budget remains?}
    G -->|Yes| H[Backoff and schedule next allowed attempt]
    G -->|No| K[Consider explicitly configured upstream repair]
    F -->|Reviewer rejects work| I{Explicit review redo remains?}
    I -->|Yes| J[Feed rejection into bounded implementation redo]
    I -->|No| K
    F -->|Merge conflict| M{Merge redo budget remains?}
    M -->|Yes| N[Redo on updated integration base]
    M -->|No| K
    K --> O{Repair configured and budget available?}
    O -->|No| P[Fail task and retain available work or logs]
    O -->|Yes| Q[Requeue eligible upstream tasks and stale completed descendants]
    Q --> R[Rerun consumer after prerequisites settle]
```

New canonical tasks have no implicit review redo. Grounded future-file ownership
failures hold immediately; other planning reports must meet the runtime evidence
rules and can require repetition. Generic missing-module text alone is not proof
of a graph defect.

The existing `repairRounds` mechanism can requeue completed descendants broadly.
It is different from a project-authored integration repair task and is not
automatically enabled by these changes. This diagram exposes that existing route;
it does not recommend enabling it for every integration node.

## 6. Optional reliability-controller recovery

```mermaid
flowchart TD
    A[Controller preflight and durable ledger] --> B[Launch engine batch with controller-managed verification]
    B --> C{Engine result}
    C -->|Accepted work| D[Continue eligible tasks]
    C -->|Failure| E[Classify typed failure and inspect retained evidence]
    E --> F{Suspension required?}
    F -->|Yes| S[Persist suspension and stop affected work]
    F -->|No| G[Obtain typed diagnosis and registered repair scope]
    G -->|Unavailable| H[Bounded infrastructure handling or suspension]
    G -->|Repair justified| I[Prepare isolated recovery worktree]
    I --> J[Run bounded repair within configured model ceiling]
    J --> K[Guard ownership and protected acceptance]
    K --> L[Run deterministic checks and configured independent review]
    L -->|Rejected| M{Allowed recovery budget remains?}
    M -->|Yes| J
    M -->|No| S
    L -->|Verified| N[Commit and publish with durable receipts]
    N --> O[Supported task requeue and prerequisite recheck]
    O --> B
    S --> P[Reasoned stopped amendment or continuation when authorized]
```

The controller has separate infrastructure and substantive rejection budgets.
Its state machine retains receipts across interruption. It is an optional
execution mode, not another mandatory review layer after the ordinary runner.

## 7. Integration and final convergence

```mermaid
flowchart TD
    A[Implementation tasks land accepted outputs] --> B[Downstream integration task becomes ready]
    B --> C[Verify composed behavior using upstream evidence]
    C -->|Pass| F[Record integration acceptance]
    C -->|Small cross-component defect| D{Project-authorized repair pass available?}
    D -->|Yes| E[One bounded integration repair and recheck]
    D -->|No| X[Report failure]
    E -->|Pass| F
    E -->|Fail| X
    F --> G[Run remaining final requirement verification tasks]
    G --> H[Run configured end-of-run code review]
    H -->|Rejection with explicit redo budget| I[Requeue affected task with review notes]
    I --> A
    H --> J[Check required acceptance evidence and run outcome]
    J --> K{Required coverage complete and no unresolved failure?}
    K -->|Yes| L[Successful completion]
    K -->|No| X
```

The one-pass integration repair policy belongs to the analytics project; generic
DAGs must declare their own policy. It cannot stand in for missing implementation
or weaken final acceptance. End-of-run code review is optional and distinct from
executable requirement verification; its behavior depends on the saved review
mode and budgets. A run-level final-review failure is advisory to task state but
still produces an unsuccessful run outcome.

## Code anchors

- `src/planning/validation.ts`: `validatePlan`
- `src/planning/acceptance-lint.ts`: `lintAcceptance`, `forwardReferenceFailure`
- `src/planning/review.ts`: `reviewPlan`, `reviewCorrectionCycle`
- `src/planning/compile.ts`: `compilePlan`, `plannedTaskInput`
- `src/planning/runtime.ts`: planning admission, holds and acceptance evidence
- `src/runner.ts`: `start`, `runTasks`, `executeTask`, `reviewPass`, `failAttempt`,
  `tryRepair`, `finalReviewPass`
- `scripts/reliability/controller.mjs`: optional durable recovery controller
- `src/codex-transport.ts`: supported Codex prompt transport
