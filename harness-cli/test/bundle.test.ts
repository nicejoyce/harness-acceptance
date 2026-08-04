import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

test('bundle bootstrap remains self-contained after source temporary refs are removed', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'harness-bundle-source-'));
  const work = await mkdtemp(path.join(tmpdir(), 'harness-bundle-work-'));
  const bundle = path.join(work, 'project.bundle');
  const clone = path.join(work, 'clone');
  const baseRef = 'refs/heads/harness-bundle-base';
  const headRef = 'refs/heads/harness-bundle-head';

  try {
    await git(source, ['init', '--initial-branch=main']);
    await git(source, ['config', 'user.email', 'harness@example.test']);
    await git(source, ['config', 'user.name', 'Harness Test']);
    await writeFile(path.join(source, 'base.txt'), 'base\n');
    await git(source, ['add', 'base.txt']);
    await git(source, ['commit', '-m', 'base']);
    const baseSha = await git(source, ['rev-parse', 'HEAD']);
    await writeFile(path.join(source, 'head.txt'), 'head\n');
    await git(source, ['add', 'head.txt']);
    await git(source, ['commit', '-m', 'head']);
    const headSha = await git(source, ['rev-parse', 'HEAD']);

    await git(source, ['update-ref', baseRef, baseSha]);
    await git(source, ['update-ref', headRef, headSha]);
    await git(source, ['bundle', 'create', bundle, baseRef, headRef]);
    await git(source, ['bundle', 'verify', bundle]);
    const advertisedRefs = (await git(source, ['bundle', 'list-heads', bundle])).split('\n').sort();
    assert.deepEqual(advertisedRefs, [`${baseSha} ${baseRef}`, `${headSha} ${headRef}`].sort());

    await git(source, ['update-ref', '-d', baseRef]);
    await git(source, ['update-ref', '-d', headRef]);
    await assert.rejects(git(source, ['show-ref', '--verify', '--quiet', baseRef]));
    await assert.rejects(git(source, ['show-ref', '--verify', '--quiet', headRef]));

    await git(work, ['clone', '--no-checkout', bundle, clone]);
    await git(clone, ['checkout', '--detach', headSha]);
    assert.equal(await git(clone, ['rev-parse', '--verify', `${baseSha}^{commit}`]), baseSha);
    assert.equal(await git(clone, ['rev-parse', '--verify', `${headSha}^{commit}`]), headSha);
  } finally {
    await rm(source, { force: true, recursive: true });
    await rm(work, { force: true, recursive: true });
  }
});
