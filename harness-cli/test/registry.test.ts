import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadContracts, validateContracts } from '../src/contracts.ts';

const root = path.resolve('harness');

test('canonical distribution has 83 unique rules with closed references', async () => {
  const validation = await validateContracts(root);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
  const bundle = await loadContracts(root);
  assert.equal(bundle.registry.rules.length, 83);
  assert.equal(new Set(bundle.registry.rules.map((rule) => rule.id)).size, 83);
  assert.ok(bundle.registry.rules.every((rule) => rule.gates.length > 0));
  const routedRules = new Set(bundle.routes.routes.flatMap((route) => route.rules));
  assert.deepEqual(bundle.registry.rules.map((rule) => rule.id).filter((id) => !routedRules.has(id)), []);
  for (const route of bundle.routes.routes) {
    const requiredGates = new Set(route.rules.flatMap((ruleId) => bundle.registry.rules.find((rule) => rule.id === ruleId)!.gates));
    assert.deepEqual([...requiredGates].filter((gateId) => !route.gates.includes(gateId)), [], route.id);
  }
});
