import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { flag, flagRequired } from '../cli-args.js';
import { acquireLock, loadRun, runPaths, saveRun } from '../store.js';
import { safeRelativePath } from '../flow3/contracts.js';
import type { ReviewSpec } from '../flow3/build-plan.js';
import { planBuild } from '../flow3/build-planner.js';
import { isGitRepo } from '../git-worktree.js';
import { runCmd } from './run.js';

export { budgetedPlan, type ReviewSpec } from '../flow3/build-plan.js';


function readReviewSpecs(argv: string[], root: string): ReviewSpec[] {
  const reviewSpecs: ReviewSpec[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--review-spec') continue;
    const given = argv[++i];
    if (!given) throw Error('--review-spec requires a file path');
    const path = relative(root, resolve(given)).replaceAll('\\', '/');
    if (!safeRelativePath(path)) throw Error('Review specs must be inside the target repository');
    reviewSpecs.push({ path, content: readFileSync(resolve(given), 'utf8').trim() });
  }
  return reviewSpecs;
}

export async function buildCmd(argv: string[]): Promise<void> {
  const file = resolve(flag(argv, 'file') ?? 'dag.run.json');
  const root = dirname(file);
  const reviewSpecs = readReviewSpecs(argv, root);
  const mainSpec = readFileSync(resolve(flagRequired(argv, 'spec')), 'utf8').trim();
  const spec = [mainSpec, ...reviewSpecs.map(review => `Review requirements from ${review.path}:\n${review.content}`)].join('\n\n');
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
      const run = planBuild(receipt, root, spec, limit, reviewSpecs);
      saveRun(run, file);
    }
  } finally { unlock(); }
  await runCmd(['--file', file]);
  const saved = loadRun(file);
  const built = saved.flowState?.productComplete;
  if (built) console.log(`QA and preview instructions: git show dag/${saved.id}:docs/build/qa.md`);
  console.log(`Build ${saved.flowState?.productComplete ? 'accepted' : 'incomplete'} on dag/${saved.id}. Reserved Claude budget $${((saved.flowState?.reservedCents ?? 0) / 100).toFixed(2)} of $${amount}.`);
}
