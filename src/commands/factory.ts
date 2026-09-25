// Closed-loop software factory commands. Every runnable phase is submitted to
// the existing DagRunner by the controller; this file only handles CLI I/O.
import { readFileSync } from 'node:fs';
import { emit, flag, flagRequired, guard, wantsJson } from '../cli-args.js';
import { factoryStatus, resumeFactory, startFactory, type StructuredFactoryGoal } from '../factory/controller.js';
import type { DagEvent } from '../types.js';

export async function factoryCmd(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? 'status';
  const file = flag(argv, 'file') ?? 'dag.run.json';
  if (subcommand === 'status') {
    const result = factoryStatus(file);
    emit(argv, result, () => `${result.summary}\n  run: ${result.runId}\n  checkpoint: ${result.state.stage}`);
    return;
  }

  if (subcommand !== 'start' && subcommand !== 'resume') {
    throw new Error('usage: dag factory start --goal goal.json [--file dag.run.json] | factory resume|status [--file dag.run.json]');
  }
  guard(file, argv);
  const onEvent = (event: DagEvent): void => {
    const task = event.taskId ? `${event.taskId} ` : '';
    const line = `[${event.ts.slice(11, 19)}] ${event.type.padEnd(16)} ${task}${event.message}`;
    if (wantsJson(argv)) console.error(line);
    else console.log(line);
  };
  const result = subcommand === 'start'
    ? await startFactory(readGoal(flagRequired(argv, 'goal')), file, { onEvent })
    : await resumeFactory(file, { onEvent });
  emit(argv, result, () => result.summary);
  if (result.state.status !== 'completed') process.exitCode = 1;
}

function readGoal(file: string): StructuredFactoryGoal {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read structured factory goal ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return value as StructuredFactoryGoal;
}
