import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { countFlag, emit, fileOf, flagRequired, has } from '../cli-args.js';
import { listFollowups, proposeFollowups, triageFollowup } from '../followups.js';
import type { FollowupProposal } from '../followups.js';

/** Backlog proposals and coordinator decisions never edit the executable graph. */
export async function followupsCmd(argv: string[]): Promise<void> {
  const action = argv[0] ?? 'list';
  const file = resolve(fileOf(argv));
  const optional = (name: string): string | undefined => has(argv, name) ? flagRequired(argv, name) : undefined;
  if (action === 'list') {
    const records = listFollowups(file);
    emit(argv, records, () => records.length ? JSON.stringify(records, null, 2) : 'No follow-up findings');
    return;
  }
  if (action === 'add') {
    const input: unknown = JSON.parse(readFileSync(resolve(flagRequired(argv, 'input')), 'utf8'));
    const proposals = (Array.isArray(input) ? input : [input]) as FollowupProposal[];
    if (has(argv, 'attempt')) flagRequired(argv, 'attempt');
    const records = proposeFollowups(file, proposals, {
      taskId: optional('task'), attempt: countFlag(argv, 'attempt', 0),
      stage: optional('stage') ?? 'manual', source: optional('source'),
    });
    emit(argv, records, () => JSON.stringify(records, null, 2));
    return;
  }
  if (action === 'triage') {
    const disposition = flagRequired(argv, 'disposition');
    if (!['blocker', 'existing-task', 'follow-up', 'dismissed'].includes(disposition)) {
      throw Error('--disposition must be blocker|existing-task|follow-up|dismissed');
    }
    const record = triageFollowup(file, flagRequired(argv, 'id'), {
      disposition: disposition as 'blocker' | 'existing-task' | 'follow-up' | 'dismissed',
      reason: flagRequired(argv, 'reason'), owner: optional('owner'),
      acceptance: optional('acceptance'), duplicateOf: optional('duplicate-of'),
    });
    emit(argv, record, () => JSON.stringify(record, null, 2));
    return;
  }
  throw Error('Expected followups list|add|triage');
}
