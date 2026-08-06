export interface DependencyChangeInput {
  manifest_changed: boolean;
  lockfile_changed: boolean;
  registry_changed: boolean;
  scripts_enabled: boolean;
  native_modules_changed: boolean;
  network_enabled: boolean;
  license_valid: boolean;
  sbom_present: boolean;
  vulnerability_scan: 'clear' | 'vulnerable' | 'unknown';
}

export interface DependencyChangeResult {
  category: 'preauthorized-install' | 'privileged-dependency-change';
  approval_required: boolean;
  reasons?: string[];
}

export function classifyDependencyChange(input: DependencyChangeInput): DependencyChangeResult {
  const reasons: string[] = [];
  if (!input.license_valid) reasons.push('license-invalid');
  if (!input.sbom_present) reasons.push('sbom-missing');
  if (input.vulnerability_scan !== 'clear') reasons.push(`vulnerability-${input.vulnerability_scan}`);
  if (input.manifest_changed) reasons.push('manifest-changed');
  if (input.lockfile_changed) reasons.push('lockfile-changed');
  if (input.registry_changed) reasons.push('registry-changed');
  if (input.scripts_enabled) reasons.push('install-scripts-enabled');
  if (input.native_modules_changed) reasons.push('native-capability-changed');
  if (input.network_enabled) reasons.push('network-enabled');
  if (reasons.length > 0) return { category: 'privileged-dependency-change', approval_required: true, reasons };
  return { category: 'preauthorized-install', approval_required: false };
}

export async function loadDependencyPolicy(contractRoot: string): Promise<DependencyPolicy> {
  const policy = parse(await readFile(path.join(contractRoot, 'contracts/dependency-policy.yaml'), 'utf8')) as DependencyPolicy;
  const validate = await schemaValidator('dependency-policy.schema.json');
  if (!validate(policy)) throw new Error(`Invalid dependency policy: ${schemaErrorMessages(validate.errors).join('; ')}`);
  return policy;
}
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import { schemaErrorMessages, schemaValidator } from './schema.ts';

export interface DependencyPolicy {
  version: 1;
  preauthorized_install: { lockfile_unchanged: true; registry_allowlist: string[]; install_scripts: false; native_modules: false; network: false };
  privileged_change_triggers: string[];
  required_evidence: string[];
}
