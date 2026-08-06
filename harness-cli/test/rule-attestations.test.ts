import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadContracts } from '../src/contracts.ts';
import { createPlan } from '../src/planner.ts';
import { createGitHubRuleAttestations, validateRuleAttestations } from '../src/rule-attestations.ts';
import { createIdentitySnapshot } from '../src/github-identities.ts';
import type { Classification, ExecutionContext, RuleAttestationRecord } from '../src/types.ts';

const context: ExecutionContext = {
  repository: 'nicejoyce/enterprise-development-harness',
  pull_request: 42,
  base_sha: 'b'.repeat(40),
  head_sha: 'a'.repeat(40),
};

async function fixture() {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification: Classification = {
    changed_files: ['README.md'],
    route_ids: ['route.default'],
    rule_ids: ['DOC-001'],
    gate_ids: [],
    approvals: [],
    risk_labels: [],
    operation: 'merge',
    target_environment: 'test',
    risk_tier: 'medium',
  };
  const plan = await createPlan(bundle, classification, [], new Date('2026-08-05T00:00:00.000Z'), context.head_sha, context.base_sha, context);
  const reviewer = bundle.profile.approvals.roles.engineering[0];
  const valid: RuleAttestationRecord = {
    id: 'RAT-GH-123-attestation.doc-001',
    policy_id: 'attestation.doc-001',
    rule_ids: ['DOC-001'],
    role: 'engineering',
    approver: reviewer,
    source: 'github-review',
    repository: context.repository,
    pull_request: context.pull_request,
    commit_sha: context.head_sha,
    checklist_version: '1',
    claims: ['requirements-reviewed', 'evidence-reviewed', 'residual-risk-accepted'],
    review_id: 123,
    attested_at: '2026-08-05T00:00:00.000Z',
  };
  const identities = createIdentitySnapshot({ repository: context.repository, pull_request: context.pull_request, commit_sha: context.head_sha, author: 'author', captured_at: '2026-08-05T00:00:00.000Z', subjects: [{ login: reviewer, user_type: 'User', affiliation_state: 'active', api_source: 'github-repository-collaborator-permission', queried_at: '2026-08-05T00:00:00.000Z' }] });
  return { bundle, plan, valid, identities };
}

test('requires a structured attestation instead of a generic approval', async () => {
  const { bundle, plan, identities } = await fixture();
  assert.deepEqual(plan.rule_attestations.map((item) => item.policy_id), ['attestation.doc-001']);
  const diagnostics = await validateRuleAttestations(bundle, plan, []);
  assert.ok(diagnostics.some((item) => item.code === 'RULE_ATTESTATION_MISSING'));
});

test('accepts an exact commit-bound structured rule attestation', async () => {
  const { bundle, plan, valid } = await fixture();
  assert.deepEqual(await validateRuleAttestations(bundle, plan, [valid]), []);
});

test('rejects stale commits, wrong roles, old checklists, and empty claims', async () => {
  const { bundle, plan, valid } = await fixture();
  for (const mutate of [
    (record: RuleAttestationRecord) => { record.commit_sha = 'c'.repeat(40); },
    (record: RuleAttestationRecord) => { record.role = 'security'; },
    (record: RuleAttestationRecord) => { record.checklist_version = '0'; },
    (record: RuleAttestationRecord) => { record.claims = []; },
  ]) {
    const record = structuredClone(valid);
    mutate(record);
    const diagnostics = await validateRuleAttestations(bundle, plan, [record]);
    assert.ok(diagnostics.some((item) => item.code === 'RULE_ATTESTATION_INVALID'));
  }
});

test('does not turn a generic APPROVED review into a rule attestation', async () => {
  const { bundle, plan, valid, identities } = await fixture();
  const records = createGitHubRuleAttestations(bundle, plan, [{
    id: 123,
    user: { login: valid.approver },
    state: 'APPROVED',
    submitted_at: '2026-08-05T00:00:00.000Z',
    commit_id: context.head_sha,
    body: 'Looks good',
  }], { repository: context.repository, pull_request: context.pull_request }, identities);
  assert.deepEqual(records, []);
});

test('creates a structured attestation from strict review JSON', async () => {
  const { bundle, plan, valid, identities } = await fixture();
  const records = createGitHubRuleAttestations(bundle, plan, [{
    id: 123,
    user: { login: valid.approver },
    state: 'APPROVED',
    submitted_at: valid.attested_at,
    commit_id: context.head_sha,
    body: JSON.stringify({ harness_rule_attestations: [{ policy_id: valid.policy_id, checklist_version: valid.checklist_version, claims: valid.claims }] }),
  }], { repository: context.repository, pull_request: context.pull_request }, identities);
  assert.deepEqual(records, [valid]);
});

test('does not let a Bot review satisfy a human rule attestation', async () => {
  const { bundle, plan, valid } = await fixture();
  const botIdentities = createIdentitySnapshot({ repository: context.repository, pull_request: context.pull_request, commit_sha: context.head_sha, author: 'author', captured_at: valid.attested_at, subjects: [{ login: valid.approver, user_type: 'Bot', affiliation_state: 'active', api_source: 'github-organization-membership', queried_at: valid.attested_at }] });
  const records = createGitHubRuleAttestations(bundle, plan, [{
    id: 123,
    user: { login: valid.approver, type: 'Bot' },
    state: 'APPROVED',
    submitted_at: valid.attested_at,
    commit_id: context.head_sha,
    body: JSON.stringify({ harness_rule_attestations: [{ policy_id: valid.policy_id, checklist_version: valid.checklist_version, claims: valid.claims }] }),
  }], { repository: context.repository, pull_request: context.pull_request }, botIdentities);
  assert.deepEqual(records, []);
});
