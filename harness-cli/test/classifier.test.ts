import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { classifyChanges } from '../src/classifier.ts';
import { loadContracts } from '../src/contracts.ts';

test('classifies one change into every matching route deterministically', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, {
    changed_files: ['src/api/auth/security/token.ts', 'README.md'],
    operation: 'merge',
    target_environment: 'test',
  });
  assert.ok(classification.route_ids.includes('route.api'));
  assert.ok(classification.route_ids.includes('route.security'));
  assert.deepEqual(classification.changed_files, ['README.md', 'src/api/auth/security/token.ts']);
  assert.ok(classification.gate_ids.includes('gate.security-scan'));
  assert.ok(classification.approvals.includes('api'));
  assert.ok(classification.approvals.includes('security'));
  assert.equal(classification.risk_tier, 'critical');
});

test('uses case-sensitive routing on every operating system', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, { changed_files: ['SRC/API/value.ts'], operation: 'merge', target_environment: 'test' });
  assert.ok(classification.route_ids.includes('route.unknown'));
  assert.ok(!classification.route_ids.includes('route.low-risk'));
  assert.deepEqual(classification.approvals, ['engineering']);
});

test('allows only explicit low-risk paths to avoid human approval', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, { changed_files: ['src/feature.ts', 'test/feature.test.ts'], operation: 'merge', target_environment: 'test' });
  assert.ok(classification.route_ids.includes('route.low-risk'));
  assert.equal(classification.risk_tier, 'low');
  assert.deepEqual(classification.approvals, []);
});

test('mixed changes preserve the highest risk and every sensitive approval', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, { changed_files: ['src/feature.ts', 'src/auth/token.ts'], operation: 'merge', target_environment: 'test' });
  assert.equal(classification.risk_tier, 'critical');
  assert.ok(classification.approvals.includes('security'));
  assert.ok(classification.gate_ids.includes('gate.incremental-mutation'));
});

test('fails closed for unknown extensions and traversal-like paths', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const unknown = classifyChanges(bundle, { changed_files: ['src/payload.unknownext'], operation: 'merge', target_environment: 'test' });
  assert.ok(unknown.route_ids.includes('route.unknown'));
  assert.ok(!unknown.route_ids.includes('route.low-risk'));
  assert.deepEqual(unknown.approvals, ['engineering']);
  assert.throws(() => classifyChanges(bundle, { changed_files: ['src/../auth/token.ts'], operation: 'merge', target_environment: 'test' }), /unsafe path/i);
});

test('routes every control-plane path through the self-protection gate', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  for (const changedFile of [
    '.github/workflows/harness.yml',
    'CODEOWNERS',
    'CODEOWNERS.template',
    'harness/contracts/routes.yaml',
    'harness-zh/rules/registry.yaml',
    'harness-cli/schemas/registry.schema.json',
    'package.json',
    'package-lock.json',
    'harness-service/src/server.ts',
    'stryker.full.config.json',
    'scripts/Prepare-PublicAcceptance.ps1',
  ]) {
    const classification = classifyChanges(bundle, { changed_files: [changedFile], operation: 'merge', target_environment: 'test' });
    assert.ok(classification.route_ids.includes('route.harness-self'), changedFile);
    assert.ok(classification.rule_ids.includes('SEC-009'), changedFile);
    assert.ok(classification.gate_ids.includes('gate.control-plane-integrity'), changedFile);
  }
});
