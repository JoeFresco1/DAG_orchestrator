#!/usr/bin/env node
// Zero-dependency CLI entry point. All argument parsing and command
// implementations live under ./cli-args.ts and ./commands/; this file only
// dispatches the first argument and prints the help text.
import { COMMANDS } from './commands/index.js';

const HELP = `DAG Orchestrator
usage: dag <cmd> [flags]

  launch [--all | --dir F ...] [--open] [--auto-resume]
                               one server per project, stable port each
  servers [--json] | servers --stop --all|--dir F
  projects [list|add --dir F [--name N]|rm <id|path|name>|open <id|name>]
                               open: hub page for one project
  serve [--file F] [--port 8787] [--open] [--auto-resume] [--kill-orphans]
                               no --file: one hub for every registered project
  schedule add --file F [--name N] [--at "YYYY-MM-DD HH:MM"] [--after JOB]
      [--concurrency N] [--retries N] [--timeout SEC] [--silence SEC]
      [--max-hours H] [--on-dep-failure block|skip] [--gates wait|skip]
  schedule list | schedule rm <job> | schedule clear
  scheduler [--poll SEC] [--once] [--drain] [--watch] [--open]
                               run scheduled jobs one at a time
  init --objective "..."        new run file
  add --title T --spec S [--deps a,b] [--cmd "..."] [--retries N]
      [--timeout SEC] [--silence SEC] [--plan-cmd "..."] [--review-cmd "..."]
      [--review-rounds N] [--repair-rounds N]
  edit --id ID [--title T] [--spec S] [--deps a,b | --clear-deps] [--cmd C]
      [--status S] [--retries N] [--timeout SEC] [--silence SEC]
      [--plan-cmd C] [--review-cmd C] [--review-rounds N] [--repair-rounds N]
  rm --id ID                   delete node, strip it from others' deps
  list [--status S] [--limit N] | status | ready | blocked
  retry --id ID [--cascade]    requeue failed task (cascade: its failed subtree)
  retry-failed [--cascade]     requeue every failed task
  review --of a,b --cmd "check" [--title T] [--repair-rounds N]
                               scaffold an integration node (repairs upstream on failure)
  review --id X --review-cmd "check" [--review-rounds N]
                               attach a reviewer postcondition to a task
  show --id ID                 full task detail incl. review/verdict/logs
  reviewer list --id ID        reviewers attached to a task
  reviewer add --id ID --name N --cmd "..." [--when always|on-reject|diff-lines>N|diff-touches:glob]
      [--verdict marker|exit-code]   each reviewer emits its own verdict
  reviewer rm --id ID --name N
  set-cmd [--all | --only a,b | --match REGEX] --cmd "harness ... {spec}"
  harness [list|show --name N]  agent CLI presets (opencode, claude, codex, …)
  models [--harness N] [--refresh]   models available to that agent CLI
  set --harness NAME            retarget tasks at another agent CLI
  set --harness-chain "a:x,b"   ordered fallback: attempt 1 uses a, 2 uses b
  settings --fail-on-exit       non-zero work exit fails the task (default: auto)
      [--with-review] [--no-plan]
  new-run --objective "..."     archive the active run, start a fresh one
  runs [list] | runs show --id ID | runs archive
  set [--all | --only a,b | --match REGEX]
      [--cmd "..." | --clear-review] [--plan-cmd "..."] [--review-cmd "..."]
      [--review-rounds N] [--repair-rounds N] [--retries N] [--timeout SEC]
      [--silence SEC]
                               bulk edit harness / planner / reviewer / repair
  resume                       requeue tasks interrupted by a crash/restart
  skip-blocked                 mark blocked/gated tasks skipped so the run converges
  kill-orphans                 kill process trees left behind by a crash
  heartbeat --id ID            keep-alive for workers that don't stream stdout
  log [-n 40]                  event log (full history)
  logs --id ID [--attempt N]   per-attempt stdout/stderr
  gc [--days 7]                prune old attempt logs
  final-review [--mode per-task|run] [--rounds N] [--cmd "agent ..."]
  settings --final-review off|per-task|run   end-of-run code review
  layers                       dependency waves in this run
  chain-review --of a,b | --wave N | --from ID | --all [--batch N] [--cmd C]
                               review tasks that review the work of other tasks
  settings [--concurrency N] [--retries N] [--timeout SEC] [--silence SEC]
      [--max-hours H] [--on-dep-failure block|skip] [--gates wait|skip]
      [--notify "command"] [--worktree none|task]
  gate --id ID --question Q | approve --id ID | reject --id ID
  dot                          graphviz chart
  run --file F [--concurrency N] [--only a,b] [--retries N] [--timeout SEC]
      [--silence SEC] [--max-hours H] [--on-dep-failure block|skip]
      [--gates wait|skip] [--worktree none|task] [--kill-orphans] [--dry-run]
      [--force]

Every command accepts --file, --force (override a foreign lock), and --json.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '';
  const argv = process.argv.slice(3);
  const handler = COMMANDS[cmd];
  if (handler) {
    await handler(argv, cmd);
    return;
  }
  // Unknown or missing command: show the help text.
  console.log(HELP);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
