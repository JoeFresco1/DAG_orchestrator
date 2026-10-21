# Lean execution profile

New runs created with `dag init` or `dag plan compile` use the checked-publication policy automatically. Coding runs require a Git repository and executable acceptance checks. Historical runs remain readable; explicitly upgrade a stopped historical run before executing it:

```sh
dag run --profile lean --implementation-attempts 1
```

Lean disables inferred task planning, uses task worktrees, and defaults to a 900-second phase timeout. Agent review is optional: when no reviewer is configured, passing executable acceptance proceeds to integration checks and publication. Artifact risk classification does not add an unrequested reviewer. When reviewers are configured, the router selects from them using the changed artifacts, and structured verdict/findings reports are the default.

Generic adapters must write the designated report artifact; `{reviewOutputFile}`/`{reviewSchemaFile}` and `DAG_REVIEW_OUTPUT`/`DAG_REVIEW_SCHEMA` expose its paths. Supported Codex reviews receive final-output and schema flags and run with its read-only sandbox. Source mutation detection is also enforced. Tool versions unavailable to the caller are recorded as unreported; `DAG_REVIEW_TOOL_VERSION` can supply an explicitly captured adapter version.

Task execution has one persisted implementation budget: initial production plus two repairs, including substantive check/review/integration repairs and at most one conflict repair. A harness chain cannot raise this budget. Missing/malformed review bodies get one review-only retry; three protocol failures in five adapter responses open a durable circuit. Infrastructure phase retries default to two. Every phase and integration queue wait remains inside the 45-minute task deadline. Identical failures with unchanged source stop early. Ordinary retry, resume and amendment preserve the ledger. Controller handoffs with an existing ordinary ledger fail closed until budget ownership is explicitly adopted; a controller cannot silently obtain fresh attempts. Controller-managed runs without that ledger retain their existing controller authority.

Set policy for tasks not yet dispatched with explicit settings:

```sh
dag settings --profile lean --timeout 600 --concurrency 3
dag settings --implementation-attempts 3 --task-deadline 2700 --infrastructure-retries 2
dag settings --json
dag settings --effective --json
dag status --json
```

The shared limit and deadline freeze at first dispatch. Changing settings does not reset an existing ledger. Task timeout overrides are retained, subject to the total deadline. Final review is off by default; explicitly requested final review has its own protocol gate and does not regenerate implementation on malformed output. Automatic broad upstream repair has been removed: a rejected task cannot reopen accepted ancestors or reset its siblings. The legacy preset is retired; its saved settings and results remain readable for history and controller compatibility.

An operator can explicitly recover verification of a stopped failed task through `DagRunner`'s `verificationRecovery` option. It restores the saved source (or an explicitly supplied operator correction), skips implementation and planning commands, and reruns checks, review and candidate publication. The original implementation ledger and failed snapshot are retained; recovery has a separate bounded 45-minute verification window and its own bounded review protocol. Prior review packets remain separate. Cache removal is limited to explicitly named Python cache files derived from the task's declared Python source. Normal subprocesses disable incidental bytecode writes and direct explicit Python cache output to the temporary directory.

After local checks and selected review, the runner constructs a detached candidate from the accepted integration ref plus the task output. It reruns this task's checks and capability checks against that combined checkout. Broader regression and composed acceptance belong to explicitly declared integration and final tasks; earlier tasks' checks are not replayed on every publication. A generic task must declare executable deterministic acceptance. Publication requires passing candidate checks, unchanged candidate source, a current attempt, durable intent and a conditional ref update. Failure leaves the accepted head unchanged and retains the candidate and diagnostics. A published candidate becomes dependency-satisfying only with an acceptance receipt. If state persistence fails after publication, dispatch stops and restart reconciles the receipt without reproducing the accepted implementation. The user's branch is preserved; this profile does not automatically promote to main.

`settings --effective` shows the last runner snapshot, including execution mode, effective task policies and an SHA-256 identity of the executing module tree. `status --json` adds phase/queue timings, waits, ready widths, required acceptance coverage and throughput. Receipts live in the run sidecar's `integration` directory; review bodies and protocol records live in `reviews`. Keep these and failed runs for diagnosis. [Fragment import and test counts](fragment-import-and-check-counts.md) describe the additional admission/check contracts.
