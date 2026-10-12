# Specification decomposition and acceptance lint

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
