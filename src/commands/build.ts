import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { flag, flagRequired } from '../cli-args.js';
import { acquireLock, atomicWriteJson, loadRun, runPaths, saveRun } from '../store.js';
import { compileFlowPlan } from '../flow3/graph.js';
import type { FlowPlan } from '../flow3/contracts.js';
import { isGitRepo } from '../git-worktree.js';
import { findHarness } from '../harnesses.js';
import { runCmd } from './run.js';

const planner = `Read the repository and its available skills. Return only one JSON object for a Flow 3 plan.
Fields: version:3, title, nodes, settings:{waveChecks:[command],finalChecks:[command]}.
Each node needs id, goal, depends_on (task IDs), touches (editable paths), creates (exact paths/symbols),
relies_on (consumed artifacts), verify (one fast behavioral command runnable with just its prerequisites).
Commands are executable plus arguments, no shell chaining. Use local offline checks. Do not invoke agents or paid services in checks.
Group by observable user outcomes. Name applicable installed skills in skills, and project paths in references.
For UI, designate one node experience:"design" to establish a real journey and reusable visual reference.
Mark remaining UI builders experience:"implement" and reference that artifact. Include exactly one final experience:"qa"
node to exercise integrated journeys, clean up reproducible problems and write a QA report with preview instructions.
Keep cross-feature checks in finalChecks. Identify tangible evidence and pass conditions, including desktop/mobile for UI.
Preserve every product requirement. Use the existing stack and make reasonable reversible choices.`;

export function budgetedPlan(input: FlowPlan, spec: string, limit: number, planning: number) {
  if (!Array.isArray(input.nodes) || !input.nodes.length || !input.settings?.finalChecks?.length || !input.settings.waveChecks?.length)
    throw Error('Plan must provide nodes, wave checks and final acceptance');
  const nodes = structuredClone(input.nodes);
  const qa = nodes.filter(node => node.experience === 'qa');
  if (qa.length !== 1) throw Error('Plan needs one integrated QA task');
  const ui = nodes.filter(node => node.experience === 'implement');
  const designs = nodes.filter(node => node.experience === 'design');
  if ((ui.length || designs.length) && designs.length !== 1) throw Error('UI work needs one design owner');
  for (const node of ui) {
    node.depends_on = [...new Set([...node.depends_on, designs[0].id])];
    node.relies_on = [...new Set([...node.relies_on, ...designs[0].creates])];
  }
  qa[0].depends_on = nodes.filter(node => node !== qa[0]).map(node => node.id);
  const report = 'docs/build/qa.md';
  qa[0].creates = [...new Set([...qa[0].creates, report])];
  qa[0].touches = [...new Set([...qa[0].touches, report])];
  qa[0].goal += ` Record the journeys exercised, observed results, unresolved issues, and preview instructions in ${report}.`;
  const reportCheck = `node -e "if(!require('fs').readFileSync('${report}','utf8').trim())process.exit(1);console.log('QA report present')"`;
  const checks = [...(input.settings.finalChecks ?? []), reportCheck];
  if (designs.length) {
    const screenshots = ['docs/build/desktop.png', 'docs/build/mobile.png'];
    qa[0].creates.push(...screenshots);
    qa[0].touches.push(...screenshots);
    qa[0].goal += ` Capture the integrated primary journey in the browser at desktop and mobile sizes. Save actual screenshots at ${screenshots.join(' and ')}.`;
    for (const image of screenshots) {
      checks.push(`node -e "const b=require('fs').readFileSync('${image}');if(b.length<33||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')process.exit(1);console.log('QA screenshot present')"`);
    }
  }
  const qaCents = Math.max(1, Math.floor((limit - planning) / 6));
  const dispatchCents = Math.floor((limit - planning - qaCents) / (input.nodes.length + 1));
  if (dispatchCents < 1) throw Error('Remaining allowance cannot cover this plan');
  const cmd = findHarness('claude')!.cmd;
  const settings = input.settings;
  const { run } = compileFlowPlan({ version: input.version, title: input.title, cmd,
    nodes: nodes.map(node => ({ ...node, cmd })), settings: {
      waveChecks: settings.waveChecks, finalChecks: checks, requiredEvidence: settings.requiredEvidence,
      checkPrerequisites: settings.checkPrerequisites, productSpec: spec, repairCommand: cmd,
      conflictCommand: cmd, spend: { limitCents: limit, dispatchCents, qaCents },
    } });
  run.flowState = { version: 3, checkpoints: [], issues: [], repairRound: 0, reservedCents: planning };
  return run;
}

export async function buildCmd(argv: string[]): Promise<void> {
  const file = resolve(flag(argv, 'file') ?? 'dag.run.json');
  const spec = readFileSync(resolve(flagRequired(argv, 'spec')), 'utf8').trim();
  const amount = flagRequired(argv, 'max-usd');
  if (!spec || !/^\d+(?:\.\d{1,2})?$/.test(amount)) throw Error('Provide a spec and a positive dollar ceiling with at most two decimals');
  const limit = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(limit) || limit < 4) throw Error('Budget must be at least four cents and fit in integer cents');
  if (!isGitRepo(dirname(file))) throw Error('Place the run file in the target Git repository');
  const receipt = join(runPaths(file).dir, 'build-planning.json');
  const unlock = acquireLock(file, 'spec build');
  try {
    if (existsSync(file)) {
      const saved = loadRun(file);
      if (saved.settings.flow3?.productSpec !== spec || saved.settings.flow3.spend?.limitCents !== limit)
        throw Error('Existing run has a different spec or budget. Use a fresh --file.');
    } else {
      const state = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) :
        { spec, limit, reserved: 0, attempts: 0 };
      if (state.spec !== spec || state.limit !== limit) throw Error('Existing planning reservation belongs to a different build');
      let run;
      while (!run) {
        if (!state.plan) {
          if (state.attempts >= 2) throw Error('Planning allowance exhausted: ' + (state.error ?? 'interrupted planner'));
          const cents = Math.max(1, Math.floor(limit / 12));
          state.reserved += cents;
          state.attempts++;
          atomicWriteJson(receipt, state);
          try {
            const raw = execFileSync('claude', ['-p', '--max-budget-usd', (cents / 100).toFixed(2),
              '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--output-format', 'json'],
              { cwd: dirname(file), input: planner + '\nPrevious planning issue: ' + (state.error ?? 'none') + '\nSpec:\n' + spec,
                encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
            const reply = JSON.parse(raw);
            if (reply.is_error) throw Error(String(reply.result));
            state.plan = JSON.parse(reply.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
          } catch (error) {
            state.error = String(error).slice(-1500);
            atomicWriteJson(receipt, state);
            if (!(error instanceof SyntaxError)) throw error;
          }
          atomicWriteJson(receipt, state);
        }
        if (state.plan) {
          try { run = budgetedPlan(state.plan, spec, limit, state.reserved); }
          catch (error) { state.error = String(error); delete state.plan; atomicWriteJson(receipt, state); }
        }
      }
      saveRun(run, file);
    }
  } finally { unlock(); }
  await runCmd(['--file', file]);
  const saved = loadRun(file);
  const built = saved.flowState?.productComplete;
  if (built) console.log(`QA and preview instructions: git show dag/${saved.id}:docs/build/qa.md`);
  console.log(`Build ${saved.flowState?.productComplete ? 'accepted' : 'incomplete'} on dag/${saved.id}. Reserved Claude budget $${((saved.flowState?.reservedCents ?? 0) / 100).toFixed(2)} of $${amount}.`);
}
