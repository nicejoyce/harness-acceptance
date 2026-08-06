import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { verifyChangedLineCoverage } from '../src/coverage.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-coverage-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'harness@example.test');
  git(root, 'config', 'user.name', 'Harness Test');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/example.ts'), 'export const one = 1;\nexport const two = 2;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

function istanbul(file: string, lines: Array<[number, number]>): Record<string, unknown> {
  return {
    [file]: {
      path: file,
      statementMap: Object.fromEntries(lines.map(([line], index) => [String(index), { start: { line, column: 0 }, end: { line, column: 20 } }])),
      s: Object.fromEntries(lines.map(([, hits], index) => [String(index), hits])),
      fnMap: {}, f: {}, branchMap: {}, b: {},
    },
  };
}

test('reports exact changed executable line coverage and uncovered locations', async () => {
  const { root, base } = await repository();
  await writeFile(path.join(root, 'src/example.ts'), 'export const one = 1;\nexport const two = 3;\nexport const three = 3;\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  const reportPath = path.join(root, 'coverage.json');
  await writeFile(reportPath, JSON.stringify(istanbul(path.join(root, 'src/example.ts'), [[1, 1], [2, 1], [3, 0]])));

  const result = await verifyChangedLineCoverage({ repository_root: root, base, head, report_path: reportPath, minimum: 80, critical_minimum: 90 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.summary, { numerator: 1, denominator: 2, percentage: 50, threshold: 80 });
  assert.deepEqual(result.uncovered, [{ path: 'src/example.ts', line: 3 }]);
});

test('excludes deleted lines and follows the destination of a rename', async () => {
  const { root, base } = await repository();
  git(root, 'mv', 'src/example.ts', 'src/renamed.ts');
  await writeFile(path.join(root, 'src/renamed.ts'), 'export const one = 1;\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'rename');
  const head = git(root, 'rev-parse', 'HEAD');
  const reportPath = path.join(root, 'coverage.json');
  await writeFile(reportPath, JSON.stringify(istanbul(path.join(root, 'src/renamed.ts'), [[1, 1]])));
  const result = await verifyChangedLineCoverage({ repository_root: root, base, head, report_path: reportPath, minimum: 80, critical_minimum: 90 });
  assert.equal(result.valid, true);
  assert.equal(result.summary.denominator, 1);
});

test('fails closed for an empty report or an unmapped changed source file', async () => {
  const { root, base } = await repository();
  await writeFile(path.join(root, 'src/example.ts'), 'export const one = 2;\nexport const two = 2;\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  const reportPath = path.join(root, 'coverage.json');
  await writeFile(reportPath, '{}');
  const result = await verifyChangedLineCoverage({ repository_root: root, base, head, report_path: reportPath, minimum: 80, critical_minimum: 90 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.unmapped_files, ['src/example.ts']);
});

test('uses the critical threshold for authorization source files', async () => {
  const { root, base } = await repository();
  const authorizationPath = path.join(root, 'src/authorization.ts');
  await writeFile(authorizationPath, [
    'export const one = 1;',
    'export const two = 2;',
    'export const three = 3;',
    'export const four = 4;',
    'export const five = 5;',
    '',
  ].join('\n'));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'authorization');
  const head = git(root, 'rev-parse', 'HEAD');
  const reportPath = path.join(root, 'coverage.json');
  await writeFile(reportPath, JSON.stringify(istanbul(authorizationPath, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0]])));

  const result = await verifyChangedLineCoverage({ repository_root: root, base, head, report_path: reportPath, minimum: 80, critical_minimum: 90 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.summary, { numerator: 4, denominator: 5, percentage: 80, threshold: 90 });
});

test('uses the critical threshold for deletion directories', async () => {
  const { root, base } = await repository();
  const deletionRoot = path.join(root, 'src/deletion');
  const deletionPath = path.join(deletionRoot, 'service.ts');
  await mkdir(deletionRoot);
  await writeFile(deletionPath, [
    'export const one = 1;',
    'export const two = 2;',
    'export const three = 3;',
    'export const four = 4;',
    'export const five = 5;',
    '',
  ].join('\n'));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'deletion');
  const head = git(root, 'rev-parse', 'HEAD');
  const reportPath = path.join(root, 'coverage.json');
  await writeFile(reportPath, JSON.stringify(istanbul(deletionPath, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0]])));

  const result = await verifyChangedLineCoverage({ repository_root: root, base, head, report_path: reportPath, minimum: 80, critical_minimum: 90 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.summary, { numerator: 4, denominator: 5, percentage: 80, threshold: 90 });
});
