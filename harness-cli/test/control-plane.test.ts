import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse, stringify } from 'yaml';

import { verifyControlPlane } from '../src/control-plane.ts';

const baselineRoot = path.resolve('.');

async function candidateRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-control-plane-'));
  const copies = [
    cp('harness', path.join(root, 'harness'), { recursive: true }),
    cp('harness-zh', path.join(root, 'harness-zh'), { recursive: true }),
    mkdir(path.join(root, '.github'), { recursive: true }).then(() => cp('.github/workflows', path.join(root, '.github/workflows'), { recursive: true })),
    cp('CODEOWNERS', path.join(root, 'CODEOWNERS')),
    cp('harness-cli', path.join(root, 'harness-cli'), { recursive: true }),
    cp('harness-service', path.join(root, 'harness-service'), { recursive: true }),
    cp('scripts', path.join(root, 'scripts'), { recursive: true }),
    cp('package.json', path.join(root, 'package.json')),
    cp('package-lock.json', path.join(root, 'package-lock.json')),
    cp('stryker.config.json', path.join(root, 'stryker.config.json')),
    cp('stryker.full.config.json', path.join(root, 'stryker.full.config.json')),
  ];
  try {
    await lstat('CODEOWNERS.template');
    copies.push(cp('CODEOWNERS.template', path.join(root, 'CODEOWNERS.template')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await Promise.all(copies);
  return root;
}

test('accepts a candidate that preserves all protected control-plane invariants', async () => {
  const result = await verifyControlPlane(baselineRoot, await candidateRepository());
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
});

test('rejects removal of the Harness self-protection route', async () => {
  const candidateRoot = await candidateRepository();
  for (const distribution of ['harness', 'harness-zh']) {
    const routesPath = path.join(candidateRoot, distribution, 'contracts/routes.yaml');
    const routes = parse(await readFile(routesPath, 'utf8')) as { routes: Array<{ id: string }> };
    routes.routes = routes.routes.filter((route) => route.id !== 'route.harness-self');
    await writeFile(routesPath, stringify(routes), 'utf8');
  }
  const result = await verifyControlPlane(baselineRoot, candidateRoot);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.message.includes('route.harness-self')));
});

test('rejects moving the control-plane verifier into the pull request execution root', async () => {
  const candidateRoot = await candidateRepository();
  for (const distribution of ['harness', 'harness-zh']) {
    const profilePath = path.join(candidateRoot, distribution, 'config/project-profile.yaml');
    const profile = parse(await readFile(profilePath, 'utf8')) as { commands: Record<string, Record<string, unknown>> };
    profile.commands['control-plane-integrity'].execution_root = 'project';
    await writeFile(profilePath, stringify(profile), 'utf8');
  }
  const result = await verifyControlPlane(baselineRoot, candidateRoot);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.message.includes('trusted-harness')));
});

test('rejects an exclude that bypasses a protected self-route path', async () => {
  const candidateRoot = await candidateRepository();
  for (const distribution of ['harness', 'harness-zh']) {
    const routesPath = path.join(candidateRoot, distribution, 'contracts/routes.yaml');
    const routes = parse(await readFile(routesPath, 'utf8')) as { routes: Array<Record<string, unknown>> };
    routes.routes.find((route) => route.id === 'route.harness-self')!.exclude = ['harness-cli/**'];
    await writeFile(routesPath, stringify(routes), 'utf8');
  }
  const result = await verifyControlPlane(baselineRoot, candidateRoot);
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.message.includes('exclude')));
});

test('rejects environment injection into the trusted verifier command', async () => {
  const candidateRoot = await candidateRepository();
  for (const distribution of ['harness', 'harness-zh']) {
    const profilePath = path.join(candidateRoot, distribution, 'config/project-profile.yaml');
    const profile = parse(await readFile(profilePath, 'utf8')) as { commands: Record<string, Record<string, unknown>> };
    profile.commands['control-plane-integrity'].environment = { NODE_OPTIONS: '--require=../project/evil.cjs' };
    await writeFile(profilePath, stringify(profile), 'utf8');
  }
  const result = await verifyControlPlane(baselineRoot, candidateRoot);
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.message.includes('descriptor')));
});

test('rejects disabling the trusted workflow trigger or verification step', async () => {
  const candidateRoot = await candidateRepository();
  const workflowPath = path.join(candidateRoot, '.github/workflows/harness.yml');
  const workflow = parse(await readFile(workflowPath, 'utf8')) as Record<string, unknown>;
  workflow.on = { pull_request: {} };
  await writeFile(workflowPath, stringify(workflow), 'utf8');
  const result = await verifyControlPlane(baselineRoot, candidateRoot);
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.document.includes('harness.yml')));
});

test('rejects tampering with the trusted verifier implementation or CODEOWNERS', async () => {
  const candidateRoot = await candidateRepository();
  await writeFile(path.join(candidateRoot, 'harness-cli/src/control-plane.ts'), 'export const bypass = true;\n', 'utf8');
  await writeFile(path.join(candidateRoot, 'CODEOWNERS'), '* @attacker\n', 'utf8');
  const result = await verifyControlPlane(baselineRoot, candidateRoot);
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.document.includes('harness-cli/src/control-plane.ts')));
  assert.ok(result.diagnostics.some((item) => item.code === 'CONTROL_PLANE_DOWNGRADE' && item.document === 'CODEOWNERS'));
});
