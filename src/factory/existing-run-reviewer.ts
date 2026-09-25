import { compileContext, type ContextNote, type ContextPacket } from './context-compiler.js';
import type { CodeGraphIndex } from './code-graph.js';
import type { DefectHypothesis } from './hypotheses.js';
import type { Run } from '../types.js';
import { createVerificationPacket, renderVerificationPrompt, type VerificationPacket } from './verification.js';

export interface ExistingRunReviewerOptions {
  run: Run;
  hypothesis: Pick<DefectHypothesis, 'id' | 'claim'>;
  rootDir: string;
  index: CodeGraphIndex;
  specPaths?: string[];
}

export interface ExistingRunReviewAdapter {
  runId: string;
  context: ContextPacket;
  verification: VerificationPacket;
  prompt: string;
}

/**
 * Adapt an already stored DAG run into a read-only adversarial verification
 * request. The adapter does not start a runner, rewrite the run, or edit code.
 */
export function adaptExistingRunForVerification(options: ExistingRunReviewerOptions): ExistingRunReviewAdapter {
  const tasks = Object.values(options.run.tasks).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const notes: ContextNote[] = tasks.flatMap((task) => {
    const content = [
      `task=${task.id} status=${task.status}`,
      `title=${task.title}`,
      task.result ? `result=${task.result}` : '',
      task.reviewResult ? `review=${task.reviewResult}` : '',
      task.finalReview ? `finalReview=${task.finalReview.verdict}: ${task.finalReview.reason}` : '',
      task.commit ? `commit=${task.commit}` : '',
    ].filter(Boolean).join('\n');
    return [{ id: `run:${options.run.id}:task:${task.id}`, title: `Existing run task ${task.id}`, content }];
  });
  const request = `Adversarially verify hypothesis ${options.hypothesis.id}: ${options.hypothesis.claim}. Run ${options.run.id}; objective: ${options.run.objective}`;
  const context = compileContext({
    index: options.index,
    rootDir: options.rootDir,
    request,
    specPaths: options.specPaths,
    previousFindings: notes,
    maxEvidence: 80,
    maxChars: 48_000,
  });
  const verification = createVerificationPacket(options.hypothesis, context);
  return {
    runId: options.run.id,
    context,
    verification,
    prompt: [
      `Existing run ${options.run.id}: ${options.run.objective}`,
      `Task outcomes:\n${tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}${task.result ? ` — ${task.result}` : ''}`).join('\n') || '(no tasks)'}`,
      renderVerificationPrompt(verification),
    ].join('\n\n'),
  };
}
