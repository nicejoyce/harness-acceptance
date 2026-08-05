import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPlan } from '../src/runner.ts';
import { exitCodeForManifest } from '../src/exit-codes.ts';
import { classifyChanges } from '../src/classifier.ts';
import { createPlan } from '../src/planner.ts';
import type { ApprovalRecord, ContractBundle, ExecutionContext, ExecutionPlan, GateDefinition } from '../src/types.ts';

const approvalContext = { repository: 'nicejoyce/enterprise-development-harness', pull_request: 42 };

async function runnerFixture(gates: GateDefinition[], commands: ContractBundle['profile']['commands'], approvals: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-runner-'));
  const harnessRoot = path.join(root, 'harness');
  await mkdir(harnessRoot);
  const ruleIds = gates.map((_, index) => `TEST-${String(index + 1).padStart(3, '0')}`);
  const bundle = {
    root: harnessRoot,
    profile: { version: 1, project: { name: 'runner', owner: 'engineering', data_classification: 'internal' }, commands, approvals: { roles: { engineering: ['engineering'] } as Record<string, string[]> } },
    gates: { version: 1, gates },
    routes: { version: 1, routes: [{ id: 'route.test', include: ['**/*'], rules: ruleIds, gates: gates.map((gate) => gate.id), approvals }] },
    registry: { version: 3, modules: { quality: { prefix: 'TEST', owner: 'quality' } }, rules: gates.map((gate, index) => ({ id: ruleIds[index], module: 'quality', severity: gate.severity, gates: [gate.id], exception_allowed: gate.exception_allowed })) },
  } satisfies ContractBundle;
  const classification = classifyChanges(bundle, { changed_files: ['src/test.txt'], operation: 'merge', target_environment: 'test' });
  const plan = await createPlan(bundle, classification, []);
  return { root, bundle, plan };
}

function commandGate(id: string, command: string, depends_on: string[] = []): GateDefinition {
  return { id, severity: 'REQUIRED', kind: 'command', command, evidence: 'command-output', owner: 'quality', exception_allowed: true, depends_on };
}

async function bindFixtureToGit(fixture: Awaited<ReturnType<typeof runnerFixture>>, withGitHubContext = false): Promise<ExecutionPlan> {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: fixture.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init');
  git('config', 'user.name', 'Harness Test');
  git('config', 'user.email', 'harness@example.invalid');
  await mkdir(path.join(fixture.root, 'src'), { recursive: true });
  await writeFile(path.join(fixture.root, 'src/test.txt'), 'base\n');
  git('add', 'src/test.txt');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(path.join(fixture.root, 'src/test.txt'), 'head\n');
  git('add', 'src/test.txt');
  git('commit', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const context: ExecutionContext | null = withGitHubContext ? { repository: approvalContext.repository, pull_request: approvalContext.pull_request, base_sha: base, head_sha: head } : null;
  return createPlan(fixture.bundle, classifyChanges(fixture.bundle, { changed_files: ['src/test.txt'], operation: 'merge', target_environment: 'test' }), [], new Date(), head, base, context);
}

function githubApproval(plan: ExecutionPlan, role = 'engineering', approver = 'engineering'): ApprovalRecord {
  return {
    id: `APP-GH-101-${role}`,
    gate_ids: ['gate.review'],
    role,
    approver,
    source: 'github-review',
    repository: approvalContext.repository,
    pull_request: approvalContext.pull_request,
    review_id: 101,
    commit_sha: plan.source_revision!,
    approval_reference: `https://github.com/${approvalContext.repository}/pull/${approvalContext.pull_request}#pullrequestreview-101`,
    approved_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2099-08-10T00:00:00.000Z',
  };
}

test('executes commands without a shell and redacts persisted logs', async () => {
  const secret = 'super-secret-token';
  const key = 'HARNESS_TEST_SECRET_TOKEN';
  process.env[key] = secret;
  const fixture = await runnerFixture([commandGate('gate.pass', 'pass')], {
    pass: { executable: process.execPath, args: ['-e', `console.log(process.env.${key})`], cwd: '.', timeout_seconds: 5, inherited_environment: [key], sensitive_environment: [key] },
  });
  try {
    const manifest = await runPlan(fixture.bundle, fixture.plan, { output_dir: path.join(fixture.root, 'evidence') });
    assert.equal(manifest.result, 'passed');
    assert.equal(manifest.gates[0].state, 'passed');
    assert.equal(manifest.ci_provenance, null);
    const log = await readFile(path.join(fixture.root, 'evidence', manifest.gates[0].log_path!), 'utf8');
    assert.equal(log.includes(secret), false);
    assert.match(log, /\[REDACTED\]/);
  } finally {
    delete process.env[key];
  }
});

test('records GitHub Actions provenance supplied by the trusted runner context', async () => {
  const fixture = await runnerFixture([commandGate('gate.pass', 'pass')], {
    pass: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeout_seconds: 5 },
  });
  const ci_provenance = { provider: 'github-actions' as const, repository: 'nicejoyce/enterprise-development-harness', run_id: '123456', run_attempt: 2, workflow_ref: 'nicejoyce/enterprise-development-harness/.github/workflows/harness.yml@refs/heads/main', event_name: 'pull_request_target' };
  const manifest = await runPlan(fixture.bundle, fixture.plan, { output_dir: path.join(fixture.root, 'ci-evidence'), ci_provenance });
  assert.deepEqual(manifest.ci_provenance, ci_provenance);
});

