// Reviewer policy: which reviewers apply to a task, and why.
//
// `when` is a small string DSL. Clauses are ANDed with ';':
//   always                                  (default when omitted)
//   on-reject                               only after another reviewer rejected
//   diff-lines>250                          only when the work is bigger than N lines
//   diff-touches:src/api/**,src/routers/*   only when a changed path matches a glob
//
// When a condition cannot be evaluated (no diff available because the task ran
// without worktree isolation) the reviewer RUNS: a gate we cannot measure must
// not silently open.

export type ReviewerVerdictMode = 'marker' | 'exit-code';

export interface Reviewer {
  name: string;
  cmd: string;
  when?: string;
  // How this reviewer's verdict is read. Defaults to the run's reviewVerdict.
  verdict?: ReviewerVerdictMode;
  // Free-text note for the operator / UI.
  why?: string;
}

export interface DiffStats {
  lines: number;
  files: string[];
}

export interface WhenClause {
  onReject: boolean;
  minLines: number | null;
  touches: string[] | null;
  invalid: string | null;
}

export function parseWhen(when?: string): WhenClause {
  const out: WhenClause = { onReject: false, minLines: null, touches: null, invalid: null };
  const text = (when ?? 'always').trim();
  if (text === '') return out;
  for (const clause of text.split(';').map((c) => c.trim()).filter(Boolean)) {
    if (clause === 'always') continue;
    if (clause === 'on-reject') {
      out.onReject = true;
      continue;
    }
    const lines = clause.match(/^diff-lines\s*>\s*(\d+)$/i);
    if (lines) {
      out.minLines = Number(lines[1]);
      continue;
    }
    const touches = clause.match(/^diff-touches\s*:\s*(.+)$/i);
    if (touches) {
      out.touches = touches[1]
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      continue;
    }
    out.invalid = clause;
  }
  return out;
}

// Minimal glob matcher: ** crosses directories, * stops at a separator, ?
// matches one character. Paths are normalized to forward slashes first.
export function globMatches(pattern: string, path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i += 1;
        if (pat[i + 1] === '/') {
          // "**/" is zero or more whole directories, so the separator has to
          // belong to the group: "src/**/x" must not match "src/ax".
          re += '(?:[^/]+/)*';
          i += 1;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(norm);
}

export interface ReviewerDecision {
  reviewer: Reviewer;
  run: boolean;
  reason: string;
  onReject: boolean;
}

export function decideReviewers(
  reviewers: Reviewer[],
  diff: DiffStats | null,
  alreadyRejected: boolean,
): ReviewerDecision[] {
  return reviewers.map((reviewer) => {
    const when = parseWhen(reviewer.when);
    if (when.invalid) {
      // Unknown clause: run it and say so rather than quietly dropping a gate.
      return { reviewer, run: true, reason: `unknown condition "${when.invalid}" — running`, onReject: false };
    }
    // Clauses are ANDed: every one that can be evaluated must hold. A clause we
    // cannot evaluate (no diff without worktree isolation) does not close a gate.
    const reasons: string[] = [];
    let run = true;
    if (when.onReject) {
      if (alreadyRejected) reasons.push('runs after a rejection');
      else {
        run = false;
        reasons.push('waits for a rejection');
      }
    }
    if (run && when.minLines !== null && diff) {
      if (diff.lines > when.minLines) reasons.push(`diff is ${diff.lines} lines (>${when.minLines})`);
      else {
        run = false;
        reasons.push(`diff is ${diff.lines} lines (needs >${when.minLines})`);
      }
    }
    if (run && when.touches && diff) {
      const hit = diff.files.find((f) => when.touches?.some((g) => globMatches(g, f)));
      if (hit) reasons.push(`touches ${hit}`);
      else {
        run = false;
        reasons.push(`no changed path matches ${when.touches.join(', ')}`);
      }
    }
    return {
      reviewer,
      run,
      reason: reasons.length > 0 ? reasons.join('; ') : 'always',
      onReject: when.onReject,
    };
  });
}

export function summarizeVerdicts(
  verdicts: Record<string, { verdict: string; reason?: string }>,
): string {
  const entries = Object.entries(verdicts);
  if (entries.length === 0) return '(no reviewers)';
  return entries.map(([name, v]) => `${name}: ${v.verdict}${v.reason ? ` — ${v.reason}` : ''}`).join('\n');
}
