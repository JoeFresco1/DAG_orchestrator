import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson } from '../store.js';
import { budgetedPlan, type ReviewSpec } from './build-plan.js';
import type { FlowPlan } from './contracts.js';

interface PlanningReceipt {
  spec: string;
  limit: number;
  reserved: number;
  attempts: number;
  plan?: FlowPlan;
  error?: string;
}

const planner = `Read the repository and its available skills. Return only one JSON object for a Flow 3 plan.
Fields: version:3, title, nodes, settings:{waveChecks:[command],finalChecks:[command]}.
Each node needs id, goal, depends_on (task IDs), touches (editable paths), creates (exact paths/symbols),
relies_on (consumed artifacts), verify (one fast behavioral command runnable with just its prerequisites).
Commands are executable plus arguments, no shell chaining. Use local offline checks. Do not invoke agents or paid services in checks.
Group by observable user outcomes. Name applicable installed skills in skills, and project paths in references.
For UI, designate one node experience:"design" to establish a real journey and reusable visual reference.
Mark remaining UI builders experience:"implement" and reference that artifact. Include exactly one final experience:"qa"
node to exercise integrated journeys, clean up reproducible problems and write a QA report with preview instructions.
Review specifications supplied with the build are scheduled separately after implementation and before QA. Do not add review nodes yourself.
Keep cross-feature checks in finalChecks. Identify tangible evidence and pass conditions, including desktop/mobile for UI.
Preserve every product requirement. Use the existing stack and make reasonable reversible choices.`;

export function planBuild(receipt: string, root: string, spec: string, limit: number, reviewSpecs: ReviewSpec[]) {
  const state: PlanningReceipt = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) :
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
        { cwd: root, input: planner + '\nPrevious planning issue: ' + (state.error ?? 'none') + '\nSpec:\n' + spec,
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
      try {
        run = budgetedPlan(state.plan, spec, limit, state.reserved, reviewSpecs);
      } catch (error) {
        state.error = String(error);
        delete state.plan;
        atomicWriteJson(receipt, state);
      }
    }
  }
  return run;
}
