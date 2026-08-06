import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { minimatch } from 'minimatch';
import { parse } from 'yaml';

import { schemaErrorMessages, schemaValidator } from './schema.ts';
import type { ClassificationInput } from './types.ts';

export type PlatformId = 'linux' | 'win32' | 'darwin';

export interface PlatformPolicy {
  version: 1;
  mode: 'shadow' | 'enforce';
  platforms: Record<PlatformId, { runner: string }>;
  baseline_platforms: PlatformId[];
  full_matrix: PlatformId[];
  full_matrix_operations: ClassificationInput['operation'][];
  full_matrix_route_ids: string[];
  rules: Array<{ id: string; reason_code: string; include: string[]; platforms: PlatformId[] }>;
}

export interface PlatformSelectionInput {
  changed_files: string[];
  route_ids: string[];
  operation: ClassificationInput['operation'];
  classification_conflict?: boolean;
}

export interface PlatformSelection {
  expected_platforms: PlatformId[];
  platform_reason_codes: string[];
  fallback_full_matrix: boolean;
}

const fullMatrix: PlatformId[] = ['darwin', 'linux', 'win32'];

function normalizedFile(file: string): string | null {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return null;
  return normalized;
}

function sortedPlatforms(platforms: Iterable<PlatformId>): PlatformId[] {
  return [...new Set(platforms)].sort();
}

function fullSelection(reason: string): PlatformSelection {
  return { expected_platforms: [...fullMatrix], platform_reason_codes: [reason], fallback_full_matrix: true };
}

export async function loadPlatformPolicy(root: string): Promise<PlatformPolicy> {
  const policyPath = path.join(root, 'contracts/platform-policy.yaml');
  const value: unknown = parse(await readFile(policyPath, 'utf8'));
  const validate = await schemaValidator('platform-policy.schema.json');
  if (!validate(value)) throw new Error(`Platform policy is invalid: ${schemaErrorMessages(validate.errors).join('; ')}`);
  return value as PlatformPolicy;
}

export function selectPlatforms(policy: PlatformPolicy | null, input: PlatformSelectionInput): PlatformSelection {
  if (!policy) return fullSelection('platform.fallback.policy-unavailable');
  if (input.classification_conflict) return fullSelection('platform.fallback.classification-conflict');
  const files = input.changed_files.map(normalizedFile);
  if (files.some((file) => file === null)) return fullSelection('platform.fallback.unsafe-path');
  if (input.route_ids.some((routeId) => policy.full_matrix_route_ids.includes(routeId))) return fullSelection('platform.fallback.unknown-route');

  const platforms = new Set<PlatformId>(policy.baseline_platforms);
  const reasons = new Set<string>(['platform.baseline']);
  if (policy.full_matrix_operations.includes(input.operation)) {
    for (const platform of policy.full_matrix) platforms.add(platform);
    reasons.add(`platform.operation.${input.operation}`);
  }
  for (const rule of policy.rules) {
    if (!(files as string[]).some((file) => rule.include.some((pattern) => minimatch(file, pattern, { dot: true, nocase: false })))) continue;
    for (const platform of rule.platforms) platforms.add(platform);
    reasons.add(rule.reason_code);
  }
  return {
    expected_platforms: sortedPlatforms(platforms),
    platform_reason_codes: [...reasons].sort(),
    fallback_full_matrix: false,
  };
}

export function platformMatrix(policy: PlatformPolicy, platforms: PlatformId[]): { include: Array<{ platform: PlatformId; runner: string }> } {
  if (new Set(platforms).size !== platforms.length) throw new Error('Platform matrix contains duplicate platform IDs');
  const include = sortedPlatforms(platforms).map((platform) => {
    const definition = policy.platforms[platform];
    if (!definition) throw new Error(`Unknown platform ID: ${platform}`);
    return { platform, runner: definition.runner };
  });
  return { include };
}
