import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planBuild } from './build-planner.js';

test('resumes a saved planning receipt without a new agent call', () => {
  const root = mkdtempSync(join(tmpdir(), 'dag-planner-test-'));
  const receipt = join(root, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({
    spec: 'Example', limit: 1000, reserved: 80, attempts: 1,
    plan: {
      version: 3, title: 'Example',
      settings: { waveChecks: ['check'], finalChecks: ['acceptance'] },
      nodes: [{ id: 'qa', goal: 'Inspect the result', experience: 'qa', depends_on: [],
        touches: [], creates: [], relies_on: [], verify: 'check' }],
    },
  }));
  const run = planBuild(receipt, root, 'Example', 1000, []);
  assert.equal(run.flowState?.reservedCents, 80);
  assert.equal(run.tasks.qa.node?.experience, 'qa');
});
