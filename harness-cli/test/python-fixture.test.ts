import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyChanges } from '../src/classifier.ts';
import { loadContracts, validateContracts } from '../src/contracts.ts';
import { verifyEvidence } from '../src/evidence.ts';
import { createPlan } from '../src/planner.ts';
import { runPlan } from '../src/runner.ts';

const fixtureRoot = path.resolve('fixtures/python-project');
const python = [process.env.PYTHON, 'python', 'python3'].filter((item): item is string => Boolean(item)).find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0);

test('Python fixture binds dependency preparation and tests without Node project commands', async () => {
  const validation = await validateContracts(fixtureRoot);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const bundle = await loadContracts(fixtureRoot);
  assert.equal(bundle.profile.commands['dependency-setup']?.executable, 'python');
  assert.equal(bundle.profile.commands['unit-test']?.executable, 'python');
  assert.equal(Object.values(bundle.profile.commands).some((command) => /^(node|npm|npx)$/i.test(command.executable)), false);
  const plan = await createPlan(bundle, classifyChanges(bundle, { changed_files: ['src/calculator.py'], operation: 'merge', target_environment: 'test' }), []);
  assert.deepEqual(plan.gates.map((gate) => gate.id), ['gate.setup', 'gate.unit-test']);
});

test('Python fixture completes plan, run, and evidence verification', { skip: python ? false : 'Python interpreter is unavailable in this local environment' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-python-project-'));
  await cp(fixtureRoot, root, { recursive: true });
  if (python !== 'python') {
    const profilePath = path.join(root, 'config/project-profile.yaml');
    await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replaceAll('executable: python', `executable: '${python!.replaceAll("'", "''")}'`));
  }
  const bundle = await loadContracts(root);
  const plan = await createPlan(bundle, classifyChanges(bundle, { changed_files: ['src/calculator.py'], operation: 'merge', target_environment: 'test' }), []);
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'harness-python-evidence-'));
  const manifest = await runPlan(bundle, plan, { output_dir: evidenceRoot, project_root: root });
  assert.equal(manifest.result, 'passed');
  assert.equal((await verifyEvidence(root, path.join(evidenceRoot, 'manifest.json'), root)).valid, true);
});
