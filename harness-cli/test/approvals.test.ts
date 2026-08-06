import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadContracts } from '../src/contracts.ts';
import { validateApprovals } from '../src/approvals.ts';
import type { ApprovalRecord } from '../src/types.ts';

const revision = 'a'.repeat(40);
const context = { now: new Date('2026-08-03T00:00:00.000Z'), source_revision: revision, repository: 'nicejoyce/enterprise-development-harness', pull_request: 42 };

function approval(approver: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'APP-GH-101-engineering',
    gate_ids: ['gate.peer-review'],
    role: 'engineering',
    approver,
    source: 'github-review' as const,
    repository: context.repository,
    pull_request: context.pull_request,
    review_id: 101,
    commit_sha: revision,
    approval_reference: 'https://github.com/nicejoyce/enterprise-development-harness/pull/42#pullrequestreview-101',
    approved_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

test('accepts an identity authorized for the claimed role and rejects expired approvals', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const active = approval(bundle.profile.approvals.roles.engineering[0]);
  assert.deepEqual(await validateApprovals(bundle, [active], context), []);
  const expired = await validateApprovals(bundle, [{ ...active, expires_at: '2026-08-02T00:00:00.000Z' }], context);
  assert.ok(expired.some((item) => item.code === 'APPROVAL_INVALID'));
});

test('rejects an approver who is authorized for a different role', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const diagnostics = await validateApprovals(bundle, [approval(bundle.profile.approvals.roles.engineering[0], { approver: 'security' })], context);
  assert.ok(diagnostics.some((item) => item.code === 'APPROVAL_INVALID'));
});

test('rejects malformed timestamps and an expiry that precedes approval', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const base = approval(bundle.profile.approvals.roles.engineering[0], { approved_at: 'not-a-date', expires_at: 'also-not-a-date' });
  const malformed = await validateApprovals(bundle, [base], context);
  assert.ok(malformed.some((item) => item.code === 'APPROVAL_INVALID'));
  const reversed = await validateApprovals(bundle, [{ ...base, approved_at: '2026-08-05T00:00:00.000Z', expires_at: '2026-08-04T00:00:00.000Z' }], context);
  assert.ok(reversed.some((item) => item.message.includes('expires')));
});

test('rejects approval provenance that does not match the execution context', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const diagnostics = await validateApprovals(bundle, [approval(bundle.profile.approvals.roles.engineering[0], { commit_sha: 'b'.repeat(40), repository: 'attacker/repo', pull_request: 7 })], context);
  assert.ok(diagnostics.some((item) => item.path === '/commit_sha'));
  assert.ok(diagnostics.some((item) => item.path === '/repository'));
  assert.ok(diagnostics.some((item) => item.path === '/pull_request'));
});

test('matches authorized GitHub identities case-insensitively', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  bundle.profile.approvals.roles.engineering = ['Engineering'];
  assert.deepEqual(await validateApprovals(bundle, [approval('engineering')], context), []);
});
