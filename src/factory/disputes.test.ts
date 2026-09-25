import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adjudicationInput, createDispute, DISPUTE_LIMITS, validateDispute } from './disputes.js';

describe('factory reviewer disputes', () => {
  it('bounds opposing reviewer claims and retains evidence for both sides', () => {
    const dispute = createDispute({
      claim: 'timeout retries can produce duplicate writes',
      positions: [
        {
          reviewer: 'Reviewer A', stance: 'for', claim: 'Retry path can write twice.',
          evidence: ['The timeout retry invokes the write operation again.'],
        },
        {
          reviewer: 'Reviewer B', stance: 'against', claim: 'requestIdGuard prevents the second write.',
          evidence: ['The request ID is checked before persistence.'],
        },
      ],
      openQuestion: 'Does requestIdGuard execute on the timeout retry path?',
    });

    validateDispute(dispute);
    assert.deepEqual(dispute, {
      schema_version: 1,
      claim: 'timeout retries can produce duplicate writes',
      evidence_for: [{
        reviewer: 'Reviewer A', claim: 'Retry path can write twice.',
        evidence: ['The timeout retry invokes the write operation again.'],
      }],
      evidence_against: [{
        reviewer: 'Reviewer B', claim: 'requestIdGuard prevents the second write.',
        evidence: ['The request ID is checked before persistence.'],
      }],
      open_question: 'Does requestIdGuard execute on the timeout retry path?',
    });
  });

  it('sends only the unresolved question to adjudication', () => {
    const dispute = createDispute({
      claim: 'timeout retries can produce duplicate writes',
      positions: [
        { reviewer: 'A', stance: 'for', claim: 'The retry repeats the write.', evidence: ['retry -> write'] },
        { reviewer: 'B', stance: 'against', claim: 'A guard makes the operation idempotent.', evidence: ['guard before write'] },
      ],
      openQuestion: 'Does requestIdGuard execute on the timeout retry path?',
    });

    const adjudication = adjudicationInput(dispute);
    assert.equal(adjudication, dispute.open_question);
    assert.equal(adjudication.length, dispute.open_question.length);
    assert.ok(adjudication.length < JSON.stringify(dispute).length / 4);
  });

  it('rejects one-sided disputes and oversized propositions or evidence packets', () => {
    const base = {
      claim: 'a bounded claim',
      positions: [
        { reviewer: 'A', stance: 'for' as const, claim: 'The action repeats.' },
        { reviewer: 'B', stance: 'against' as const, claim: 'A guard prevents repetition.' },
      ],
      openQuestion: 'Does the guard run on retry?',
    };
    assert.throws(() => createDispute({ ...base, positions: [base.positions[0]] }), /requires evidence against/);
    assert.throws(() => createDispute({ ...base, claim: 'x'.repeat(DISPUTE_LIMITS.claimCharacters + 1) }), /dispute claim exceeds/);
    assert.throws(() => createDispute({
      ...base,
      positions: [{ ...base.positions[0], evidence: Array(DISPUTE_LIMITS.evidenceItemsPerPosition + 1).fill('evidence') }, base.positions[1]],
    }), /at most/);
    assert.throws(() => validateDispute({ ...createDispute(base), schema_version: 2 }), /invalid dispute/);
  });
});
