import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('harness-cli/src/cli.ts');

test('validate returns JSON and zero for a valid root', () => {
  const result = spawnSync(process.execPath, [cli, 'validate', '--root', 'fixtures/neutral-project', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, diagnostics: [] });
});

test('validate returns the contract exit code for an invalid root', () => {
  const result = spawnSync(process.execPath, [cli, 'validate', '--root', 'fixtures/missing', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).valid, false);
});

test('plan creates its output directory and rejects invalid operation values', () => {
  const nestedOutput = path.resolve('fixtures/neutral-project/.harness-test/nested/plan.json');
  const valid = spawnSync(process.execPath, [cli, 'plan', '--root', 'fixtures/neutral-project', '--changed-file', 'src/a.txt', '--output', nestedOutput], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = spawnSync(process.execPath, [cli, 'plan', '--root', 'fixtures/neutral-project', '--changed-file', 'src/a.txt', '--operation', 'destroy', '--json'], { encoding: 'utf8' });
  assert.equal(invalid.status, 3);
  assert.equal(JSON.parse(invalid.stdout).valid, false);
});

test('run rejects a forged blocker exception in a hand-written plan', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-forged-plan-'));
  const planPath = path.join(output, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    version: 1,
    source_revision: null,
    operation: 'merge',
    target_environment: 'test',
    changed_files: ['src/security/token.ts'],
    risk_labels: [],
    route_ids: ['route.default', 'route.security'],
    rule_ids: ['SEC-001'],
    rule_attestations: [],
    approvals: ['engineering', 'security'],
    gates: [{ id: 'gate.security-scan', severity: 'BLOCKER', kind: 'command', command: 'security-scan', rule_ids: ['SEC-001'], depends_on: [], exception_id: 'EX-FORGED' }],
  }));
  const result = spawnSync(process.execPath, [cli, 'run', '--root', 'harness', '--plan', planPath, '--output', output, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
});

test('run rejects a hand-written plan that omits routed gates', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-empty-plan-'));
  const planPath = path.join(output, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    version: 1,
    source_revision: null,
    operation: 'merge',
    target_environment: 'test',
    changed_files: ['src/security/token.ts'],
    risk_labels: [],
    route_ids: ['route.default', 'route.security'],
    rule_ids: ['SEC-001'],
    rule_attestations: [],
    approvals: ['engineering', 'security'],
    gates: [],
  }));
  const result = spawnSync(process.execPath, [cli, 'run', '--root', 'harness', '--plan', planPath, '--output', output, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
});

test('approvals github rejects a noncanonical plan before generating approvals', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-forged-approval-plan-'));
  const planPath = path.join(output, 'plan.json');
  const reviewsPath = path.join(output, 'reviews.json');
  writeFileSync(planPath, JSON.stringify({ version: 1, source_revision: 'a'.repeat(40), operation: 'merge', target_environment: 'test', changed_files: ['src/security/token.ts'], risk_labels: [], route_ids: [], approvals: [], gates: [] }));
  writeFileSync(reviewsPath, '[]');
  const result = spawnSync(process.execPath, [cli, 'approvals', 'github', '--root', 'harness', '--plan', planPath, '--reviews', reviewsPath, '--output', path.join(output, 'approvals.json'), '--json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('approvals github requires repository and pull-request provenance', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-approval-context-'));
  const result = spawnSync(process.execPath, [cli, 'approvals', 'github', '--root', 'harness', '--plan', path.join(output, 'missing-plan.json'), '--reviews', path.join(output, 'missing-reviews.json'), '--output', path.join(output, 'approvals.json'), '--json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error, /--repository|--pull-request/);
});

test('run returns the stable timeout exit code', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-cli-timeout-'));
  const root = path.join(output, 'project');
  cpSync(path.resolve('fixtures/neutral-project'), root, { recursive: true });
  const profilePath = path.join(root, 'config/project-profile.yaml');
  writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace('console.log("unit ok")', 'setTimeout(() => {}, 10000)').replace('timeout_seconds: 30', 'timeout_seconds: 1'));
  const planPath = path.join(output, 'plan.json');
  const planned = spawnSync(process.execPath, [cli, 'plan', '--root', root, '--changed-file', 'src/a.txt', '--output', planPath], { encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  const result = spawnSync(process.execPath, [cli, 'run', '--root', root, '--plan', planPath, '--output', path.join(output, 'evidence'), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 6, `${result.stdout}\n${result.stderr}`);
});

test('plan rejects an incomplete GitHub execution context', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-plan-context-'));
  const result = spawnSync(process.execPath, [cli, 'plan', '--root', 'harness', '--changed-file', 'src/example.txt', '--repository', 'nicejoyce/enterprise-development-harness', '--output', path.join(output, 'plan.json'), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  assert.match(JSON.parse(result.stdout).error, /--repository, --pull-request, --base-sha, and --head-sha/);
});

test('workflow-policy check returns stable JSON for safe and unsafe workflows', () => {
  const safe = spawnSync(process.execPath, [cli, 'workflow-policy', 'check', '--workflow', 'harness-cli/test/fixtures/workflows/safe.yml', '--json'], { encoding: 'utf8' });
  assert.equal(safe.status, 0, `${safe.stdout}\n${safe.stderr}`);
  assert.deepEqual(JSON.parse(safe.stdout), { valid: true, diagnostics: [] });

  const unsafe = spawnSync(process.execPath, [cli, 'workflow-policy', 'check', '--workflow', 'harness-cli/test/fixtures/workflows/inline-pr-expression.yml', '--json'], { encoding: 'utf8' });
  assert.equal(unsafe.status, 2, `${unsafe.stdout}\n${unsafe.stderr}`);
  assert.equal(JSON.parse(unsafe.stdout).diagnostics[0].code, 'UNTRUSTED_RUN_INTERPOLATION');
});

test('workflow-policy check scans a workflow root against its trusted baseline', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'workflow-policy-cli-'));
  const baselineRoot = path.join(tempRoot, 'baseline');
  const workflowRoot = path.join(tempRoot, 'head');
  mkdirSync(baselineRoot);
  mkdirSync(workflowRoot);
  writeFileSync(path.join(baselineRoot, 'harness.yml'), readFileSync('harness-cli/test/fixtures/workflows/safe.yml', 'utf8'));
  writeFileSync(path.join(workflowRoot, 'bypass.yaml'), readFileSync('harness-cli/test/fixtures/workflows/inline-pr-expression.yml', 'utf8'));

  const result = spawnSync(process.execPath, [cli, 'workflow-policy', 'check', '--workflow-root', workflowRoot, '--baseline-workflow-root', baselineRoot, '--json'], { encoding: 'utf8' });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const diagnostics = JSON.parse(result.stdout).diagnostics as Array<{ code: string; document: string }>;
  assert.ok(diagnostics.some((item) => item.code === 'UNTRUSTED_RUN_INTERPOLATION' && item.document === 'bypass.yaml'));
  assert.ok(diagnostics.some((item) => item.code === 'TRUSTED_WORKFLOW_REMOVED' && item.document === 'harness.yml'));
});

