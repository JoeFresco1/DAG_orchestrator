# Importing plan fragments and counting selected tests

`dag plan normalize --fragments fragments.json --out plan.json --cwd <repo> --json`
(also available as `dag plan merge`) validates and writes one canonical version 2
manifest. A blocked import reports findings and leaves the output file untouched.

The input wrapper is version 1:

```json
{
  "version": 1,
  "id": "combined-plan",
  "title": "Combined plan",
  "baseline": { "commit": "<40-character Git commit>", "sources": [] },
  "fragments": [
    {
      "namespace": "feature_a",
      "baselineCommit": "<same Git commit>",
      "manifest": "<a complete version 2 manifest object>",
      "sharedTasks": ["task_contracts"]
    }
  ]
}
```

The placeholder `manifest` above must be an object. Each fragment names the same
baseline commit. The importer verifies that it exists and is an ancestor of
repository HEAD. Optional baseline source entries use `{ "path": "src/file.ts",
"sha256": "<64-character digest>" }` and are checked against Git blobs at that
commit. They describe starting code and may change during implementation.
Each manifest's authoritative `sources` remain immutable inputs.

Requirement, criterion, check and local task identities receive the fragment
namespace. Original requirement and criterion identities and manifest digests
remain in provenance. Capabilities and interface identities remain global.
Declare a producer task in `sharedTasks` in each fragment that repeats it. Shared
tasks merge only when execution, files, contracts and interfaces agree; their
requirements, acceptance and checks are retained. Consumers can name a shared
producer owner from another fragment, or let the global capability registry
resolve it. Conflicting producers, source contents, shared identities, sizing,
reviewers and resource capacities block the import. Import order does not change
the result. Normal validation still applies, including the task sizing budget;
split shared verification if merged acceptance exceeds it.

Known test entry points require a selected-count contract: pytest, Vitest, Jest,
Mocha, common package-manager test scripts, Python's `-m pytest` and Node's
`--test`. Custom opaque test commands opt in explicitly. Compiler and linter
checks retain exit-code behavior. A test check uses this contract:

```json
{
  "id": "unit-tests",
  "program": "node",
  "args": ["--test", "dist/example.test.js"],
  "timeoutMs": 60000,
  "kind": "test",
  "selectedTests": { "pattern": "^# tests (\\d+)$" }
}
```

The regular expression captures the selected count in group 1. Exactly one
numeric summary must match combined stdout and stderr (ANSI color is stripped).
An absent, ambiguous, malformed or zero count fails even when the runner exits
zero. `allowEmpty: true` explicitly permits zero, but still requires a valid
summary. Use a pattern matching the chosen runner's actual report format.
`kind: "command"` is an explicit exemption from test selection policy, including
for a recognized runner command; it retains exit-code-only verification. Successful
checks emit `DAG_CHECK_EVIDENCE` with the check ID, selected count and empty-test
policy. Count capture is bounded to 16 MB and fails closed on overflow.

Scheduling write exclusion uses host path semantics, directory overlap and
existing realpath aliases, independently of dependency ordering. Resource
capacity admission remains atomic across every declared resource.

`dag status --json` adds an `execution` snapshot while preserving its existing
summary fields. It distinguishes dependency-ready width, currently admissible
width and the launchable set after available slots and simultaneous ownership
or resource contention. Each queued task carries structured wait reasons.
Phase durations and invocation outcomes accumulate across retries. Milestone
counts describe tasks that have reached each phase, while accepted criterion
and complete requirement counts require current canonical acceptance evidence.
Missing mandatory criteria and requirements remain visible even if their owners
were skipped. Throughput uses elapsed time from first dispatch, ending at the
last recorded finish once the run is terminal; undispatched runs have no rate.
Published receipt summaries inspect the saved publication stage and run/task
attempt identity. Git history reconciliation remains the runner's responsibility.
