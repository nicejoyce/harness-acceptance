import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifyChanges } from '../src/classifier.ts';
import { loadContracts } from '../src/contracts.ts';
import { createPlan } from '../src/planner.ts';
import { runPlan } from '../src/runner.ts';
import { exportEd25519PrivateKey, exportEd25519PublicKey, signFinalResult } from '../src/signing.ts';

const cli = path.resolve('harness-cli/src/cli.ts');

test('aggregates, signs, and verifies a final result through the CLI', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'harness-final-project-'));
  await cp(path.resolve('fixtures/neutral-project'), projectRoot, { recursive: true });
  const bundle = await loadContracts(projectRoot);
  const classification = classifyChanges(bundle, { changed_files: ['src/example.txt'], operation: 'merge', target_environment: 'test' });
  const plan = await createPlan(bundle, classification, []);
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'harness-final-evidence-'));
  await runPlan(bundle, plan, { output_dir: evidenceRoot });
  const approvalsPath = path.join(evidenceRoot, 'expected-approvals.json');
  await writeFile(approvalsPath, '[]\n');
  const signedPath = path.join(evidenceRoot, 'final.signed.json');
  const keys = generateKeyPairSync('ed25519');
  const env = {
    ...process.env,
    HARNESS_ED25519_PRIVATE_KEY_B64: exportEd25519PrivateKey(keys.privateKey),
    HARNESS_ED25519_PUBLIC_KEY_B64: exportEd25519PublicKey(keys.publicKey),
  };

  const aggregate = spawnSync(process.execPath, [cli, 'final', 'aggregate', '--root', projectRoot, '--project-root', projectRoot, '--manifest', path.join(evidenceRoot, 'manifest.json'), '--expected-approvals', approvalsPath, '--job-conclusion', 'success', '--output', signedPath], { encoding: 'utf8', env });
  assert.equal(aggregate.status, 0, `${aggregate.stdout}\n${aggregate.stderr}`);
  const envelope = JSON.parse(await readFile(signedPath, 'utf8')) as { payload: { check_name: string; result: string } };
  assert.deepEqual(envelope.payload, { ...envelope.payload, check_name: 'harness-final', result: 'passed' });

  const verify = spawnSync(process.execPath, [cli, 'final', 'verify', '--input', signedPath, '--json'], { encoding: 'utf8', env });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  assert.equal(JSON.parse(verify.stdout).valid, true);
});

test('final verification rejects a different public trust anchor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-final-invalid-'));
  const input = path.join(root, 'final.signed.json');
  await writeFile(input, JSON.stringify({ version: 1, algorithm: 'Ed25519', key_id: '0'.repeat(64), payload: {}, signature_base64: '' }));
  const other = generateKeyPairSync('ed25519');
  const result = spawnSync(process.execPath, [cli, 'final', 'verify', '--input', input, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ED25519_PUBLIC_KEY_B64: exportEd25519PublicKey(other.publicKey) },
  });
  assert.equal(result.status, 5);
  assert.equal(JSON.parse(result.stdout).valid, false);
});

test('final verification selects the external trust anchor by key ID', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-final-keyring-'));
  const input = path.join(root, 'final.signed.json');
  const signing = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const envelope = signFinalResult({
    version: 1,
    context: null,
    generated_at: '2026-08-03T00:00:00.000Z',
    check_name: 'harness-final',
    job_conclusion: 'success',
    plan_sha256: 'c'.repeat(64),
    evidence: [{ platform: 'linux', manifest_sha256: 'd'.repeat(64), result: 'passed' }],
    result: 'passed',
  }, exportEd25519PrivateKey(signing.privateKey));
  await writeFile(input, JSON.stringify(envelope));
  const env = {
    ...process.env,
    HARNESS_ED25519_PUBLIC_KEY_B64: '',
    HARNESS_ED25519_PUBLIC_KEYS_JSON: JSON.stringify({
      [envelope.key_id]: exportEd25519PublicKey(signing.publicKey),
      [signFinalResult(envelope.payload, exportEd25519PrivateKey(other.privateKey)).key_id]: exportEd25519PublicKey(other.publicKey),
    }),
  };

  const valid = spawnSync(process.execPath, [cli, 'final', 'verify', '--input', input, '--json'], { encoding: 'utf8', env });
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

  env.HARNESS_ED25519_PUBLIC_KEYS_JSON = JSON.stringify({
    [signFinalResult(envelope.payload, exportEd25519PrivateKey(other.privateKey)).key_id]: exportEd25519PublicKey(other.publicKey),
  });
  const unknown = spawnSync(process.execPath, [cli, 'final', 'verify', '--input', input, '--json'], { encoding: 'utf8', env });
  assert.equal(unknown.status, 5);
  assert.equal(JSON.parse(unknown.stdout).valid, false);
});
