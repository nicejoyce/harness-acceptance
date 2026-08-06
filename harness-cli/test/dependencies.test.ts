import assert from 'node:assert/strict';
import test from 'node:test';

import path from 'node:path';
import { classifyDependencyChange, loadDependencyPolicy } from '../src/dependencies.ts';

test('preauthorizes a locked registry-preserving install with scripts disabled', () => {
  assert.deepEqual(classifyDependencyChange({ manifest_changed: false, lockfile_changed: false, registry_changed: false, scripts_enabled: false, native_modules_changed: false, network_enabled: false, license_valid: true, sbom_present: true, vulnerability_scan: 'clear' }), { category: 'preauthorized-install', approval_required: false });
});

test('requires privileged approval for dependency graph, scripts, registry, or native changes', () => {
  for (const change of [
    { manifest_changed: true },
    { lockfile_changed: true },
    { registry_changed: true },
    { scripts_enabled: true },
    { native_modules_changed: true },
  ]) {
    const result = classifyDependencyChange({ manifest_changed: false, lockfile_changed: false, registry_changed: false, scripts_enabled: false, native_modules_changed: false, network_enabled: false, license_valid: true, sbom_present: true, vulnerability_scan: 'clear', ...change });
    assert.equal(result.category, 'privileged-dependency-change');
    assert.equal(result.approval_required, true);
  }
});

test('fails closed when license, SBOM, or vulnerability evidence is missing', () => {
  const result = classifyDependencyChange({ manifest_changed: false, lockfile_changed: false, registry_changed: false, scripts_enabled: false, native_modules_changed: false, network_enabled: false, license_valid: false, sbom_present: false, vulnerability_scan: 'unknown' });
  assert.equal(result.category, 'privileged-dependency-change');
  assert.equal(result.approval_required, true);
  assert.deepEqual(result.reasons, ['license-invalid', 'sbom-missing', 'vulnerability-unknown']);
});

test('loads identical canonical dependency policies', async () => {
  const english = await loadDependencyPolicy(path.resolve('harness'));
  const chinese = await loadDependencyPolicy(path.resolve('harness-zh'));
  assert.deepEqual(english, chinese);
  assert.equal(english.preauthorized_install.install_scripts, false);
  assert.ok(english.required_evidence.includes('sbom'));
});
