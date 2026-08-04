import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('controlled acceptance injection changes the evidence plan context', async () => {
  const planPath = path.resolve(process.cwd(), '..', 'evidence', 'plan.json');
  try {
    await access(planPath);
  } catch {
    return;
  }

  const plan = JSON.parse(await readFile(planPath, 'utf8')) as { context: { head_sha: string } };
  plan.context.head_sha = '0'.repeat(40);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
});
