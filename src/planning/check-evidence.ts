import type { PlanningCheck } from './contracts.js';

export interface SelectedTestEvidence { checkId: string; selectedTests: number; allowEmpty: boolean }
/** A missing, ambiguous or malformed summary is never evidence that tests ran. */
export function selectedTestEvidence(check: PlanningCheck, output: string): SelectedTestEvidence | undefined {
  if (check.kind !== 'test') return undefined;
  if (!check.selectedTests) throw Error('Missing selectedTests contract');
  const matches = [...output.replace(/\u001b\[[0-9;]*m/g, '').matchAll(new RegExp(check.selectedTests.pattern, 'gm'))];
  if (matches.length !== 1 || !/^\d+$/.test(matches[0]![1] ?? '')) throw Error(`Check ${check.id} needs exactly one selected test count summary`);
  const count = Number(matches[0]![1]);
  if (!Number.isSafeInteger(count) || count === 0 && !check.selectedTests.allowEmpty) throw Error(`Check ${check.id} selected no tests or reported an invalid count`);
  return { checkId: check.id, selectedTests: count, allowEmpty: check.selectedTests.allowEmpty === true };
}
