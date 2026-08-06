import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parse, stringify } from 'yaml';

import { auditEnforcement } from '../src/enforcement-audit.ts';
import { loadContracts } from '../src/contracts.ts';
import { plannedRuleAttestations, validateRuleAttestations } from '../src/rule-attestations.ts';
import type { ExecutionPlan } from '../src/types.ts';

const canonicalRoot = path.resolve('harness');

async function copiedHarness(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-enforcement-'));
  await cp(canonicalRoot, root, { recursive: true });
  return root;
}

test('audits every rule without advisory or generic-review-only BLOCKERs', async () => {
  const result = await auditEnforcement(canonicalRoot);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.summary.total_rules, 84);
  assert.equal(result.summary.unclassified, 0);
  assert.equal(result.summary.blocker_advisory, 0);
  assert.equal(result.summary.blocker_rule_declares_only_peer_review, 0);
  assert.equal(result.summary.modes['human-attested'], 15);
  assert.equal(result.summary.modes['machine-enforced'], 1);
  assert.equal(result.summary.modes.advisory, 68);
  assert.equal(result.summary.blocker_without_effective_control, 0);
  assert.equal(result.summary.rules_without_gates, 83);
});

test('every human-attested BLOCKER fails closed without its specific attestation', async () => {
  const bundle = await loadContracts(canonicalRoot);
  assert.equal(bundle.registry.version, 4);
  if (bundle.registry.version !== 4) return;
  const humanBlockers = bundle.registry.rules.filter((rule) => rule.severity === 'BLOCKER' && rule.enforcement.mode === 'human-attested');
  assert.equal(humanBlockers.length, 15);
  for (const rule of humanBlockers) {
    const planned = await plannedRuleAttestations(bundle, [rule.id]);
    assert.equal(planned.length, 1, rule.id);
    const plan = {
      version: 1,
      lane: 'full',
      risk_tier: 'medium',
      expected_platforms: ['linux'],
      execution_platforms: ['linux'],
      platform_reason_codes: ['platform.baseline'],
      fallback_full_matrix: false,
      platform_mode: 'enforce',
      context: { repository: 'nicejoyce/repo', pull_request: 42, base_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40) },
      source_base_revision: 'b'.repeat(40),
      source_revision: 'a'.repeat(40),
      operation: 'merge',
      target_environment: 'test',
      changed_files: ['src/example.ts'],
      risk_labels: [], route_ids: [], rule_ids: [rule.id], rule_attestations: planned, approvals: [], gates: [],
    } satisfies ExecutionPlan;
    const diagnostics = await validateRuleAttestations(bundle, plan, []);
    assert.ok(diagnostics.some((item) => item.code === 'RULE_ATTESTATION_MISSING' && item.message.includes(planned[0]!.policy_id)), rule.id);
  }
});

test('rejects an enforcement inventory that omits a registry rule', async () => {
  const root = await copiedHarness();
  const inventoryPath = path.join(root, 'contracts/enforcement-inventory.yaml');
  const inventory = parse(await readFile(inventoryPath, 'utf8')) as { rules: unknown[] };
  inventory.rules.pop();
  await writeFile(inventoryPath, stringify(inventory), 'utf8');
  const result = await auditEnforcement(root);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'INVENTORY_COVERAGE_MISMATCH'));
});

test('rejects inventory enforcement declarations that drift from the registry', async () => {
  const root = await copiedHarness();
  const inventoryPath = path.join(root, 'contracts/enforcement-inventory.yaml');
  const inventory = parse(await readFile(inventoryPath, 'utf8')) as { rules: Array<Record<string, unknown>> };
  inventory.rules[0].attestation_policy_id = 'attestation.wrong-rule';
  await writeFile(inventoryPath, stringify(inventory), 'utf8');
  const result = await auditEnforcement(root);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'INVENTORY_DECLARATION_MISMATCH'));
});

test('rejects planned controls without an explicit known gap', async () => {
  const root = await copiedHarness();
  const inventoryPath = path.join(root, 'contracts/enforcement-inventory.yaml');
  const inventory = parse(await readFile(inventoryPath, 'utf8')) as { rules: Array<Record<string, unknown>> };
  inventory.rules[0].implementation_status = 'planned';
  inventory.rules[0].known_gap = null;
  await writeFile(inventoryPath, stringify(inventory), 'utf8');
  const result = await auditEnforcement(root);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'INVENTORY_INVALID'));
});

test('exposes enforcement audit through the CLI', () => {
  const execution = spawnSync(process.execPath, ['harness-cli/src/cli.ts', 'enforcement', 'audit', '--root', 'harness', '--json'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout) as { valid: boolean; summary: { total_rules: number } };
  assert.equal(result.valid, true);
  assert.equal(result.summary.total_rules, 84);
});
