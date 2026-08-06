import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { evaluateRegressionProof, loadTestQualityPolicy, runRegressionProof } from '../src/regression-proof.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test('requires base failure and head success for a changed test', () => {
  assert.deepEqual(evaluateRegressionProof({ base: { exit_code: 1, tests: 1 }, head: { exit_code: 0, tests: 1 }, changed_tests: ['test/example.test.ts'] }), { valid: true, reason: 'base-failed-head-passed' });
  assert.equal(evaluateRegressionProof({ base: { exit_code: 0, tests: 1 }, head: { exit_code: 0, tests: 1 }, changed_tests: ['test/example.test.ts'] }).valid, false);
  assert.equal(evaluateRegressionProof({ base: { exit_code: 1, tests: 0 }, head: { exit_code: 0, tests: 0 }, changed_tests: ['test/example.test.ts'] }).valid, false);
});

test('rejects empty changed test sets and environment-only claims', () => {
  assert.equal(evaluateRegressionProof({ base: { exit_code: 1, tests: 1 }, head: { exit_code: 0, tests: 1 }, changed_tests: [] }).valid, false);
  assert.equal(evaluateRegressionProof({ base: { exit_code: 1, tests: 1 }, head: { exit_code: 0, tests: 1 }, changed_tests: ['test/example.test.ts'], source_binding: 'environment' }).valid, false);
});

test('runs head tests against base and head implementations in isolated worktrees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-regression-repo-'));
  git(root, 'init'); git(root, 'config', 'user.email', 'harness@example.test'); git(root, 'config', 'user.name', 'Harness Test');
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 1);\n");
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base'); const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 2);\n");
  git(root, 'add', '.'); git(root, 'commit', '-m', 'head'); const head = git(root, 'rev-parse', 'HEAD');

  const result = await runRegressionProof({ repository_root: root, base, head, changed_tests: ['test/value.test.mjs'], command: { executable: process.execPath, args: ['test/value.test.mjs'] } });
  assert.deepEqual(result, { valid: true, reason: 'base-failed-head-passed' });
});

test('loads identical protected-base test quality policies', async () => {
  const english = await loadTestQualityPolicy(path.resolve('harness'));
  const chinese = await loadTestQualityPolicy(path.resolve('harness-zh'));
  assert.deepEqual(english, chinese);
  assert.equal(english.source_binding, 'protected-base');
  assert.equal(english.mutation.version, '9.6.1');
});
