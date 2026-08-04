import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
