import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = path.resolve('harness-cli/src/cli.ts');
test('completes validate, plan, run, and evidence verify', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'harness-workflow-'));
  const root = path.join(output, 'project');
  await cp(path.resolve('fixtures/neutral-project'), root, { recursive: true });
  const planPath = path.join(output, 'plan.json');
  const commands = [
    ['validate', '--root', root],
    ['plan', '--root', root, '--changed-file', 'src/example.txt', '--operation', 'merge', '--environment', 'test', '--output', planPath],
    ['run', '--root', root, '--plan', planPath, '--output', output],
    ['evidence', 'verify', '--root', root, '--manifest', path.join(output, 'manifest.json')],
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
});

test('rejects run and evidence verification after repository HEAD advances', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'harness-git-workflow-'));
  const root = path.join(output, 'project');
  await cp(path.resolve('fixtures/neutral-project'), root, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init');
  git('config', 'user.name', 'Harness Test');
  git('config', 'user.email', 'harness@example.invalid');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/example.txt'), 'head-a\n');
  git('add', 'src/example.txt');
  git('commit', '-m', 'head a');
  const headA = git('rev-parse', 'HEAD');
  const planPath = path.join(output, 'plan.json');
  const evidence = path.join(output, 'evidence');
  const contextArgs = ['--repository', 'nicejoyce/enterprise-development-harness', '--pull-request', '42', '--base-sha', base, '--head-sha', headA];
  const plan = spawnSync(process.execPath, [cli, 'plan', '--root', root, '--project-root', root, ...contextArgs, '--git-base', base, '--git-head', headA, '--output', planPath], { encoding: 'utf8' });
  assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`);
  const planned = JSON.parse(await readFile(planPath, 'utf8'));
  assert.deepEqual(planned.context, { repository: 'nicejoyce/enterprise-development-harness', pull_request: 42, base_sha: base, head_sha: headA });
  const runAtA = spawnSync(process.execPath, [cli, 'run', '--root', root, '--project-root', root, ...contextArgs, '--plan', planPath, '--output', evidence], { encoding: 'utf8' });
  assert.equal(runAtA.status, 0, `${runAtA.stdout}\n${runAtA.stderr}`);
  await writeFile(path.join(root, 'src/example.txt'), 'head-b\n');
  git('add', 'src/example.txt');
  git('commit', '-m', 'head b');
  const staleRun = spawnSync(process.execPath, [cli, 'run', '--root', root, '--project-root', root, ...contextArgs, '--plan', planPath, '--output', path.join(output, 'stale')], { encoding: 'utf8' });
  assert.equal(staleRun.status, 3, `${staleRun.stdout}\n${staleRun.stderr}`);
  const staleEvidence = spawnSync(process.execPath, [cli, 'evidence', 'verify', '--root', root, '--project-root', root, ...contextArgs, '--manifest', path.join(evidence, 'manifest.json')], { encoding: 'utf8' });
  assert.equal(staleEvidence.status, 5, `${staleEvidence.stdout}\n${staleEvidence.stderr}`);
});
