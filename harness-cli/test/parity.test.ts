import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadContracts, validateContracts } from '../src/contracts.ts';

test('English and Chinese distributions share machine contracts', async () => {
  const englishRoot = path.resolve('harness');
  const chineseRoot = path.resolve('harness-zh');
  const [englishValidation, chineseValidation] = await Promise.all([
    validateContracts(englishRoot),
    validateContracts(chineseRoot),
  ]);
  assert.equal(englishValidation.valid, true, JSON.stringify(englishValidation.diagnostics, null, 2));
  assert.equal(chineseValidation.valid, true, JSON.stringify(chineseValidation.diagnostics, null, 2));

  const [english, chinese] = await Promise.all([loadContracts(englishRoot), loadContracts(chineseRoot)]);
  assert.deepEqual(chinese.profile, english.profile);
  assert.deepEqual(chinese.gates, english.gates);
  assert.deepEqual(chinese.routes, english.routes);
  assert.deepEqual(chinese.registry, english.registry);
});
