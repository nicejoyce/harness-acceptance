import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export interface PublicSnapshotOptions {
  source_root: string;
  output_root: string;
  reviewer_login: string;
}

export interface PublicSnapshotResult {
  output_root: string;
  files: string[];
}

const allowedFiles = new Set([
  '.gitignore',
  '.github/workflows/harness.yml',
  'CODEOWNERS.template',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
]);
const allowedRoots = ['harness/', 'harness-zh/', 'harness-cli/', 'fixtures/', 'docs/acceptance/', 'scripts/'];

function normalized(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function allowed(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const basename = segments.at(-1) ?? '';
  const deniedSegment = segments.some((segment) => ['.git', '.harness', '.superpowers', '.cache', 'node_modules', 'coverage', 'dist', 'evidence', 'logs'].includes(segment.toLowerCase()));
  const deniedFile = basename.toLowerCase().startsWith('.env')
    || /\.(?:log|pem|key|p12|pfx)$/i.test(basename)
    || /\.local(?:\.|$)/i.test(basename)
    || basename.toLowerCase() === 'nul';
  return !deniedSegment && !deniedFile && (allowedFiles.has(relativePath) || allowedRoots.some((root) => relativePath.startsWith(root)));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function validateReviewerLogin(login: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login) || login.includes('--')) throw new Error('Invalid GitHub reviewer login');
}

function renderApprovalRoles(content: Buffer, reviewerLogin: string, relativePath: string): Buffer {
  const profile = YAML.parse(content.toString('utf8')) as { approvals?: { roles?: unknown } };
  const roles = profile?.approvals?.roles;
  if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) throw new Error(`Public snapshot profile has invalid approval roles: ${relativePath}`);
  for (const role of Object.keys(roles)) (roles as Record<string, string[]>)[role] = [reviewerLogin];
  return Buffer.from(YAML.stringify(profile, { lineWidth: 0 }));
}

export async function exportPublicSnapshot(options: PublicSnapshotOptions): Promise<PublicSnapshotResult> {
  validateReviewerLogin(options.reviewer_login);
  const sourceRoot = path.resolve(options.source_root);
  const outputRoot = path.resolve(options.output_root);
  if (inside(sourceRoot, outputRoot)) throw new Error('Public snapshot output must be outside the source repository');

  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: sourceRoot, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`Unable to enumerate public snapshot files: ${listed.stderr.trim()}`);
  const candidates = listed.stdout.split('\0').filter(Boolean).map(normalized).filter(allowed).sort();
  if (!candidates.includes('CODEOWNERS.template')) throw new Error('CODEOWNERS.template is required for a public snapshot');

  await mkdir(path.dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot);
  const manifestFiles: Array<{ path: string; sha256: string }> = [];
  const exported: string[] = [];

  for (const relativePath of candidates) {
    const sourcePath = path.resolve(sourceRoot, relativePath);
    if (!inside(sourceRoot, sourcePath)) throw new Error(`Snapshot path escapes the source repository: ${relativePath}`);
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Snapshot candidate must be a regular file: ${relativePath}`);
    const outputPath = relativePath === 'CODEOWNERS.template' ? 'CODEOWNERS' : relativePath;
    let content = await readFile(sourcePath);
    if (relativePath === 'CODEOWNERS.template') {
      const rendered = content.toString('utf8').replaceAll('{{ACCEPTANCE_REVIEWER_LOGIN}}', options.reviewer_login);
      if (rendered.includes('{{')) throw new Error('CODEOWNERS template contains an unresolved placeholder');
      content = Buffer.from(rendered);
    } else if (['harness/config/project-profile.yaml', 'harness-zh/config/project-profile.yaml'].includes(relativePath)) {
      content = renderApprovalRoles(content, options.reviewer_login, relativePath);
    }
    const destination = path.resolve(outputRoot, outputPath);
    if (!inside(outputRoot, destination)) throw new Error(`Snapshot path escapes the output directory: ${outputPath}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
    exported.push(outputPath);
    manifestFiles.push({ path: outputPath, sha256: sha256(content) });
  }

  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(path.join(outputRoot, 'public-snapshot-manifest.json'), `${JSON.stringify({ version: 1, files: manifestFiles }, null, 2)}\n`, 'utf8');
  return { output_root: outputRoot, files: exported.sort() };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = argument('--output');
  const reviewer = argument('--reviewer');
  if (!output || !reviewer) throw new Error('Usage: node scripts/export-public-snapshot.ts --output <external-directory> --reviewer <github-login> [--source <repository>]');
  exportPublicSnapshot({ source_root: argument('--source') ?? process.cwd(), output_root: output, reviewer_login: reviewer })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
