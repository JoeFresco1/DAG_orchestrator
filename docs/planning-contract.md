# Specification decomposition and acceptance lint

## Keep review bounded

Planning review blocks on concrete execution problems: prerequisites, interfaces,
dependency order, ownership conflicts, impossible local acceptance, or lost or
weakened requirements. Test-detail suggestions, report polish and speculative
edge cases remain nonblocking follow-ups for integration. Missing evidence remains
inconclusive. The correction helper allows one correction and one recheck, and
refuses to rerun an unchanged plan. Project reviewers can retain genuinely accepted
unchanged packets using their existing evidence comparison; this adds no second
review cache or planning authority.

New canonical tasks get one task-review pass with **no automatic implementation
redo**. Existing persisted review policies are preserved. Executable local checks
and final requirement verification remain mandatory. A project may explicitly
authorize a bounded integration repair pass for cross-component defects; this
does not silently grant new attempts or authorize accepting unfinished local work.

Native `codex exec` prompts use stdin rather than an oversized command line,
including planning, task reviews and final reviews. Model, reasoning, schema and
other supported options remain in argv. The full context is preserved without
truncating requirements to fit a terminal limit. Other harnesses and explicit
Codex stdin/resume/review subcommands retain their existing input protocols.

New structured plans use one `PlanningManifest` version 2, compiled into the
existing DAG task representation. Existing CLI tasks and version 1 factory goals
keep their previous behavior. This adds no recovery controller or new runner.

Tasks have stable IDs, bounded responsibilities, requirement references, executable
checks, and the acceptance they own. Original criteria retain their text, one
verification owner, and a `local`, `integration`, or `final` stage. Foundational
tasks are judged against their own criteria; deferred obligations remain visible
and required before project certification.

Declared inputs/provides resolve capability dependencies. Unique producers add
evidenced edges. Missing or ambiguous producers, cycles, incompatible interfaces,
missing coverage, and impossible intermediate acceptance block compilation.
Shared writes cause exclusion rather than invented semantic ordering.

```powershell
dag plan validate --plan plan.json --cwd C:\project --json
dag plan compile --plan plan.json --file C:\project\dag.run.json --json
dag run --file C:\project\dag.run.json
```

See `examples/planning-runtime.json`. Checks use `{id, program, args, timeoutMs,
files?}` with literal arguments. Lint traces literal acceptance paths and relative
JS/TS imports, including `.js` references to declared `.ts` sources. Referenced
files require task ownership, a transitive prerequisite, or an exact pinned
baseline from sources, frozen files, or baseline inputs. Existing bytes alone are
insufficient. Findings include the check/import chain and owning task. Imports
never silently create dependency edges.

Use `check.files` for dynamic loaders, package scripts, Python imports, and globs.
Unsupported tracing and generated acceptance sources not yet available produce
nonblocking warnings. Installed harness entrypoints are environment inputs;
ordinary option values are not automatically treated as files. Arbitrary shell
code cannot be exhaustively traced. Legacy tasks without ownership metadata keep
their existing behavior.

Contract-managed execution validates again before launching workers. Failed
plan/work/review phases naming an exact registered future file trigger a planning
hold on the first occurrence, preserving remaining retries and preventing fallback
or repair. Unknown packages and ordinary implementation failures retain their
existing behavior. Unsupported semantic claims do not earn this classification.

Risk-based semantic review uses one bounded reviewer through the existing runner
and context compiler. `dag plan review --plan plan.json` produces a revision-bound
receipt with specific findings; deterministic validation remains mandatory.

Stopped corrections use `dag plan amend --file F --plan corrected.json --reason R`.
Original requirements, accepted work, and attempt history remain preserved.
Interrupted amendments refuse execution until resumed. `dag plan proposal --file F`
reports findings without rewriting active work. Legacy adoption requires explicit
`dag plan migrate`, preserving historical acceptance without inventing receipts.

Factory goals opt in through schema version 2 and retain existing certification
checks. `dag factory upgrade --goal legacy.json --plan plan.json --output upgraded.json`
checks that original acceptance survives and writes a fresh goal. Existing factory
runs are not silently migrated.

## Decomposition budget

Small bounded tasks execute; large ones strand the run. Validation measures every task against a budget and refuses a decomposition that exceeds it, so the split is enforced rather than advised. Fifty small tasks beat ten that fail.

