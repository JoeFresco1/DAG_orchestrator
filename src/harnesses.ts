// Harness presets: how to drive a given agent CLI non-interactively, with the
// token vocabulary this orchestrator provides. Presets are data, so adding a
// tool is a few lines rather than a code path.
//
// Tokens available in every template: {spec} {id} {title} {plan} {planFile}
// {deps} {depsAll} {depsFile} {model} {variant} {lastRejection}. A `--model`
// or `-m` flag whose {model} is unset is removed entirely, so presets can
// always include it.

export interface Harness {
  name: string;
  label: string;
  /** Binary used to detect the tool and to spawn it. */
  binary: string;
  /** Non-interactive command for a task. */
  cmd: string;
  /** Plan-then-stop variant, when the tool can do one. */
  planCmd?: string;
  /** Verdict-emitting review prompt (the tool must end with VERDICT: …). */
  reviewCmd?: string;
  /** Command that lists models, when the tool has one. */
  modelListCmd?: string;
  /** True when this preset was verified against the real CLI. */
  verified: boolean;
  notes?: string;
}

const VERDICT_RULE =
  'End your reply with exactly one line: VERDICT: PASS or VERDICT: FAIL: <reason>.';

export const HARNESSES: Harness[] = [
  {
    name: 'opencode',
    label: 'opencode',
    binary: 'opencode',
    cmd: 'opencode run --auto -m {model} --variant {variant} {spec}',
    planCmd: 'opencode run --auto -m {model} --variant {variant} --agent plan {spec}',
    reviewCmd: `opencode run --auto -m {model} --variant {variant} Inspect the real files and run the checks this acceptance criterion needs. ${VERDICT_RULE} {spec}`,
    modelListCmd: 'opencode models',
    verified: true,
    notes: 'reads the repo, edits files, runs commands; --auto skips approvals',
  },
  {
    name: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    cmd: 'claude -p --dangerously-skip-permissions --model {model} {spec}',
    planCmd: 'claude -p --dangerously-skip-permissions --model {model} Produce a step-by-step implementation plan (files to touch, order, verification) and stop. Output only the plan: {spec}',
    reviewCmd: `claude -p --dangerously-skip-permissions --model {model} Inspect the real files and run the checks this acceptance criterion needs. ${VERDICT_RULE} {spec}`,
    verified: true,
    notes: '-p prints and exits; skip-permissions is required to run unattended',
  },
  {
    name: 'codex',
    label: 'Codex CLI',
    binary: 'codex',
    cmd: 'codex exec --dangerously-bypass-approvals-and-sandbox -m {model} {spec}',
    planCmd: 'codex exec --dangerously-bypass-approvals-and-sandbox -m {model} Produce a step-by-step implementation plan (files to touch, order, verification) and stop. Output only the plan: {spec}',
    reviewCmd: `codex exec --dangerously-bypass-approvals-and-sandbox -m {model} Inspect the real files and run the checks this acceptance criterion needs. ${VERDICT_RULE} {spec}`,
    verified: true,
    notes: 'exec is the non-interactive mode; bypass flag is required unattended',
  },
  {
    name: 'cursor-agent',
    label: 'Cursor CLI',
    binary: 'cursor-agent',
    cmd: 'cursor-agent -p --force --model {model} {spec}',
    planCmd: 'cursor-agent -p --force --model {model} Produce a step-by-step implementation plan and stop. Output only the plan: {spec}',
    reviewCmd: `cursor-agent -p --force --model {model} Inspect the real files and run the checks this acceptance criterion needs. ${VERDICT_RULE} {spec}`,
    verified: false,
    notes: 'not verified against the real CLI (not installed on this machine)',
  },
  {
    name: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    cmd: 'gemini -p --model {model} {spec}',
    reviewCmd: `gemini -p --model {model} Inspect the real files and run the checks this acceptance criterion needs. ${VERDICT_RULE} {spec}`,
    verified: false,
    notes: 'not verified against the real CLI (not installed on this machine)',
  },
  {
    name: 'shell',
    label: 'plain shell command',
    binary: '',
    cmd: '',
    verified: true,
    notes: 'no agent: the task command is whatever you write',
  },
];

export function findHarness(name: string): Harness | undefined {
  return HARNESSES.find((h) => h.name === name);
}

export interface HarnessApply {
  cmd?: string;
  planCmd?: string;
  reviewCmd?: string;
}

// Which fields a preset can supply, so `dag set --harness` never blanks a
// command the user wrote unless the preset replaces it.
export function harnessCommands(
  harness: Harness,
  opts: { withPlan?: boolean; withReview?: boolean },
): HarnessApply {
  const out: HarnessApply = {};
  if (harness.cmd) out.cmd = harness.cmd;
  if (opts.withPlan && harness.planCmd) out.planCmd = harness.planCmd;
  if (opts.withReview && harness.reviewCmd) out.reviewCmd = harness.reviewCmd;
  return out;
}
