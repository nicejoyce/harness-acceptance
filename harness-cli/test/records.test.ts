import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { aggregateTrustedEvidence } from '../src/aggregate.ts';
import { classifyChanges } from '../src/classifier.ts';
import { loadContracts } from '../src/contracts.ts';
import { createPlan } from '../src/planner.ts';
import { deriveDeliveryRecord, renderDeliveryRecord } from '../src/records.ts';
import { runPlan } from '../src/runner.ts';
import { exportEd25519PrivateKey, exportEd25519PublicKey, signFinalResult } from '../src/signing.ts';
import type { SignedFinalResult } from '../src/signing.ts';

const cli = path.resolve('harness-cli/src/cli.ts');

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'harness-record-project-'));
  await cp(path.resolve('fixtures/neutral-project'), projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'contracts/platform-policy.yaml'), JSON.stringify({ version: 1, mode: 'enforce', platforms: { linux: { runner: 'ubuntu-latest' }, win32: { runner: 'windows-latest' }, darwin: { runner: 'macos-latest' } }, baseline_platforms: [process.platform], full_matrix: ['linux', 'win32', 'darwin'], full_matrix_operations: ['release'], full_matrix_route_ids: ['route.unknown'], rules: [] }));
  await cp(path.resolve('harness/contracts/quality-baseline.yaml'), path.join(projectRoot, 'contracts/quality-baseline.yaml'));
  await cp(path.resolve('harness/contracts/test-quality-policy.yaml'), path.join(projectRoot, 'contracts/test-quality-policy.yaml'));
  const bundle = await loadContracts(projectRoot);
  const classification = classifyChanges(bundle, { changed_files: ['src/example.txt'], operation: 'merge', target_environment: 'test' });
  const plan = await createPlan(bundle, classification, [], new Date('2026-08-05T00:00:00.000Z'));
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'harness-record-evidence-'));
  const manifest = await runPlan(bundle, plan, { output_dir: evidenceRoot });
  const manifestPath = path.join(evidenceRoot, 'manifest.json');
  const payload = await aggregateTrustedEvidence({
    contract_root: projectRoot,
    project_root: projectRoot,
    context: null,
    manifest_paths: [manifestPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
    generated_at: new Date('2026-08-05T01:00:00.000Z'),
  });
  const keys = generateKeyPairSync('ed25519');
  const privateKey = exportEd25519PrivateKey(keys.privateKey);
  const publicKey = exportEd25519PublicKey(keys.publicKey);
  const signed = signFinalResult(payload, privateKey);
  const finalPath = path.join(evidenceRoot, 'final.signed.json');
  await writeFile(finalPath, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
  return { projectRoot, evidenceRoot, manifest, manifestPath, payload, signed, finalPath, privateKey, publicKey };
}

test('derives observable facts while leaving motive and risk judgments human-authored', async () => {
  const item = await fixture();
  const record = await deriveDeliveryRecord({
    contract_root: item.projectRoot,
    project_root: item.projectRoot,
    manifest_path: item.manifestPath,
    final_path: item.finalPath,
    trusted_public_keys: new Map([[item.signed.key_id, item.publicKey]]),
  });

  assert.equal(record.facts.evidence_sha256, item.manifest.manifest_sha256);
  assert.equal(record.facts.signing_key_id, item.signed.key_id);
  assert.equal(record.facts.platform, process.platform);
  assert.deepEqual(record.facts.route_ids, item.manifest.route_ids);
  assert.deepEqual(record.facts.gates.map((gate) => gate.id), item.manifest.gates.map((gate) => gate.gate_id));
  assert.deepEqual(record.facts.tool_versions, { harness: '0.1.0', node: process.version });
  assert.ok(record.facts.thresholds.some((threshold) => threshold.id === 'changed_line_coverage_minimum' && threshold.value === 80));
  assert.deepEqual(record.human_authored, {
    objective: null,
    design_motivation: null,
    risk_judgment: null,
    business_rationale: null,
    rollback_decision: null,
  });
  assert.doesNotMatch(JSON.stringify(record), /log_path|log_sha256|command_digest/);
});

test('rejects signed Final facts that disagree with the verified Evidence', async () => {
  const item = await fixture();
  const cases: Array<[string, SignedFinalResult]> = [
    ['hash', signFinalResult({ ...item.payload, evidence: [{ ...item.payload.evidence[0]!, manifest_sha256: 'f'.repeat(64) }] }, item.privateKey)],
    ['platform', signFinalResult({ ...item.payload, evidence: [{ ...item.payload.evidence[0]!, platform: 'forged-os' }] }, item.privateKey)],
    ['approval', signFinalResult({ ...item.payload, approvals: [{ id: 'APP-forged', role: 'engineering', approver: 'mallory', approval_reference: 'https://example.invalid/review/1', review_id: 1 }] }, item.privateKey)],
  ];

  for (const [label, signed] of cases) {
    await writeFile(item.finalPath, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
    await assert.rejects(deriveDeliveryRecord({
      contract_root: item.projectRoot,
      project_root: item.projectRoot,
      manifest_path: item.manifestPath,
      final_path: item.finalPath,
      trusted_public_keys: new Map([[signed.key_id, item.publicKey]]),
    }), new RegExp(label, 'i'));
  }
});

test('renders JSON and Markdown without inventing human-authored content', async () => {
  const item = await fixture();
  const record = await deriveDeliveryRecord({
    contract_root: item.projectRoot,
    project_root: item.projectRoot,
    manifest_path: item.manifestPath,
    final_path: item.finalPath,
    trusted_public_keys: new Map([[item.signed.key_id, item.publicKey]]),
  });
  assert.deepEqual(JSON.parse(renderDeliveryRecord(record, 'json')), record);
  const markdown = renderDeliveryRecord(record, 'markdown');
  assert.match(markdown, /Harness Delivery Facts/);
  assert.match(markdown, new RegExp(item.manifest.manifest_sha256));
  assert.match(markdown, /Objective:\s*$/m);

  const output = path.join(item.evidenceRoot, 'record.md');
  const result = spawnSync(process.execPath, [cli, 'records', 'render', '--root', item.projectRoot, '--project-root', item.projectRoot, '--manifest', item.manifestPath, '--final', item.finalPath, '--format', 'markdown', '--output', output], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ED25519_PUBLIC_KEY_B64: item.publicKey },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(await readFile(output, 'utf8'), /Harness Delivery Facts/);
});
