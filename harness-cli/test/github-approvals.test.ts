import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createGitHubApprovals } from '../src/github-approvals.ts';
import { loadContracts } from '../src/contracts.ts';
import type { ExecutionPlan } from '../src/types.ts';

const head = 'a'.repeat(40);
const context = { repository: 'nicejoyce/enterprise-development-harness', pull_request: 42 };

function plan(): ExecutionPlan {
  return {
    version: 1,
    context: { repository: context.repository, pull_request: context.pull_request, base_sha: 'b'.repeat(40), head_sha: head },
    source_base_revision: 'b'.repeat(40),
    source_revision: head,
    operation: 'merge',
    target_environment: 'test',
    changed_files: ['src/example.ts'],
    risk_labels: [],
    route_ids: ['route.default'],
    approvals: ['engineering'],
    gates: [{ id: 'gate.peer-review', severity: 'REQUIRED', kind: 'manual-review', rule_ids: [], depends_on: [] }],
  };
}

test('creates commit-bound approvals from the latest approved review by an authorized identity', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  bundle.profile.approvals.roles.engineering = ['alice'];
  const records = createGitHubApprovals(bundle, plan(), [
    { id: 10, user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-03T01:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/10' },
    { id: 11, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-03T02:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/11' },
  ], context);
  assert.deepEqual(records.map(({ role, approver, gate_ids }) => ({ role, approver, gate_ids })), [{ role: 'engineering', approver: 'alice', gate_ids: ['gate.peer-review'] }]);
  assert.deepEqual(records[0], {
    id: 'APP-GH-11-engineering',
    gate_ids: ['gate.peer-review'],
    role: 'engineering',
    approver: 'alice',
    source: 'github-review',
    repository: context.repository,
    pull_request: context.pull_request,
    review_id: 11,
    commit_sha: head,
    approval_reference: 'https://github.com/nicejoyce/enterprise-development-harness/pull/42#pullrequestreview-11',
    approved_at: '2026-08-03T02:00:00.000Z',
    expires_at: '2026-08-10T02:00:00.000Z',
  });
});

test('rejects stale commit reviews and a later changes-requested state', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  bundle.profile.approvals.roles.engineering = ['alice'];
  const records = createGitHubApprovals(bundle, plan(), [
    { id: 20, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-03T01:00:00.000Z', commit_id: 'b'.repeat(40), html_url: 'https://github.example/review/20' },
    { id: 21, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-03T02:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/21' },
    { id: 22, user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-03T03:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/22' },
  ], context);
  assert.deepEqual(records, []);
});

test('keeps an approval after a later comment and matches GitHub logins case-insensitively', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  bundle.profile.approvals.roles.engineering = ['Alice'];
  const records = createGitHubApprovals(bundle, plan(), [
    { id: 30, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-03T01:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/30' },
    { id: 31, user: { login: 'alice' }, state: 'COMMENTED', submitted_at: '2026-08-03T02:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/31' },
  ], context);
  assert.equal(records.length, 1);
  assert.equal(records[0].expires_at, '2026-08-10T01:00:00.000Z');
});

test('revokes an approval after GitHub dismisses the review', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  bundle.profile.approvals.roles.engineering = ['alice'];
  const records = createGitHubApprovals(bundle, plan(), [
    { id: 40, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-03T01:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/40' },
    { id: 40, user: { login: 'alice' }, state: 'DISMISSED', submitted_at: '2026-08-03T02:00:00.000Z', commit_id: head, html_url: 'https://github.example/review/40' },
  ], context);
  assert.deepEqual(records, []);
});
