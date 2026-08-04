import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { terminateProcessTree } from '../src/process-tree.ts';

test('terminates descendants before they can continue modifying files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-process-tree-'));
  const marker = path.join(root, 'descendant-survived.txt');
  const trigger = path.join(root, 'allow-descendant-write');
  const descendant = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(marker)}, 'survived'); }, 20)`;
  const parentScript = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); console.log(child.pid); setInterval(() => {}, 1000)`;
  const parent = spawn(process.execPath, ['-e', parentScript], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  assert.ok(parent.pid);
  const [data] = await once(parent.stdout!, 'data') as [Buffer];
  const descendantPid = Number(data.toString().trim());
  try {
    await terminateProcessTree(parent.pid!, 200);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(trigger, 'trigger'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(() => access(marker));
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
    try { parent.kill('SIGKILL'); } catch {}
  }
});
