import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeWorkflowPolicy, analyzeWorkflowPolicyRoots } from '../src/workflow-policy.ts';

const fixture = (name: string): string => path.resolve('harness-cli/test/fixtures/workflows', name);

test('rejects pull request expressions interpolated into trusted run blocks', async () => {
  const source = await readFile(fixture('inline-pr-expression.yml'), 'utf8');
  assert.ok(analyzeWorkflowPolicy(source).some((item) => item.code === 'UNTRUSTED_RUN_INTERPOLATION'));
});

test('rejects trusted jobs executing in the pull request checkout', async () => {
  const source = await readFile(fixture('trusted-project-run.yml'), 'utf8');
  assert.ok(analyzeWorkflowPolicy(source).some((item) => item.code === 'TRUSTED_JOB_EXECUTES_PR'));
});

test('rejects pull request data selecting executable behavior', async () => {
  const source = await readFile(fixture('pr-controlled-command.yml'), 'utf8');
  assert.ok(analyzeWorkflowPolicy(source).some((item) => item.code === 'PR_DATA_SELECTS_EXECUTION'));
});

test('accepts opaque pull request data passed through env', async () => {
  const source = await readFile(fixture('safe.yml'), 'utf8');
  assert.deepEqual(analyzeWorkflowPolicy(source), []);
});

test('classifies renamed and secret-bearing jobs as trusted', async () => {
  const source = await readFile(fixture('renamed-trusted-job.yml'), 'utf8');
  assert.ok(analyzeWorkflowPolicy(source).some((item) => item.code === 'TRUSTED_JOB_EXECUTES_PR'));
});

test('rejects local actions and scripts from the pull request checkout', async () => {
  const source = await readFile(fixture('local-project-execution.yml'), 'utf8');
  const diagnostics = analyzeWorkflowPolicy(source).filter((item) => item.code === 'TRUSTED_JOB_EXECUTES_PR');
  assert.equal(diagnostics.length, 4);
});

test('recursively rejects pull request data selecting execution behavior', async () => {
  const source = await readFile(fixture('nested-pr-selection.yml'), 'utf8');
  const paths = analyzeWorkflowPolicy(source)
    .filter((item) => item.code === 'PR_DATA_SELECTS_EXECUTION')
    .map((item) => item.path);
  assert.ok(paths.includes('/jobs/publish/if'));
  assert.ok(paths.includes('/jobs/publish/container/image'));
  assert.ok(paths.includes('/jobs/publish/steps/0/with/name'));
});

test('rejects head ref interpolation and tainted env entering command interpreters', async () => {
  const source = await readFile(fixture('tainted-env-execution.yml'), 'utf8');
  const codes = analyzeWorkflowPolicy(source).map((item) => item.code);
  assert.ok(codes.includes('UNTRUSTED_RUN_INTERPOLATION'));
  assert.equal(codes.filter((code) => code === 'PR_DATA_SELECTS_EXECUTION').length, 2);
});

test('scans every YAML workflow and rejects removal from the trusted baseline', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-policy-'));
  const baselineRoot = path.join(tempRoot, 'baseline');
  const workflowRoot = path.join(tempRoot, 'head');
  await mkdir(baselineRoot);
  await mkdir(workflowRoot);
  await writeFile(path.join(baselineRoot, 'harness.yml'), await readFile(fixture('safe.yml'), 'utf8'));
  await writeFile(path.join(workflowRoot, 'new-bypass.yaml'), await readFile(fixture('inline-pr-expression.yml'), 'utf8'));

  const diagnostics = await analyzeWorkflowPolicyRoots(workflowRoot, baselineRoot);

  assert.ok(diagnostics.some((item) => item.document === 'new-bypass.yaml' && item.code === 'UNTRUSTED_RUN_INTERPOLATION'));
  assert.ok(diagnostics.some((item) => item.document === 'harness.yml' && item.code === 'TRUSTED_WORKFLOW_REMOVED'));
});

test('accepts the repository trusted workflow set', async () => {
  assert.deepEqual(await analyzeWorkflowPolicyRoots('.github/workflows', '.github/workflows'), []);
});
