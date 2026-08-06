import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlatformPolicy, platformMatrix, selectPlatforms, type PlatformId } from '../src/platforms.ts';

const canonicalRoot = path.resolve('harness');

test('selects Linux by default and adds platform-specific runners', async () => {
  const policy = await loadPlatformPolicy(canonicalRoot);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['src/example.ts'], route_ids: ['route.low-risk'], operation: 'change' }).expected_platforms, ['linux']);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['scripts/install.ps1'], route_ids: ['route.low-risk'], operation: 'change' }).expected_platforms, ['linux', 'win32']);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['src/macos/permissions.ts'], route_ids: ['route.low-risk'], operation: 'change' }).expected_platforms, ['darwin', 'linux']);
});

test('uses the full matrix for control-plane, release, lockfile, unknown, conflict, or missing policy inputs', async () => {
  const policy = await loadPlatformPolicy(canonicalRoot);
  const full = ['darwin', 'linux', 'win32'];
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['harness-cli/src/planner.ts'], route_ids: ['route.harness-self'], operation: 'change' }).expected_platforms, full);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['package-lock.json'], route_ids: ['route.harness-self'], operation: 'change' }).expected_platforms, full);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['stryker.full.config.json'], route_ids: ['route.harness-self'], operation: 'change' }).expected_platforms, full);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['src/example.ts'], route_ids: ['route.low-risk'], operation: 'release' }).expected_platforms, full);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['assets/unknown.weird'], route_ids: ['route.unknown'], operation: 'change' }).expected_platforms, full);
  assert.deepEqual(selectPlatforms(policy, { changed_files: ['src/example.ts'], route_ids: ['route.low-risk'], operation: 'change', classification_conflict: true }).expected_platforms, full);
  assert.deepEqual(selectPlatforms(null, { changed_files: ['src/example.ts'], route_ids: ['route.low-risk'], operation: 'change' }).expected_platforms, full);
});

test('adding changed files never removes a selected platform', async () => {
  const policy = await loadPlatformPolicy(canonicalRoot);
  const files = ['src/example.ts', 'scripts/install.ps1', 'src/macos/permissions.ts', 'package-lock.json'];
  let previous = new Set<PlatformId>();
  for (let length = 1; length <= files.length; length += 1) {
    const selected = new Set(selectPlatforms(policy, { changed_files: files.slice(0, length), route_ids: ['route.low-risk'], operation: 'change' }).expected_platforms);
    for (const platform of previous) assert.ok(selected.has(platform), `${platform} was removed after adding ${files[length - 1]}`);
    previous = selected;
  }
});

test('maps trusted platform IDs to a deterministic GitHub matrix', async () => {
  const policy = await loadPlatformPolicy(canonicalRoot);
  assert.deepEqual(platformMatrix(policy, ['win32', 'linux']), {
    include: [
      { platform: 'linux', runner: 'ubuntu-latest' },
      { platform: 'win32', runner: 'windows-latest' },
    ],
  });
  assert.throws(() => platformMatrix(policy, ['linux', 'linux']), /duplicate/i);
  assert.throws(() => platformMatrix(policy, ['unknown' as 'linux']), /unknown/i);
});

test('rejects a platform policy whose full matrix omits a supported platform', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-platform-policy-'));
  await mkdir(path.join(root, 'contracts'));
  await writeFile(path.join(root, 'contracts/platform-policy.yaml'), JSON.stringify({
    version: 1,
    mode: 'shadow',
    platforms: {
      linux: { runner: 'ubuntu-latest' },
      win32: { runner: 'windows-latest' },
      darwin: { runner: 'macos-latest' },
    },
    baseline_platforms: ['linux'],
    full_matrix: ['linux'],
    full_matrix_operations: ['release'],
    full_matrix_route_ids: ['route.unknown'],
    rules: [],
  }));

  await assert.rejects(loadPlatformPolicy(root), /Platform policy is invalid/);
});
