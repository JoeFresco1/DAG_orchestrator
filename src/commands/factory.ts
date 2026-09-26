// Closed-loop software factory commands. Every runnable phase is submitted to
// the existing DagRunner by the controller; this file only handles CLI I/O.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, flag, flagRequired, guard, wantsJson } from '../cli-args.js';
import { factoryStatus, resumeFactory, startFactory, type StructuredFactoryGoal, type FactoryControllerOptions } from '../factory/controller.js';
import type { DagEvent } from '../types.js';

export async function factoryCmd(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? 'status';
  const file = flag(argv, 'file') ?? (subcommand === 'review' ? 'dag.review.json' : 'dag.run.json');
  if (subcommand === 'status') {
    const result = factoryStatus(file);
    emit(argv, result, () => `${result.summary}\n  run: ${result.runId}\n  checkpoint: ${result.state.stage}`);
    return;
  }

  if (subcommand !== 'start' && subcommand !== 'review' && subcommand !== 'resume') {
    throw new Error('usage: dag factory start|review --goal goal.json [--source-run completed-run.json] [--file review-run.json] | factory resume [--assessment evidence.json] [--policy policy.json] | factory status --file run.json');
  }
  guard(file, argv);
  const onEvent = (event: DagEvent): void => {
    const task = event.taskId ? `${event.taskId} ` : '';
    const line = `[${event.ts.slice(11, 19)}] ${event.type.padEnd(16)} ${task}${event.message}`;
    if (wantsJson(argv)) console.error(line);
    else console.log(line);
  };
  const assessmentFile = flag(argv, 'assessment');
  const policyFile = flag(argv, 'policy');
  const options: FactoryControllerOptions = {
    onEvent,
    ...(assessmentFile ? { convergenceAssessment: readAssessment(assessmentFile) } : {}),
    ...(policyFile ? { convergencePolicy: readPolicy(policyFile) } : {}),
  };
  const result = subcommand === 'resume'
    ? await resumeFactory(file, options)
    : await startFactory(
      subcommand === 'review' ? reviewGoal(readGoal(flagRequired(argv, 'goal')), flag(argv, 'source-run')) : readGoal(flagRequired(argv, 'goal')),
      file, options,
    );
  emit(argv, result, () => result.summary);
  if (result.state.status !== 'completed') process.exitCode = 1;
}

function reviewGoal(goal: StructuredFactoryGoal, sourceRunFile: string | undefined): StructuredFactoryGoal {
  return {
    ...goal,
    mode: 'review',
    implementation: [],
    review: { ...goal.review, ...(sourceRunFile ? { sourceRunFile: resolve(sourceRunFile) } : {}) },
  };
}

function readGoal(file: string): StructuredFactoryGoal {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read structured factory goal ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return value as StructuredFactoryGoal;
}

function readAssessment(file: string): NonNullable<FactoryControllerOptions['convergenceAssessment']> {
  try { return JSON.parse(readFileSync(file, 'utf8')) as NonNullable<FactoryControllerOptions['convergenceAssessment']>; }
  catch (error) { throw new Error(`cannot read convergence assessment ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

function readPolicy(file: string): NonNullable<FactoryControllerOptions['convergencePolicy']> {
  try { return JSON.parse(readFileSync(file, 'utf8')) as NonNullable<FactoryControllerOptions['convergencePolicy']>; }
  catch (error) { throw new Error(`cannot read convergence policy ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}
