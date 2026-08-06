import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateMutationSmoke, evaluateStrykerReport } from '../src/mutation.ts';

test('requires killed mutants and reports structured mutation evidence', () => {
  const result = evaluateMutationSmoke({ total: 3, killed: 3, timeout: 0, equivalent: 0, changed_modules: ['src/logic.ts'] });
  assert.deepEqual(result, { valid: true, score: 100, total: 3, killed: 3, timeout: 0, equivalent: 0 });
  assert.equal(evaluateMutationSmoke({ total: 0, killed: 0, timeout: 0, equivalent: 0, changed_modules: ['src/logic.ts'] }).valid, false);
  assert.equal(evaluateMutationSmoke({ total: 3, killed: 2, timeout: 0, equivalent: 0, changed_modules: ['src/logic.ts'] }).valid, false);
  assert.equal(evaluateMutationSmoke({ total: 3, killed: 3, timeout: 0, equivalent: 0, changed_modules: [] }).valid, false);
  assert.equal(evaluateMutationSmoke({ total: 3, killed: 3, timeout: 1, equivalent: 0, changed_modules: ['src/logic.ts'] }).valid, false);
});

test('normalizes Stryker mutant statuses for changed modules', () => {
  const result = evaluateStrykerReport({ files: { 'src/logic.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }, { status: 'Timeout' }, { status: 'Ignored' }] } } }, ['src/logic.ts'], 80);
  assert.deepEqual(result, { valid: false, score: 25, total: 4, killed: 1, timeout: 1, equivalent: 1 });
});

test('fails closed for empty, unselected, missing, and threshold-edge Stryker results', () => {
  assert.deepEqual(evaluateStrykerReport({}, ['src/logic.ts'], 80), { valid: false, score: 0, total: 0, killed: 0, timeout: 0, equivalent: 0 });
  assert.equal(evaluateStrykerReport({ files: { 'src/other.ts': { mutants: [{ status: 'Killed' }] } } }, ['src/logic.ts'], 80).valid, false);
  assert.equal(evaluateStrykerReport({ files: { 'src/logic.ts': {} } }, ['src/logic.ts'], 80).valid, false);
  assert.equal(evaluateStrykerReport({ files: { 'src/logic.ts': { mutants: [{}, { status: 'Killed' }] } } }, ['src/logic.ts'], 50).valid, true);
  assert.equal(evaluateStrykerReport({ files: { 'src/logic.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] } } }, ['src/logic.ts'], 51).valid, false);
  assert.equal(evaluateStrykerReport({ files: { 'src/logic.ts': { mutants: [{ status: 'Timeout' }] } } }, ['src/logic.ts'], 0).valid, false);
  assert.equal(evaluateStrykerReport({ files: { 'src/logic.ts': { mutants: [{ status: 'Killed' }] } } }, ['src\\logic.ts'], 80).valid, true);
});
