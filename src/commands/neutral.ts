import { readFileSync } from 'node:fs';
import { flagRequired } from '../cli-args.js';
import {
  runLightweightTasksV1,
  type LightweightNeutralRunOptionsV1,
  type LightweightNeutralTaskV1,
} from '../neutral-execution.js';

interface NeutralRunRequestV1 {
  tasks: LightweightNeutralTaskV1[];
  options: LightweightNeutralRunOptionsV1;
}

export async function neutralRunCmd(argv: string[]): Promise<void> {
  const requestFile = flagRequired(argv, 'file');
  let request: NeutralRunRequestV1;
  try {
    request = JSON.parse(readFileSync(requestFile, 'utf8')) as NeutralRunRequestV1;
  } catch (error) {
    throw new Error(`could not read neutral-run request ${requestFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!request || !Array.isArray(request.tasks) || !request.options || typeof request.options !== 'object') {
    throw new Error('neutral-run request must contain a tasks array and options object');
  }
  if (request.tasks.length === 0) throw new Error('neutral-run request must contain at least one task');
  if (
    typeof request.options.runId !== 'string' ||
    typeof request.options.runFile !== 'string' ||
    typeof request.options.outputDirectory !== 'string'
  ) {
    throw new Error('neutral-run options require runId, runFile and outputDirectory strings');
  }
  const summary = await runLightweightTasksV1(request.tasks, request.options);
  console.log(JSON.stringify(summary));
  const latestByTask = new Map(summary.executions.map((execution) => [execution.taskId, execution]));
  if (
    summary.stopped ||
    request.tasks.some((task) => {
      const latest = latestByTask.get(task.id);
      return !latest || latest.processStatus !== 'exited' || latest.failureKind !== null;
    })
  ) {
    process.exitCode = 1;
  }
}
