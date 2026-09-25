import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFactoryEntityId, isFactoryEvidenceRef } from './contracts.js';

describe('factory contracts', () => {
  it('accepts versioned IDs for each factory graph and rejects malformed IDs', () => {
    for (const kind of ['requirement', 'code', 'execution', 'defect']) {
      assert.equal(isFactoryEntityId(`${kind}:v1:stable.key`), true);
    }
    assert.equal(isFactoryEntityId('requirement:v2:stable.key'), false);
    assert.equal(isFactoryEntityId('code:v1:../outside'), false);
    assert.equal(isFactoryEntityId('unknown:v1:id'), false);
  });

  it('requires evidence identity to match its content hash', () => {
    const sha256 = 'a'.repeat(64);
    const ref = {
      id: `evidence:v1:${sha256}`,
      kind: 'task-attempt',
      uri: 'dag://run/run_123/task/t_123/attempt/1',
      sha256,
    };
    assert.equal(isFactoryEvidenceRef(ref), true);
    assert.equal(isFactoryEvidenceRef({ ...ref, sha256: 'b'.repeat(64) }), false);
    assert.equal(isFactoryEvidenceRef({ ...ref, uri: '' }), false);
  });
});
