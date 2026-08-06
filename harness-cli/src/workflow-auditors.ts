import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from './hash.ts';

interface WorkflowToolPin {
  version: string;
  url: string;
  sha256: string;
  binary: string;
}

interface WorkflowActionPin {
  version: string;
  uses: string;
}

export interface WorkflowSecurityTools {
  version: 1;
  platform: 'linux-x64';
  tools: Record<'actionlint' | 'zizmor', WorkflowToolPin>;
  actions: Record<'checkout' | 'setup-node' | 'upload-artifact' | 'download-artifact' | 'harden-runner', WorkflowActionPin>;
}

interface WorkflowAuditorDependencies {
  download(url: string): Promise<Buffer>;
  execute(command: string, args: string[]): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} must contain exactly: ${wanted.join(', ')}`);
}

export async function loadWorkflowSecurityTools(configPath: string): Promise<WorkflowSecurityTools> {
  const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.platform !== 'linux-x64' || !isRecord(parsed.tools) || !isRecord(parsed.actions)) {
    throw new Error('Invalid workflow security tools configuration');
  }
  assertExactKeys(parsed.tools, ['actionlint', 'zizmor'], 'tools');
  assertExactKeys(parsed.actions, ['checkout', 'setup-node', 'upload-artifact', 'download-artifact', 'harden-runner'], 'actions');
  for (const [name, value] of Object.entries(parsed.tools)) {
    if (!isRecord(value)
      || typeof value.version !== 'string'
      || typeof value.url !== 'string'
      || !value.url.startsWith('https://github.com/')
      || !value.url.includes(`/download/v${value.version}/`)
      || typeof value.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.binary !== 'string'
      || !/^[a-z0-9-]+$/.test(value.binary)) throw new Error(`Invalid immutable tool pin: ${name}`);
  }
  for (const [name, value] of Object.entries(parsed.actions)) {
    if (!isRecord(value)
      || typeof value.version !== 'string'
      || !/^v[0-9]+/.test(value.version)
      || typeof value.uses !== 'string'
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(value.uses)) throw new Error(`Invalid immutable action reference: ${name}`);
  }
  return parsed as unknown as WorkflowSecurityTools;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Workflow auditor download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function execute(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

const defaultDependencies: WorkflowAuditorDependencies = { download, execute };

export async function runWorkflowAuditors(
  config: WorkflowSecurityTools,
  workflowFiles: string[],
  toolsDir: string,
  dependencies: WorkflowAuditorDependencies = defaultDependencies,
): Promise<void> {
  if ((process.platform !== 'linux' || process.arch !== 'x64') && dependencies === defaultDependencies) throw new Error('Pinned workflow auditors support linux-x64 runners only');
  if (workflowFiles.length === 0) throw new Error('No workflow files were provided to external auditors');
  await mkdir(toolsDir, { recursive: true });

  const archives = new Map<string, { tool: WorkflowToolPin; archivePath: string; toolDir: string }>();
  for (const [name, tool] of Object.entries(config.tools)) {
    const archivePath = path.join(toolsDir, `${name}-${tool.version}.tar.gz`);
    const archive = await dependencies.download(tool.url);
    if (sha256(archive) !== tool.sha256) throw new Error(`${name} archive SHA-256 mismatch`);
    await writeFile(archivePath, archive);
    archives.set(name, { tool, archivePath, toolDir: path.join(toolsDir, name) });
  }

  const binaries = new Map<string, string>();
  for (const [name, { tool, archivePath, toolDir }] of archives) {
    await mkdir(toolDir, { recursive: true });
    await dependencies.execute('tar', ['-xzf', archivePath, '-C', toolDir]);
    binaries.set(name, path.join(toolDir, tool.binary));
  }

  const files = [...workflowFiles].sort((left, right) => left.localeCompare(right));
  await dependencies.execute(binaries.get('actionlint')!, ['-shellcheck=', '-pyflakes=', ...files]);
  await dependencies.execute(binaries.get('zizmor')!, ['--offline', '--strict-collection', '--persona=regular', '--no-config', '--no-ignores', '--no-progress', '--color=never', ...files]);
}
