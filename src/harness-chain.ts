// Harness fallback chains: an ordered list of tools to try for one task.
// Attempt 1 uses the first candidate, attempt 2 the second, and so on; once
// the list is exhausted the last candidate keeps being used. The chain length
// raises the attempt budget, so `opencode,codex` means "try opencode, then
// codex" without extra configuration.
import { findHarness, type Harness } from './harnesses.js';

export interface HarnessCandidate {
  harness: string;
  model?: string | null;
  variant?: string | null;
}

// "opencode:model:variant,codex,claude:sonnet" — commas separate candidates,
// colons separate the tool from its model and effort.
export function parseHarnessChain(text: string): HarnessCandidate[] {
  const out: HarnessCandidate[] = [];
  for (const raw of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, model, variant] = raw.split(':').map((s) => s.trim());
    if (!name) continue;
    const harness = findHarness(name);
    if (!harness) {
      throw new Error(`unknown harness "${name}" in chain; try: dag harness list`);
    }
    if (!harness.cmd) throw new Error(`harness "${name}" has no command preset`);
    out.push({
      harness: name,
      model: model || null,
      variant: variant || null,
    });
  }
  return out;
}

/** Render a chain back to its compact "harness:model:variant, ..." form. */
export function formatHarnessChain(chain: HarnessCandidate[]): string {
  return chain
    .map((c) => [c.harness, c.model ?? '', c.variant ?? ''].join(':').replace(/:+$/, ''))
    .join(', ');
}

export interface AttemptPlan {
  candidate: HarnessCandidate;
  harness: Harness;
  /** 1-based index of the candidate used for this attempt. */
  index: number;
  fellBack: boolean;
}

/**
 * Pick the candidate for a 1-based attempt number. The index is clamped to the
 * chain length, so once the list is exhausted the last candidate is retried.
 */
export function planAttempt(
  chain: HarnessCandidate[] | null | undefined,
  attempt: number,
): AttemptPlan | null {
  if (!chain || chain.length === 0) return null;
  const index = Math.min(Math.max(1, attempt), chain.length);
  const candidate = chain[index - 1];
  const harness = findHarness(candidate.harness);
  if (!harness || !harness.cmd) return null;
  return { candidate, harness, index, fellBack: index > 1 };
}

// A chain implies at least one attempt per candidate.
export function attemptsForChain(maxAttempts: number, chain: HarnessCandidate[] | null | undefined): number {
  return Math.max(maxAttempts, chain?.length ?? 0, 1);
}
