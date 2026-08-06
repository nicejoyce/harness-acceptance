import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateTrustedEvidence } from '../src/aggregate.ts';
import { classifyChanges } from '../src/classifier.ts';
import { loadContracts } from '../src/contracts.ts';
import { finalizeManifest } from '../src/evidence.ts';
import { createPlan } from '../src/planner.ts';
import { runPlan } from '../src/runner.ts';
import type { EvidenceManifest } from '../src/types.ts';

async function writePlatformPolicy(root: string, baseline = [process.platform]): Promise<void> {
  await writeFile(path.join(root, 'contracts/platform-policy.yaml'), JSON.stringify({
    version: 1,
    mode: 'enforce',
    platforms: {
      linux: { runner: 'ubuntu-latest' },
      win32: { runner: 'windows-latest' },
      darwin: { runner: 'macos-latest' },
    },
    baseline_platforms: baseline,
    full_matrix: ['linux', 'win32', 'darwin'],
    full_matrix_operations: ['release'],
    full_matrix_route_ids: ['route.unknown'],
    rules: [],
  }));
}

async function evidenceFixture(lane: 'fast' | 'full' = 'full', baseline = [process.platform]) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'harness-aggregate-project-'));
  await cp(path.resolve('fixtures/neutral-project'), projectRoot, { recursive: true });
  await writePlatformPolicy(projectRoot, baseline);
  const bundle = await loadContracts(projectRoot);
  const classification = classifyChanges(bundle, { changed_files: ['src/example.txt'], operation: 'merge', target_environment: 'test' });
  const plan = await createPlan(bundle, classification, [], new Date(), null, null, null, lane);
  const output = await mkdtemp(path.join(tmpdir(), 'harness-aggregate-evidence-'));
  const manifest = await runPlan(bundle, plan, { output_dir: output });
  return { bundle, projectRoot, output, manifestPath: path.join(output, 'manifest.json') };
}

test('recomputes a passing final result from validated evidence and the trusted job conclusion', async () => {
  const fixture = await evidenceFixture();
  const final = await aggregateTrustedEvidence({
    contract_root: fixture.bundle.root,
    project_root: fixture.projectRoot,
    context: null,
    manifest_paths: [fixture.manifestPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
    generated_at: new Date('2026-08-03T00:00:00.000Z'),
  });

  assert.equal(final.check_name, 'harness-final');
  assert.equal(final.result, 'passed');
  assert.equal(final.evidence.length, 1);
});

test('rejects missing, duplicate, and extra platform Evidence', async () => {
  const otherPlatform = process.platform === 'linux' ? 'win32' : 'linux';
  const missing = await evidenceFixture('full', [process.platform, otherPlatform]);
  await assert.rejects(() => aggregateTrustedEvidence({
    contract_root: missing.bundle.root,
    project_root: missing.projectRoot,
    context: null,
    manifest_paths: [missing.manifestPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
  }), /platform.*missing/i);

  const duplicate = await evidenceFixture();
  await assert.rejects(() => aggregateTrustedEvidence({
    contract_root: duplicate.bundle.root,
    project_root: duplicate.projectRoot,
    context: null,
    manifest_paths: [duplicate.manifestPath, duplicate.manifestPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
  }), /duplicate.*platform/i);

  const extra = await evidenceFixture();
  const manifest = JSON.parse(await readFile(extra.manifestPath, 'utf8')) as EvidenceManifest;
  const extraPath = path.join(extra.output, 'extra-manifest.json');
  await writeFile(extraPath, JSON.stringify(finalizeManifest({ ...manifest, platform: otherPlatform })));
  await assert.rejects(() => aggregateTrustedEvidence({
    contract_root: extra.bundle.root,
    project_root: extra.projectRoot,
    context: null,
    manifest_paths: [extra.manifestPath, extraPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
  }), /platform.*extra/i);
});

test('rejects fast-lane evidence as a merge result', async () => {
  const fixture = await evidenceFixture('fast');
  await assert.rejects(() => aggregateTrustedEvidence({
    contract_root: fixture.bundle.root,
    project_root: fixture.projectRoot,
    context: null,
    manifest_paths: [fixture.manifestPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
  }), /full lane/i);
});

test('fails closed when the GitHub job failed or one manifest was tampered', async () => {
  const fixture = await evidenceFixture();
  const failed = await aggregateTrustedEvidence({
    contract_root: fixture.bundle.root,
    project_root: fixture.projectRoot,
    context: null,
    manifest_paths: [fixture.manifestPath],
    job_conclusion: 'failure',
    expected_approvals: [],
    expected_rule_attestations: [],
  });
  assert.equal(failed.result, 'failed');

  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as EvidenceManifest;
  manifest.result = 'failed';
  await writeFile(fixture.manifestPath, JSON.stringify(finalizeManifest(manifest)));
  await assert.rejects(() => aggregateTrustedEvidence({
    contract_root: fixture.bundle.root,
    project_root: fixture.projectRoot,
    context: null,
    manifest_paths: [fixture.manifestPath],
    job_conclusion: 'success',
    expected_approvals: [],
    expected_rule_attestations: [],
  }), /Evidence verification failed/);
});
