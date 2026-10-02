import {
  readLegacyExecutionsV1,
  recoverLegacyRunV1,
  runLegacyTasksV1,
  scheduleLegacyTasksV1,
  stopLegacyRunV1,
} from '@dag-orchestrator/neutral-execution';

/**
 * Narrow product entry point for consumers opting into neutral v1 execution.
 * The pinned local package owns scheduling, process launch, logging and recovery.
 * Existing `dag run` modes continue to use the established DAG runner.
 */
export const runLightweightTasksV1 = runLegacyTasksV1;
export const scheduleLightweightTasksV1 = scheduleLegacyTasksV1;
export const stopLightweightRunV1 = stopLegacyRunV1;
export const readLightweightExecutionsV1 = readLegacyExecutionsV1;
export const recoverLightweightRunV1 = recoverLegacyRunV1;

export type {
  LegacyNeutralRunOptionsV1 as LightweightNeutralRunOptionsV1,
  LegacyNeutralTaskV1 as LightweightNeutralTaskV1,
  NeutralExecutionV1,
  NeutralRunSummaryV1,
} from '@dag-orchestrator/neutral-execution';
