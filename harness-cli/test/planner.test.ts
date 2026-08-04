import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { classifyChanges } from '../src/classifier.ts';
import { loadContracts } from '../src/contracts.ts';
import { createPlan, PlanningError } from '../src/planner.ts';
import type { ExceptionRecord, ExecutionContext } from '../src/types.ts';

test('orders dependencies before their dependent gates', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, {
    changed_files: ['frontend/ui/component.ts'],
    risk_labels: ['integration-required', 'e2e-required'],
    operation: 'merge',
    target_environment: 'test',
  });
  const plan = await createPlan(bundle, classification, []);
  assert.equal(plan.source_revision, null);
  const ids = plan.gates.map((gate) => gate.id);
  assert.ok(ids.indexOf('gate.unit-test') < ids.indexOf('gate.integration-test'));
  assert.ok(ids.indexOf('gate.integration-test') < ids.indexOf('gate.e2e-test'));
  assert.deepEqual(plan, await createPlan(bundle, classification, []));
});

test('propagates an immutable GitHub execution context into the plan', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, {
    changed_files: ['frontend/ui/component.ts'],
    risk_labels: ['integration-required', 'e2e-required'],
    operation: 'merge',
    target_environment: 'test',
  });
  const context: ExecutionContext = {
    repository: 'nicejoyce/enterprise-development-harness',
    pull_request: 42,
    base_sha: 'b'.repeat(40),
    head_sha: 'a'.repeat(40),
  };
  const plan = await createPlan(bundle, classification, [], new Date(), context.head_sha, context.base_sha, context);
  assert.deepEqual(plan.context, context);
});

test('fails closed when a conditional gate lacks an applicability decision', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, {
    changed_files: ['frontend/ui/component.ts'],
    operation: 'merge',
    target_environment: 'test',
  });
  await assert.rejects(() => createPlan(bundle, classification, []), PlanningError);
});

test('does not let a partial exception waive other rules sharing the gate', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, { changed_files: ['src/service.ts'], operation: 'merge', target_environment: 'test' });
  const record: ExceptionRecord = {
    id: 'EX-001', rule_ids: ['TEST-001'], gate_ids: ['gate.peer-review'], scope: { paths: ['src/**'] },
    reason: 'Temporary review exception', risk: 'Reduced review', compensating_controls: ['secondary verification'],
    approver: bundle.profile.approvals.roles.engineering[0], approval_reference: 'APP-1', created_at: '2026-08-01T00:00:00.000Z',
    review_at: '2026-08-04T00:00:00.000Z', expires_at: '2026-08-10T00:00:00.000Z', removal_plan: 'Restore peer review',
  };
  const plan = await createPlan(bundle, classification, [record], new Date('2026-08-03T00:00:00.000Z'));
  assert.equal(plan.gates.find((gate) => gate.id === 'gate.peer-review')?.exception_id, undefined);
});

test('does not except a dependency gate with no directly routed rules', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, {
    changed_files: ['frontend/ui/component.ts'],
    risk_labels: ['integration-required', 'e2e-required'],
    operation: 'merge',
    target_environment: 'test',
  });
  const record: ExceptionRecord = {
    id: 'EX-DEPENDENCY', rule_ids: ['UI-002'], gate_ids: ['gate.integration-test'], scope: { paths: ['frontend/**'] },
    reason: 'Temporary integration infrastructure issue', risk: 'Reduced integration coverage', compensating_controls: ['manual verification'],
    approver: bundle.profile.approvals.roles.engineering[0], approval_reference: 'APP-2', created_at: '2026-08-01T00:00:00.000Z',
    review_at: '2026-08-04T00:00:00.000Z', expires_at: '2026-08-10T00:00:00.000Z', removal_plan: 'Restore integration tests',
  };
  const plan = await createPlan(bundle, classification, [record], new Date('2026-08-03T00:00:00.000Z'));
  assert.equal(plan.gates.find((gate) => gate.id === 'gate.integration-test')?.exception_id, undefined);
});
