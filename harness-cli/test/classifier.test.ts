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
  assert.deepEqual(classification.route_ids, ['route.api', 'route.default', 'route.security']);
  assert.deepEqual(classification.changed_files, ['README.md', 'src/api/auth/security/token.ts']);
  assert.ok(classification.gate_ids.includes('gate.security-scan'));
  assert.deepEqual(classification.approvals, ['api', 'engineering', 'security']);
});

test('uses case-sensitive routing on every operating system', async () => {
  const bundle = await loadContracts(path.resolve('harness'));
  const classification = classifyChanges(bundle, { changed_files: ['SRC/API/value.ts'], operation: 'merge', target_environment: 'test' });
  assert.deepEqual(classification.route_ids, ['route.default']);
});