| Rule | Budget | Measured from |
| --- | --- | --- |
| `scope.oversized` | 800 characters | title, objective, reviewBoundary, owned criterion texts, constraints, input/output contract prose, named concerns |
| `scope.acceptance` | 2 criteria | the task's own `acceptance` list |
| `scope.concerns` | 1 output concern | distinct concerns on `implementation` or `generated` files; unlabelled files count separately |

Test files are verification, not outputs, so they never count toward the concern budget. These are ceilings rather than targets: a task at the ceiling is already as large as a single bounded worker session should be. Each finding names the task, the exact measurement, the budget it exceeded, and the split to perform. Sizing runs before ownership reasoning, so an oversized brief is caught before anyone argues about which task verifies what.

Related output files can share a `concern`, for example `{ "path": "src/parser.ts", "role": "implementation", "concern": "Parse the input format" }`. A second file with the same concern counts toward that single behavior. Unlabelled output files each count separately. A shared label is not proof that scope is cohesive: independent semantic review must reject unrelated responsibilities hidden under one broad label.

The 800-character ceiling measures authored task prose, not generated command/identity metadata or deferred acceptance owned by other tasks. Input/output contract prose counts, so moving work from the objective into a contract cannot bypass the ceiling. The validator rejects oversized tasks; the planner must split and revalidate them. It does not automatically rewrite arbitrary prose, truncate criteria, or impose a maximum task count.

For new decomposition, author the canonical manifest first, run `dag plan validate`, split every blocking scope finding while preserving original criterion coverage and prerequisites, and repeat until valid. Run required independent review before compilation. Legacy `dag add` does not enforce canonical planning budgets.

`sizing` on the manifest explicitly overrides the defaults. A decomposition agent should use the defaults unless the user requests another budget; raising a limit is not a substitute for splitting:

```json
{ "sizing": { "maxSpecChars": 1200, "maxAcceptancePerTask": 3, "maxOutputConcerns": 2 } }
```

Every field must be a positive integer; a malformed budget fails closed. The independent semantic reviewer receives the active budget in its instructions and reports the same three rules with the split it would make, so a semantically oversized plan that still passes the character count is caught independently.

## Findings and follow-up backlog

Record discoveries without adding tasks during execution. `dag followups add --file F --input findings.json --task TASK --stage review` accepts a proposal or array of proposals. Each proposal has `id`, `message`, `evidence` and `references`; optional fields are `requirements`, `suggestedOwner`, `acceptance` and `blocking`. References identify existing task, criterion, requirement or file evidence. Repeated findings retain their occurrence history instead of creating duplicate work. Inspect them with `dag followups list --file F --json`.

Workers can emit one `DAG_FOLLOW_UPS: <JSON array>` line. Grounded structured reviewer findings are captured automatically as well. A worker finding marked `blocking: true` fails the current task; malformed discovery packets also fail closed. Optional discoveries leave all checks and review gates in effect. Evidence references are observations, not proof of correctness: known requirement and owner IDs are validated, and triage must assess the cited evidence. Candidate owners are suggested from existing tasks, capabilities, criteria and declared files; they are not automatically assigned.

The run sidecar's `followups.json` stores proposals, occurrences and decision history under its own write lock. Deduplication uses the finding ID with its sorted references and requirements; repeated delivery of the same packet and origin is idempotent. Distinct IDs or changed references remain separate until the coordinator links duplicates, preserving their evidence.

The coordinator classifies each finding with `dag followups triage --file F --id ID --disposition TYPE --reason R`. Use `blocker` for work required by the current task, `existing-task` when a later producer already owns it, `follow-up` for independent additional work, or `dismissed` for unsupported suggestions. `blocker` and `existing-task` require `--owner TASK`; new follow-ups require an acceptance check, provided in the proposal or with `--acceptance CHECK`. Use `--duplicate-of ID` to associate duplicate findings.

These decisions only maintain the backlog. They never waive checks, mark tasks accepted, restart a run, or insert executable tasks. Required missing functionality stays assigned to its existing producer; checks that consume it belong downstream of that producer. Apply any scope or dependency correction through the validated stopped amendment workflow above. Add approved new work through normal planning, preserving original acceptance and attempt history.
