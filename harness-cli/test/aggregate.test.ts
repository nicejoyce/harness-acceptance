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

async function evidenceFixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'harness-aggregate-project-'));
  await cp(path.resolve('fixtures/neutral-project'), projectRoot, { recursive: true });
  const bundle = await loadContracts(projectRoot);
  const classification = classifyChanges(bundle, { changed_files: ['src/example.txt'], operation: 'merge', target_environment: 'test' });
  const plan = await createPlan(bundle, classification, []);
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
    generated_at: new Date('2026-08-03T00:00:00.000Z'),
  });

  assert.equal(final.check_name, 'harness-final');
  assert.equal(final.result, 'passed');
  assert.equal(final.evidence.length, 1);
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
  }), /Evidence verification failed/);
});