test('records nonzero exit and blocks dependent gates', async () => {
  const fixture = await runnerFixture([commandGate('gate.fail', 'fail'), commandGate('gate.after', 'after', ['gate.fail'])], {
    fail: { executable: process.execPath, args: ['-e', 'process.exit(9)'], cwd: '.', timeout_seconds: 5 },
    after: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeout_seconds: 5 },
  });
  const manifest = await runPlan(fixture.bundle, fixture.plan, { output_dir: path.join(fixture.root, 'evidence') });
  assert.equal(manifest.result, 'failed');
  assert.deepEqual(manifest.gates.map(({ gate_id, state }) => ({ gate_id, state })), [{ gate_id: 'gate.fail', state: 'failed' }]);
});

test('terminates commands that exceed their timeout', async () => {
  const fixture = await runnerFixture([commandGate('gate.timeout', 'timeout')], {
    timeout: { executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: '.', timeout_seconds: 1 },
  });
  const manifest = await runPlan(fixture.bundle, fixture.plan, { output_dir: path.join(fixture.root, 'evidence') });
  assert.equal(manifest.gates[0].state, 'timed_out');
  assert.equal(manifest.result, 'failed');
  assert.equal(exitCodeForManifest(manifest), 6);
});

test('records cancellation separately from timeout and ordinary gate failure', async () => {
  const fixture = await runnerFixture([commandGate('gate.cancel', 'cancel')], {
    cancel: { executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: '.', timeout_seconds: 30 },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const manifest = await runPlan(fixture.bundle, fixture.plan, { output_dir: path.join(fixture.root, 'cancelled'), signal: controller.signal });
  assert.equal(manifest.gates[0].state, 'cancelled');
  assert.equal(exitCodeForManifest(manifest), 7);
});

test('passes a manual review only with a valid approval record', async () => {
  const fixture = await runnerFixture([{ id: 'gate.review', severity: 'REQUIRED', kind: 'manual-review', evidence: 'approval-record', owner: 'engineering', exception_allowed: true }], {});
  const plan = await bindFixtureToGit(fixture, true);
  const withoutApproval = await runPlan(fixture.bundle, plan, { output_dir: await mkdtemp(path.join(tmpdir(), 'harness-without-approval-')), ...plan.context! });
  assert.equal(withoutApproval.result, 'failed');
  const withApproval = await runPlan(fixture.bundle, plan, {
    output_dir: await mkdtemp(path.join(tmpdir(), 'harness-with-approval-')),
    approvals: [githubApproval(plan)],
    ...plan.context!,
  });
  assert.equal(withApproval.result, 'passed');
  assert.deepEqual(withApproval.context, plan.context);
  assert.equal(withApproval.gates[0].approval_id, 'APP-GH-101-engineering');
});

test('fails closed when any run context field differs from the plan context', async () => {
  const fixture = await runnerFixture([commandGate('gate.pass', 'pass')], {
    pass: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeout_seconds: 5 },
  });
  const plan = await bindFixtureToGit(fixture, true);
  const context = plan.context!;
  for (const mismatch of [
    { repository: 'attacker/repository' },
    { pull_request: context.pull_request + 1 },
    { base_sha: 'c'.repeat(40) },
    { head_sha: 'c'.repeat(40) },
  ]) {
    await assert.rejects(
      () => runPlan(fixture.bundle, plan, { output_dir: path.join(fixture.root, 'context-mismatch'), ...context, ...mismatch }),
      /context/i,
    );
  }
});

test('requires every planned approval role for a manual review', async () => {
  const fixture = await runnerFixture([{ id: 'gate.review', severity: 'REQUIRED', kind: 'manual-review', evidence: 'approval-record', owner: 'engineering', exception_allowed: true }], {}, ['engineering', 'security']);
  fixture.bundle.profile.approvals.roles.security = ['security'];
  const plan = await bindFixtureToGit(fixture, true);
  const onlyEngineering = await runPlan(fixture.bundle, plan, {
    output_dir: path.join(fixture.root, 'partial-approval'),
    approvals: [githubApproval(plan)],
    ...plan.context!,
  });
  assert.equal(onlyEngineering.result, 'failed');
});

test('binds evidence to the containing Git repository when Harness is nested', async () => {
  const fixture = await runnerFixture([commandGate('gate.pass', 'pass')], {
    pass: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeout_seconds: 5 },
  });
  const nestedRoot = path.join(fixture.root, 'policies', 'company-harness');
  await mkdir(nestedRoot, { recursive: true });
  fixture.bundle.root = nestedRoot;
  const plan = await bindFixtureToGit(fixture);
  const manifest = await runPlan(fixture.bundle, plan, { output_dir: path.join(fixture.root, 'nested-evidence') });
  assert.equal(manifest.repository_root, await realpath(fixture.root));
});

test('executes npm descriptors on Windows without enabling arbitrary shell commands', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await runnerFixture([commandGate('gate.npm', 'npm-version')], {
    'npm-version': { executable: 'npm', args: ['--version'], cwd: '.', timeout_seconds: 10 },
  });
  const manifest = await runPlan(fixture.bundle, fixture.plan, { output_dir: path.join(fixture.root, 'npm-evidence') });
  assert.equal(manifest.gates[0].state, 'passed');
});
