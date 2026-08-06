import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../src/hash.ts';
import { loadWorkflowSecurityTools, runWorkflowAuditors, type WorkflowSecurityTools } from '../src/workflow-auditors.ts';

const canonicalConfig = path.resolve('harness-cli/config/workflow-security-tools.json');

test('canonical workflow security tools are immutable and checksum pinned', async () => {
  const config = await loadWorkflowSecurityTools(canonicalConfig);
  assert.equal(config.version, 1);
  assert.equal(config.platform, 'linux-x64');
  assert.equal(config.tools.zizmor.version, '1.29.0');
  assert.equal(config.tools.actionlint.version, '1.7.12');
  for (const tool of Object.values(config.tools)) {
    assert.match(tool.url, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/v/);
    assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    assert.match(tool.binary, /^[a-z0-9-]+$/);
  }
  for (const action of Object.values(config.actions)) {
    assert.match(action.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
    assert.match(action.version, /^v[0-9]+/);
  }
});

test('auditor downloads are verified before extraction or execution', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'workflow-auditors-bad-'));
  const trustedArchive = Buffer.from('trusted first archive');
  const expectedSecondArchive = Buffer.from('expected second archive');
  const config = await loadWorkflowSecurityTools(canonicalConfig);
  config.tools.actionlint.sha256 = sha256(trustedArchive);
  config.tools.zizmor.sha256 = sha256(expectedSecondArchive);
  const executed: Array<{ command: string; args: string[] }> = [];

  await assert.rejects(
    runWorkflowAuditors(config, ['project/.github/workflows/harness.yml'], toolsDir, {
      download: async (url) => url.includes('actionlint') ? trustedArchive : Buffer.from('tampered second archive'),
      execute: async (command, args) => { executed.push({ command, args }); },
    }),
    /SHA-256 mismatch/,
  );
  assert.deepEqual(executed, []);
});

test('auditors run fixed offline commands over explicit workflow files', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'workflow-auditors-ok-'));
  const archive = Buffer.from('trusted archive fixture');
  const base = await loadWorkflowSecurityTools(canonicalConfig);
  const config: WorkflowSecurityTools = {
    ...base,
    tools: Object.fromEntries(Object.entries(base.tools).map(([name, tool]) => [name, { ...tool, sha256: sha256(archive) }])) as WorkflowSecurityTools['tools'],
  };
  const executed: Array<{ command: string; args: string[] }> = [];
  const files = ['project/.github/workflows/a.yml', 'project/.github/workflows/b.yaml'];

  await runWorkflowAuditors(config, files, toolsDir, {
    download: async () => archive,
    execute: async (command, args) => { executed.push({ command, args }); },
  });

  assert.equal(executed.filter((item) => item.command === 'tar').length, 2);
  assert.deepEqual(executed.at(-2)?.args, ['-shellcheck=', '-pyflakes=', ...files]);
  assert.deepEqual(executed.at(-1)?.args, ['--offline', '--strict-collection', '--persona=regular', '--no-config', '--no-ignores', '--no-progress', '--color=never', ...files]);
});

test('tool configuration rejects mutable action references', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'workflow-tools-config-'));
  const config = JSON.parse(await readFile(canonicalConfig, 'utf8')) as WorkflowSecurityTools;
  config.actions.checkout.uses = 'actions/checkout@v4';
  const configPath = path.join(tempRoot, 'tools.json');
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(loadWorkflowSecurityTools(configPath), /immutable action reference/);
});
