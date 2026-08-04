import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { finalizeManifest, verifyEvidence } from '../src/evidence.ts';
import { sha256 } from '../src/hash.ts';
import { loadContracts } from '../src/contracts.ts';
import { classifyChanges } from '../src/classifier.ts';
import { createPlan } from '../src/planner.ts';
import { runPlan } from '../src/runner.ts';
import type { EvidenceManifest } from '../src/types.ts';

async function validEvidence() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'harness-evidence-project-'));
  await cp(path.resolve('fixtures/neutral-project'), projectRoot, { recursive: true });
  const bundle = await loadContracts(projectRoot);
  const classification = classifyChanges(bundle, { changed_files: ['src/example.txt'], operation: 'merge', target_environment: 'test' });
  const plan = await createPlan(bundle, classification, []);
  const output = await mkdtemp(path.join(tmpdir(), 'harness-evidence-'));
  const manifest = await runPlan(bundle, plan, { output_dir: output });
  return { bundle, output, manifest, manifestPath: path.join(output, 'manifest.json') };
}

test('detects a modified evidence log', async () => {
  const fixture = await validEvidence();
  assert.equal((await verifyEvidence(fixture.bundle.root, fixture.manifestPath)).valid, true);
  await writeFile(path.join(fixture.output, fixture.manifest.gates[0].log_path!), 'tampered');
  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'EVIDENCE_DIGEST_MISMATCH'));
});

test('rejects a forged plan snapshot even when the attacker recomputes every digest', async () => {
  const fixture = await validEvidence();
  const planPath = path.join(fixture.output, 'plan.json');
  const forgedPlan = JSON.parse(await readFile(planPath, 'utf8')) as { gates: unknown[] };
  forgedPlan.gates = [];
  await writeFile(planPath, JSON.stringify(forgedPlan));

  const forgedManifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  forgedManifest.plan_sha256 = sha256(JSON.stringify(forgedPlan));
  forgedManifest.gates = [];
  forgedManifest.result = 'passed';
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(forgedManifest)));

  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'PLAN_INVALID'));
});

test('rejects evidence whose commit does not match the plan source revision', async () => {
  const fixture = await validEvidence();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  manifest.commit_sha = 'a'.repeat(40);
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(manifest)));
  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'PLAN_INVALID'));
});

test('rejects a forged passed command state with a nonzero exit code', async () => {
  const fixture = await validEvidence();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  manifest.gates[0].exit_code = 9;
  manifest.gates[0].state = 'passed';
  manifest.result = 'passed';
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(manifest)));
  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'EVIDENCE_INVALID'));
});

test('rejects command evidence when its required log is omitted', async () => {
  const fixture = await validEvidence();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  delete manifest.gates[0].log_path;
  delete manifest.gates[0].log_sha256;
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(manifest)));
  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'EVIDENCE_ARTIFACT_MISSING'));
});

test('rejects a manifest that does not satisfy the evidence schema', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-evidence-invalid-'));
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ version: 1, result: 'passed' }));
  const result = await verifyEvidence(path.resolve('fixtures/neutral-project'), manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'EVIDENCE_INVALID'));
});

test('rejects malformed CI provenance in an evidence manifest', async () => {
  const fixture = await validEvidence();
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  (manifest as unknown as { ci_provenance: unknown }).ci_provenance = { provider: 'github-actions', run_id: '' };
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(manifest)));
  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'EVIDENCE_INVALID'));
});

test('fails closed when evidence verification receives a GitHub context absent from the manifest', async () => {
  const fixture = await validEvidence();
  const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath, fixture.bundle.root, {
    repository: 'nicejoyce/enterprise-development-harness',
    pull_request: 42,
    base_sha: 'b'.repeat(40),
    head_sha: 'a'.repeat(40),
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.path.includes('context')));
});

test('fails closed when any expected evidence context field differs from the manifest', async () => {
  const fixture = await validEvidence();
  const context = { repository: 'nicejoyce/enterprise-development-harness', pull_request: 42, base_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40) };
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  manifest.context = context;
  const plan = JSON.parse(await readFile(path.join(fixture.output, 'plan.json'), 'utf8'));
  plan.context = context;
  await writeFile(path.join(fixture.output, 'plan.json'), JSON.stringify(plan));
  manifest.plan_sha256 = sha256(JSON.stringify(plan));
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(manifest)));

  for (const mismatch of [
    { repository: 'attacker/repository' },
    { pull_request: 43 },
    { base_sha: 'c'.repeat(40) },
    { head_sha: 'c'.repeat(40) },
  ]) {
    const result = await verifyEvidence(fixture.bundle.root, fixture.manifestPath, fixture.bundle.root, { ...context, ...mismatch });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.path === '/context'));
  }
});
