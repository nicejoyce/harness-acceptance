import { createHash } from 'node:crypto';

import type { ContractBundle } from './types.ts';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contractsDigest(bundle: ContractBundle): string {
  return sha256(stableJson({ profile: bundle.profile, gates: bundle.gates, routes: bundle.routes, registry: bundle.registry }));
}
