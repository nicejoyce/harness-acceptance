import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertGitPlanContext, changedFilesFromGit, gitRepositoryRoot, resolveGitRevision } from '../src/git.ts';

test('reads changed files between two Git revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-git-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Harness Test');
  await writeFile(path.join(root, 'first.txt'), 'first');
  git('add', '.'); git('commit', '-m', 'first');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  await writeFile(path.join(root, 'src.txt'), 'second');
  git('add', '.'); git('commit', '-m', 'second');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.deepEqual(await changedFilesFromGit(root, base, head), ['src.txt']);
  await mkdir(path.join(root, 'nested', 'policy'), { recursive: true });
  assert.equal(await gitRepositoryRoot(path.join(root, 'nested', 'policy')), path.resolve(root));
  assert.equal(await resolveGitRevision(root, 'HEAD'), head);
  await assertGitPlanContext(root, base, head, ['src.txt']);
});

test('rejects a plan when HEAD or its declared diff does not match the repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-git-context-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Harness Test');
  await writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '.'); git('commit', '-m', 'a');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  await writeFile(path.join(root, 'b.txt'), 'b');
  git('add', '.'); git('commit', '-m', 'b');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  await assert.rejects(() => assertGitPlanContext(root, base, 'a'.repeat(40), ['b.txt']));
  await assert.rejects(() => assertGitPlanContext(root, base, head, []));
  await writeFile(path.join(root, 'b.txt'), 'dirty');
  await assert.rejects(() => assertGitPlanContext(root, base, head, ['b.txt']));
});

test('rejects untracked and ignored files in the execution checkout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-git-clean-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Harness Test');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  await writeFile(path.join(root, 'b.txt'), 'b');
  git('add', '.'); git('commit', '-m', 'head');
  const head = git('rev-parse', 'HEAD').stdout.trim();

  await writeFile(path.join(root, 'untracked.txt'), 'untracked');
  await assert.rejects(() => assertGitPlanContext(root, base, head, ['b.txt']), /untracked|ignored|clean/i);
  await rm(path.join(root, 'untracked.txt'));
  await writeFile(path.join(root, 'ignored.txt'), 'ignored');
  await assert.rejects(() => assertGitPlanContext(root, base, head, ['b.txt']), /untracked|ignored|clean/i);
});

test('includes deleted paths and both sides of renames for fail-closed routing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-git-sensitive-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Harness Test');
  await mkdir(path.join(root, 'security'), { recursive: true });
  await writeFile(path.join(root, 'security', 'renamed.ts'), 'rename');
  await writeFile(path.join(root, 'security', 'deleted.ts'), 'delete');
  git('add', '.'); git('commit', '-m', 'sensitive files');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  await mkdir(path.join(root, 'public'), { recursive: true });
  await rename(path.join(root, 'security', 'renamed.ts'), path.join(root, 'public', 'renamed.ts'));
  await rm(path.join(root, 'security', 'deleted.ts'));
  git('add', '-A'); git('commit', '-m', 'move and delete');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.deepEqual(await changedFilesFromGit(root, base, head), ['public/renamed.ts', 'security/deleted.ts', 'security/renamed.ts']);
});
