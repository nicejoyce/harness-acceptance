import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { exportEd25519PrivateKey, exportEd25519PublicKey, loadTrustedEd25519PublicKeys, signFinalResult, verifySignedFinalResult } from '../src/signing.ts';
import type { FinalResult } from '../src/aggregate.ts';

function result(): FinalResult {
  return {
    version: 1,
    context: {
      repository: 'nicejoyce/enterprise-development-harness',
      pull_request: 42,
      base_sha: 'b'.repeat(40),
      head_sha: 'a'.repeat(40),
    },
    generated_at: '2026-08-03T00:00:00.000Z',
    check_name: 'harness-final',
    job_conclusion: 'success',
    plan_sha256: 'c'.repeat(64),
    expected_platforms: ['linux', 'win32'],
    execution_platforms: ['linux', 'win32'],
    platform_reason_codes: ['platform.baseline', 'platform.windows-semantics'],
    fallback_full_matrix: false,
    platform_mode: 'enforce',
    evidence: [
      { platform: 'linux', manifest_sha256: 'd'.repeat(64), result: 'passed' },
      { platform: 'win32', manifest_sha256: 'e'.repeat(64), result: 'passed' },
    ],
    approvals: [],
    thresholds: [],
    result: 'passed',
  };
}

test('signs a canonical final result with Ed25519 and verifies against an external public key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = signFinalResult(result(), exportEd25519PrivateKey(privateKey));

  assert.equal(signed.algorithm, 'Ed25519');
  assert.equal(signed.key_id.length, 64);
  assert.equal(verifySignedFinalResult(signed, exportEd25519PublicKey(publicKey)), true);
});

test('rejects a tampered final result and a different trust anchor', () => {
  const signing = generateKeyPairSync('ed25519');
  const attacker = generateKeyPairSync('ed25519');
  const signed = signFinalResult(result(), exportEd25519PrivateKey(signing.privateKey));

  signed.payload.result = 'failed';
  assert.equal(verifySignedFinalResult(signed, exportEd25519PublicKey(signing.publicKey)), false);
  assert.equal(verifySignedFinalResult(signFinalResult(result(), exportEd25519PrivateKey(signing.privateKey)), exportEd25519PublicKey(attacker.publicKey)), false);
});

test('loads overlapping Ed25519 trust anchors for key rotation', () => {
  const oldKey = generateKeyPairSync('ed25519');
  const newKey = generateKeyPairSync('ed25519');
  const oldEnvelope = signFinalResult(result(), exportEd25519PrivateKey(oldKey.privateKey));
  const newEnvelope = signFinalResult(result(), exportEd25519PrivateKey(newKey.privateKey));
  const anchors = loadTrustedEd25519PublicKeys(JSON.stringify({
    [oldEnvelope.key_id]: exportEd25519PublicKey(oldKey.publicKey),
    [newEnvelope.key_id]: exportEd25519PublicKey(newKey.publicKey),
  }));

  assert.equal(verifySignedFinalResult(oldEnvelope, anchors.get(oldEnvelope.key_id)!), true);
  assert.equal(verifySignedFinalResult(newEnvelope, anchors.get(newEnvelope.key_id)!), true);
});

test('rejects malformed keyrings and a declared key ID that does not match its public key', () => {
  const key = generateKeyPairSync('ed25519');
  const publicKey = exportEd25519PublicKey(key.publicKey);

  assert.throws(() => loadTrustedEd25519PublicKeys('[]'), /JSON object/);
  assert.throws(() => loadTrustedEd25519PublicKeys(JSON.stringify({ ['0'.repeat(64)]: publicKey })), /does not match/);
});

test('rejects non-Ed25519 signing keys and trust anchors', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPrivate = rsa.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const rsaPublic = rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  assert.throws(() => exportEd25519PrivateKey(rsa.privateKey), /Ed25519/);
  assert.throws(() => exportEd25519PublicKey(rsa.publicKey), /Ed25519/);
  assert.throws(() => signFinalResult(result(), rsaPrivate), /Ed25519/);
  assert.throws(() => loadTrustedEd25519PublicKeys(undefined, rsaPublic), /Ed25519/);
});
