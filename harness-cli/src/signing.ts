import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import type { FinalResult } from './aggregate.ts';
import { sha256, stableJson } from './hash.ts';

export interface SignedFinalResult {
  version: 1;
  algorithm: 'Ed25519';
  key_id: string;
  payload: FinalResult;
  signature_base64: string;
}

function privateKey(encoded: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519');
  return key;
}

function publicKey(encoded: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Trusted public key must be Ed25519');
  return key;
}

function publicKeyId(encoded: string): string {
  return sha256(publicKey(encoded).export({ format: 'der', type: 'spki' }));
}

export function exportEd25519PrivateKey(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Private key must be Ed25519');
  return key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

export function exportEd25519PublicKey(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Public key must be Ed25519');
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function loadTrustedEd25519PublicKeys(keyringJson?: string, legacyPublicKeyBase64?: string): Map<string, string> {
  const anchors = new Map<string, string>();
  if (keyringJson?.trim()) {
    const parsed: unknown = JSON.parse(keyringJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HARNESS_ED25519_PUBLIC_KEYS_JSON must be a JSON object');
    for (const [declaredKeyId, encoded] of Object.entries(parsed)) {
      if (!/^[a-f0-9]{64}$/.test(declaredKeyId) || typeof encoded !== 'string' || encoded.length === 0) throw new Error('Ed25519 trust anchors must map a SHA-256 key ID to a non-empty public key');
      const actualKeyId = publicKeyId(encoded);
      if (declaredKeyId !== actualKeyId) throw new Error(`Declared Ed25519 key ID ${declaredKeyId} does not match its public key`);
      anchors.set(declaredKeyId, encoded);
    }
  }
  if (legacyPublicKeyBase64?.trim()) anchors.set(publicKeyId(legacyPublicKeyBase64), legacyPublicKeyBase64);
  if (anchors.size === 0) throw new Error('At least one trusted Ed25519 public key is required');
  return anchors;
}

export function signFinalResult(payload: FinalResult, privateKeyBase64: string): SignedFinalResult {
  const signer = privateKey(privateKeyBase64);
  const trustAnchor = createPublicKey(signer).export({ format: 'der', type: 'spki' });
  return {
    version: 1,
    algorithm: 'Ed25519',
    key_id: sha256(trustAnchor),
    payload: structuredClone(payload),
    signature_base64: sign(null, Buffer.from(stableJson(payload)), signer).toString('base64'),
  };
}

export function verifySignedFinalResult(envelope: SignedFinalResult, publicKeyBase64: string): boolean {
  try {
    const verifier = publicKey(publicKeyBase64);
    const trustAnchor = verifier.export({ format: 'der', type: 'spki' });
    return envelope.version === 1
      && envelope.algorithm === 'Ed25519'
      && envelope.key_id === sha256(trustAnchor)
      && verify(null, Buffer.from(stableJson(envelope.payload)), verifier, Buffer.from(envelope.signature_base64, 'base64'));
  } catch {
    return false;
  }
}
