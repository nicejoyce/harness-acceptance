import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export class GitPlanContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitPlanContextError';
  }
}

function assertRevision(revision: string): void {
  if (revision.length === 0 || revision.startsWith('-') || /[\0\r\n]/.test(revision)) throw new Error('Invalid Git revision');
}

export async function changedFilesFromGit(root: string, base: string, head: string): Promise<string[]> {
  assertRevision(base);
  assertRevision(head);
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--no-renames', '--diff-filter=ACMRD', base, head, '--'], { cwd: root, windowsHide: true });
  return [...new Set(stdout.split(/\r?\n/).filter(Boolean).map((file) => file.replaceAll('\\', '/')))].sort();
}

export async function gitRepositoryRoot(start: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', path.resolve(start), 'rev-parse', '--show-toplevel'], { windowsHide: true });
  return path.resolve(stdout.trim());
}

export async function resolveGitRevision(root: string, revision = 'HEAD'): Promise<string> {
  assertRevision(revision);
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, windowsHide: true });
  return stdout.trim().toLowerCase();
}

export async function assertGitWorktreeClean(root: string): Promise<void> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], { cwd: root, windowsHide: true });
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > 0) {
    const sample = entries.slice(0, 10).join(', ');
    throw new GitPlanContextError(`Git execution checkout must be clean; tracked, untracked, or ignored files were found: ${sample}`);
  }
}

export async function assertGitPlanContext(root: string, baseRevision: string, headRevision: string, changedFiles: string[]): Promise<void> {
  try {
    const [base, head, actualHead, actualFiles] = await Promise.all([
      resolveGitRevision(root, baseRevision),
      resolveGitRevision(root, headRevision),
      resolveGitRevision(root, 'HEAD'),
      changedFilesFromGit(root, baseRevision, headRevision),
    ]);
    if (head !== actualHead) throw new GitPlanContextError(`Plan source revision ${head} does not match repository HEAD ${actualHead}`);
    if (base === head) throw new GitPlanContextError('Plan base and head revisions must differ');
    if (actualFiles.length === 0) throw new GitPlanContextError('Git diff contains no changed files');
    const normalized = [...new Set(changedFiles.map((file) => file.replaceAll('\\', '/')))].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(actualFiles)) throw new GitPlanContextError('Plan changed files do not match the declared Git diff');
  } catch (error) {
    if (error instanceof GitPlanContextError) throw error;
    const message = error instanceof Error && error.message ? error.message : 'Git plan context validation failed';
    throw new GitPlanContextError(message);
  }
  await assertGitWorktreeClean(root);
}
