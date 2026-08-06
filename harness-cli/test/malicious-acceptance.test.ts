import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { classifyChanges } from '../src/classifier.ts';
import { classifyDependencyChange } from '../src/dependencies.ts';
import { analyzeWorkflowPolicy } from '../src/workflow-policy.ts';
import { loadContracts } from '../src/contracts.ts';
import { selectPlatforms, loadPlatformPolicy } from '../src/platforms.ts';

test('local reward-hacking scenarios fail closed with stable diagnostics', async () => {
  const workflow = await readFile(path.resolve('harness-cli/test/fixtures/workflows/inline-pr-expression.yml'), 'utf8');
  assert.ok(analyzeWorkflowPolicy(workflow).some((item) => item.code === 'UNTRUSTED_RUN_INTERPOLATION'));

  const dependency = classifyDependencyChange({ manifest_changed: false, lockfile_changed: false, registry_changed: false, scripts_enabled: true, native_modules_changed: false, network_enabled: false, license_valid: true, sbom_present: true, vulnerability_scan: 'clear' });
  assert.equal(dependency.category, 'privileged-dependency-change');
  assert.equal(dependency.approval_required, true);

  const bundle = await loadContracts(path.resolve('harness'));
  const unknown = classifyChanges(bundle, { changed_files: ['payload.unknown-extension'], operation: 'change', target_environment: 'test' });
  assert.ok(unknown.approvals.includes('engineering'));
  const platforms = await loadPlatformPolicy(path.resolve('harness'));
  const selected = selectPlatforms(platforms, { changed_files: unknown.changed_files, route_ids: unknown.route_ids, operation: unknown.operation });
  assert.deepEqual(selected.expected_platforms, ['darwin', 'linux', 'win32']);
  assert.equal(selected.fallback_full_matrix, true);
});
