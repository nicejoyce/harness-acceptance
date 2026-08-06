import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdentitySnapshot, identityForApproval } from '../src/github-identities.ts';

const context = {
  repository: 'nicejoyce/enterprise-development-harness',
  pull_request: 42,
  commit_sha: 'a'.repeat(40),
};

test('accepts only an active non-author GitHub User identity', () => {
  const snapshot = createIdentitySnapshot({
    ...context,
    author: 'author',
    captured_at: '2026-08-05T00:00:00.000Z',
    subjects: [{
      login: 'alice',
      user_type: 'User',
      affiliation_state: 'active',
      api_source: 'github-repository-collaborator-permission',
      queried_at: '2026-08-05T00:00:00.000Z',
    }],
  });
  assert.equal(identityForApproval(snapshot, 'alice', context)?.login, 'alice');
  assert.equal(identityForApproval(snapshot, 'author', context), undefined);
});

test('fails closed for bots, inactive identities, stale context, and missing identities', () => {
  const snapshot = createIdentitySnapshot({
    ...context,
    author: 'author',
    captured_at: '2026-08-05T00:00:00.000Z',
    subjects: [
      { login: 'build-bot', user_type: 'Bot', affiliation_state: 'active', api_source: 'github-organization-membership', queried_at: '2026-08-05T00:00:00.000Z' },
      { login: 'former-member', user_type: 'User', affiliation_state: 'inactive', api_source: 'github-organization-membership', queried_at: '2026-08-05T00:00:00.000Z' },
    ],
  });
  assert.equal(identityForApproval(snapshot, 'build-bot', context), undefined);
  assert.equal(identityForApproval(snapshot, 'former-member', context), undefined);
  assert.equal(identityForApproval(snapshot, 'unknown', context), undefined);
  assert.equal(identityForApproval(snapshot, 'build-bot', { ...context, commit_sha: 'b'.repeat(40) }), undefined);
});

