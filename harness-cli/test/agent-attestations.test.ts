import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentAttestations } from '../src/agent-attestations.ts';

test('retains Bot and App reviews as audit attestations without human approval semantics', () => {
  const records = createAgentAttestations([
    { id: 10, user: { login: 'automation[bot]', type: 'Bot' }, state: 'APPROVED', submitted_at: '2026-08-05T00:00:00.000Z', commit_id: 'a'.repeat(40), body: 'automated review' },
    { id: 11, user: { login: 'alice', type: 'User' }, state: 'APPROVED', submitted_at: '2026-08-05T00:01:00.000Z', commit_id: 'a'.repeat(40), body: 'human review' },
  ], { repository: 'nicejoyce/repo', pull_request: 42, commit_sha: 'a'.repeat(40) });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: 'AGT-GH-10',
    actor: 'automation[bot]',
    actor_type: 'Bot',
    source: 'github-review',
    repository: 'nicejoyce/repo',
    pull_request: 42,
    commit_sha: 'a'.repeat(40),
    review_id: 10,
    review_state: 'APPROVED',
    body_sha256: '50f191cd5fc38204b448aef31fe4355cd06753a9cd829931d5b71343757317d6',
    attested_at: '2026-08-05T00:00:00.000Z',
  });
});
