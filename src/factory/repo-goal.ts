/** A narrow, honest factory goal for reviewing the current TypeScript repository. */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { buildCodeGraph } from './code-graph.js';
import type { StructuredFactoryGoal } from './controller.js';

export interface RepoReviewOptions {
  command: string;
  recertificationCommand: string;
  checkCommand?: string;
  sourceRunFile?: string;
  codeUnits?: string[];
}

export function createRepoReviewGoal(rootDir: string, options: RepoReviewOptions): StructuredFactoryGoal {
  const root = resolve(rootDir);
  const index = buildCodeGraph({ rootDir: root });
  const files = index.files.map((file) => file.path);
  if (files.length === 0) throw new Error('repository review found no indexed TypeScript files');
  const checkCommand = options.checkCommand ?? inferredCheck(root);
  if (!checkCommand) throw new Error('repository review needs a deterministic check; pass --check "command"');
  const title = `Review ${basename(root)}`;
  return {
    schemaVersion: 1,
    mode: 'review',
    goal: { id: 'repository-review', title, description: 'Review the existing repository and report verified defects.' },
    requirements: [{
      id: 'repository-check', title: 'Current repository behavior',
      description: 'Inspect the indexed code and verify suspected defects against the current source.',
      acceptanceCriteria: [`The configured deterministic check passes: ${checkCommand}.`, 'Verified defects are reported with evidence.'],
    }],
    implementation: [],
    review: { codeUnits: options.codeUnits ?? files, ...(options.sourceRunFile ? { sourceRunFile: options.sourceRunFile } : {}) },
    checks: [{ id: 'repository-check', title: 'Repository check', cmd: checkCommand }],
    phases: {
      review: { command: options.command },
      verification: { command: options.command },
      rootCause: { command: options.command },
      remediation: { command: options.command },
      regression: { command: checkCommand },
      recertification: { reviewCmd: options.recertificationCommand },
    },
    // The single declared flow is the configured check. Product risk coverage is unknown.
    coverage: { criticalFlow: 1, weightedRisk: 0 },
    certificationPolicy: { minimumCriticalFlowCoverage: 1, minimumWeightedRiskCoverage: 0 },
  };
}

function inferredCheck(root: string): string | undefined {
  let pkg: unknown;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); }
  catch { return undefined; }
  if (!pkg || typeof pkg !== 'object' || !('scripts' in pkg)) return undefined;
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') return undefined;
  for (const name of ['test', 'typecheck', 'build']) {
    if (typeof (scripts as Record<string, unknown>)[name] === 'string') {
      return process.platform === 'win32' ? `cmd /c npm run ${name}` : `npm run ${name}`;
    }
  }
  return undefined;
}
