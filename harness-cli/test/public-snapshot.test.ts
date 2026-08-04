import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { exportPublicSnapshot } from '../../scripts/export-public-snapshot.ts';

test('exports only allowlisted files with an injected independent CODEOWNER', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'harness-public-snapshot-'));
  const source = path.join(temp, 'source');
  const output = path.join(temp, 'output');
  await mkdir(path.join(source, '.github/workflows'), { recursive: true });
  await mkdir(path.join(source, 'harness/config'), { recursive: true });
  await mkdir(path.join(source, 'harness/.harness'), { recursive: true });
  await mkdir(path.join(source, 'harness-zh/config'), { recursive: true });
  await mkdir(path.join(source, 'harness-cli/src'), { recursive: true });
  await mkdir(path.join(source, 'fixtures/sample'), { recursive: true });
  await mkdir(path.join(source, 'docs/superpowers'), { recursive: true });
  await Promise.all([
    writeFile(path.join(source, '.gitignore'), '.env\nnode_modules/\n'),
    writeFile(path.join(source, 'package.json'), '{}\n'),
    writeFile(path.join(source, 'CODEOWNERS.template'), '/harness/ @nicejoyce @{{ACCEPTANCE_REVIEWER_LOGIN}}\n'),
    writeFile(path.join(source, '.github/workflows/harness.yml'), 'name: Harness\n'),
    writeFile(path.join(source, 'harness/README.md'), '# Harness\n'),
    writeFile(path.join(source, 'harness/config/project-profile.yaml'), 'version: 1\napprovals:\n  roles:\n    engineering: [nicejoyce]\n    security: [nicejoyce]\n'),
    writeFile(path.join(source, 'harness-zh/config/project-profile.yaml'), 'version: 1\napprovals:\n  roles:\n    engineering: [nicejoyce]\n    security: [nicejoyce]\n'),
    writeFile(path.join(source, 'harness/debug.log'), 'sensitive log\n'),
    writeFile(path.join(source, 'harness/.harness/manifest.json'), '{}\n'),
    writeFile(path.join(source, 'harness/private.pem'), 'private key\n'),
    writeFile(path.join(source, 'harness/config.local.json'), '{"local":true}\n'),
    writeFile(path.join(source, 'harness-cli/src/index.ts'), 'export {};\n'),
    writeFile(path.join(source, 'fixtures/sample/input.txt'), 'fixture\n'),
    writeFile(path.join(source, 'docs/superpowers/private.md'), 'private plan\n'),
    writeFile(path.join(source, '.env'), 'TOKEN=secret\n'),
  ]);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: source, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  assert.equal(git('add', '.gitignore', 'package.json', 'CODEOWNERS.template', '.github', 'harness', 'harness-zh', 'harness-cli', 'docs').status, 0);

  const result = await exportPublicSnapshot({ source_root: source, output_root: output, reviewer_login: 'independent-reviewer' });

  assert.ok(result.files.includes('fixtures/sample/input.txt'), 'untracked allowlisted fixtures are exported');
  assert.equal(await readFile(path.join(output, 'CODEOWNERS'), 'utf8'), '/harness/ @nicejoyce @independent-reviewer\n');
  assert.equal(await readFile(path.join(output, 'CODEOWNERS.template'), 'utf8'), '/harness/ @nicejoyce @{{ACCEPTANCE_REVIEWER_LOGIN}}\n');
  assert.equal(await readFile(path.join(output, 'harness/README.md'), 'utf8'), '# Harness\n');
  for (const root of ['harness', 'harness-zh']) {
    const profile = YAML.parse(await readFile(path.join(output, root, 'config/project-profile.yaml'), 'utf8')) as { approvals: { roles: Record<string, string[]> } };
    for (const identities of Object.values(profile.approvals.roles)) assert.deepEqual(identities, ['independent-reviewer']);
  }
  await assert.rejects(readFile(path.join(output, '.env'), 'utf8'));
  await assert.rejects(readFile(path.join(output, 'docs/superpowers/private.md'), 'utf8'));
  await assert.rejects(readFile(path.join(output, 'harness/debug.log'), 'utf8'));
  await assert.rejects(readFile(path.join(output, 'harness/.harness/manifest.json'), 'utf8'));
  await assert.rejects(readFile(path.join(output, 'harness/private.pem'), 'utf8'));
  await assert.rejects(readFile(path.join(output, 'harness/config.local.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(output, 'public-snapshot-manifest.json'), 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  assert.ok(manifest.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('rejects unsafe reviewer logins and output paths inside the source repository', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'harness-public-snapshot-invalid-'));
  await assert.rejects(exportPublicSnapshot({ source_root: source, output_root: path.join(source, 'public'), reviewer_login: 'bad login' }), /reviewer login/);
});