test('identities github creates a commit-bound authorization snapshot', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-identities-cli-'));
  const subjects = path.join(output, 'subjects.json');
  const snapshot = path.join(output, 'identities.json');
  writeFileSync(subjects, JSON.stringify([{ login: 'alice', user_type: 'User', affiliation_state: 'active', api_source: 'github-repository-collaborator-permission', queried_at: '2026-08-05T00:00:00.000Z' }]));
  const result = spawnSync(process.execPath, [cli, 'identities', 'github', '--repository', 'nicejoyce/repo', '--pull-request', '42', '--base-sha', 'b'.repeat(40), '--head-sha', 'a'.repeat(40), '--author', 'author', '--subjects', subjects, '--captured-at', '2026-08-05T00:00:00.000Z', '--output', snapshot, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(readFileSync(snapshot, 'utf8')).subjects[0].login, 'alice');
});

test('attestations agents preserves Bot reviews separately from approvals', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-agent-attestations-cli-'));
  const reviews = path.join(output, 'reviews.json');
  const attestations = path.join(output, 'agent-attestations.json');
  writeFileSync(reviews, JSON.stringify([{ id: 10, user: { login: 'automation[bot]', type: 'Bot' }, state: 'APPROVED', submitted_at: '2026-08-05T00:00:00.000Z', commit_id: 'a'.repeat(40), body: 'audit' }]));
  const result = spawnSync(process.execPath, [cli, 'attestations', 'agents', '--repository', 'nicejoyce/repo', '--pull-request', '42', '--base-sha', 'b'.repeat(40), '--head-sha', 'a'.repeat(40), '--reviews', reviews, '--output', attestations, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(readFileSync(attestations, 'utf8'))[0].actor_type, 'Bot');
});

test('coverage verify returns structured changed-line coverage diagnostics', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-coverage-cli-'));
  const projectRoot = path.join(output, 'project');
  mkdirSync(projectRoot);
  mkdirSync(path.join(projectRoot, 'src'));
  writeFileSync(path.join(projectRoot, 'src/example.ts'), 'export const one = 1;\n');
  for (const args of [['init'], ['config', 'user.email', 'harness@example.test'], ['config', 'user.name', 'Harness Test'], ['add', '.'], ['commit', '-m', 'base']]) {
    const git = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(git.status, 0, `${git.stdout}\n${git.stderr}`);
  }
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(base.status, 0, `${base.stdout}\n${base.stderr}`);
  writeFileSync(path.join(projectRoot, 'src/example.ts'), 'export const one = 2;\n');
  for (const args of [['add', '.'], ['commit', '-m', 'head']]) {
    const git = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(git.status, 0, `${git.stdout}\n${git.stderr}`);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(head.status, 0, `${head.stdout}\n${head.stderr}`);
  const report = path.join(output, 'coverage.json');
  writeFileSync(report, '{}');
  const result = spawnSync(process.execPath, [cli, 'coverage', 'verify', '--project-root', projectRoot, '--base', base.stdout.trim(), '--head', head.stdout.trim(), '--report', report, '--json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).valid, false);
});

test('dependencies classify exposes fail-closed privilege decisions', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-dependencies-cli-'));
  const input = path.join(output, 'dependency-change.json');
  writeFileSync(input, JSON.stringify({ manifest_changed: false, lockfile_changed: true, registry_changed: false, scripts_enabled: false, native_modules_changed: false, network_enabled: false, license_valid: true, sbom_present: true, vulnerability_scan: 'clear' }));
  const result = spawnSync(process.execPath, [cli, 'dependencies', 'classify', '--root', 'harness', '--input', input, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).classification.approval_required, true);
});

test('mutation verify emits structured evidence from a Stryker report', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'harness-mutation-cli-'));
  const report = path.join(output, 'mutation.json');
  writeFileSync(report, JSON.stringify({ files: { 'src/logic.ts': { mutants: [{ status: 'Killed' }] } } }));
  const result = spawnSync(process.execPath, [cli, 'mutation', 'verify', '--root', 'harness', '--report', report, '--changed-module', 'src/logic.ts', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).score, 100);
});
