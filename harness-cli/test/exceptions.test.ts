import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadContracts } from '../src/contracts.ts';
import { validateExceptions } from '../src/exceptions.ts';
import type { ExceptionRecord } from '../src/types.ts';

function exception(overrides: Partial<ExceptionRecord> = {}): ExceptionRecord {
  return {
    id: 'EX-001',
    rule_ids: ['TEST-001'],
    gate_ids: ['gate.unit-test'],
    scope: { paths: ['src/**'] },
    reason: 'Temporary test infrastructure failure',
    risk: 'Regression detection is reduced',
    compensating_controls: ['manual peer verification'],
    approver: 'nicejoyce',
    approval_reference: 'APPROVAL-1',
    created_at: '2026-08-01T00:00:00.000Z',
    review_at: '2026-08-05T00:00:00.000Z',
    expires_at: '2026-08-10T00:00:00.000Z',
    removal_plan: 'Restore the unit test service',
    ...overrides,
  };
}

test('rejects expired and out-of-scope exceptions', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const expired = await validateExceptions(bundle, [exception({ expires_at: '2026-08-02T00:00:00.000Z' })], {
    changed_files: ['src/service.ts'], now: new Date('2026-08-03T00:00:00.000Z'),
  });
  assert.ok(expired.some((item) => item.code === 'EXCEPTION_EXPIRED'));

  const outOfScope = await validateExceptions(bundle, [exception()], {
    changed_files: ['docs/readme.md'], now: new Date('2026-08-03T00:00:00.000Z'),
  });
  assert.ok(outOfScope.some((item) => item.code === 'EXCEPTION_SCOPE_MISMATCH'));
});

test('rejects exceptions for blocker gates', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const diagnostics = await validateExceptions(bundle, [exception({
    rule_ids: ['SEC-001'], gate_ids: ['gate.security-scan'], scope: { paths: ['src/**'] }, approver: 'security',
  })], { changed_files: ['src/security/token.ts'], now: new Date('2026-08-03T00:00:00.000Z') });
  assert.ok(diagnostics.some((item) => item.code === 'BLOCKER_EXCEPTION_FORBIDDEN'));
});

test('rejects indirect exceptions for blocker rules', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const diagnostics = await validateExceptions(bundle, [exception({
    rule_ids: ['AI-002'], gate_ids: ['gate.peer-review'], scope: { paths: ['src/**'] }, approver: 'nicejoyce',
  })], { changed_files: ['src/agent.ts'], now: new Date('2026-08-03T00:00:00.000Z') });
  assert.ok(diagnostics.some((item) => item.code === 'BLOCKER_EXCEPTION_FORBIDDEN'));
});
