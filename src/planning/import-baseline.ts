import { execFileSync } from 'node:child_process';
import { digest, type PlanningManifest } from './contracts.js';

export function validatePinnedBaseline(plan: PlanningManifest, root: string, add: (rule: string, references: string[], message: string) => void): void {
  if (!plan.provenance) return;
  const commit = plan.provenance.baselineCommit;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, stdio: 'pipe', windowsHide: true });
    for (const source of plan.provenance.baselineSources) {
      const contents = execFileSync('git', ['show', `${commit}:${source.path}`], { cwd: root, stdio: 'pipe', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      if (digest(contents) !== source.sha256) add('import.baseline-source', [source.path, commit], 'Pinned baseline source does not match the Git object');
    }
  } catch { add('import.baseline-unavailable', [commit], 'Pinned baseline must exist and be an ancestor of the repository HEAD with readable sources'); }
}
