import { access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('controlled acceptance injection tampers with an evidence log', async () => {
  const logPath = path.resolve(process.cwd(), '..', 'evidence', 'logs', 'gate.setup.log');
  try {
    await access(logPath);
  } catch {
    return;
  }

  await appendFile(logPath, 'controlled evidence tampering\n', 'utf8');
});
