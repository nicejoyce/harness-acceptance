import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

import { schemaErrorMessages, schemaValidator } from './schema.ts';

const execFileAsync = promisify(execFile);

export interface TestRunSummary { exit_code: number; tests: number }
export interface TestQualityPolicy {
  version: 1;
  source_binding: 'protected-base';
  changed_test_patterns: string[];
  test_command: { executable: 'npm' | 'node'; args: string[] };
  mutation: { tool: '@stryker-mutator/core'; version: string; smoke_threshold: number; full_schedule: string };
}
export interface RegressionProofInput { base: TestRunSummary; head: TestRunSummary; changed_tests: string[]; source_binding?: string }
export type RegressionProofResult = { valid: true; reason: 'base-failed-head-passed' } | { valid: false; reason: string };

export function evaluateRegressionProof(input: RegressionProofInput): RegressionProofResult {
  if (input.source_binding && input.source_binding !== 'protected-base') return { valid: false, reason: 'untrusted-source-binding' };
  if (input.changed_tests.length === 0) return { valid: false, reason: 'no-changed-tests' };
  if (input.base.tests <= 0 || input.head.tests <= 0) return { valid: false, reason: 'empty-test-run' };
  if (input.base.exit_code === 0) return { valid: false, reason: 'base-did-not-fail' };
  if (input.head.exit_code !== 0) return { valid: false, reason: 'head-did-not-pass' };
  return { valid: true, reason: 'base-failed-head-passed' };
}

export interface RunRegressionProofOptions {
  repository_root: string;
  base: string;
  head: string;
  changed_tests: string[];
  command: { executable: string; args: string[] };
}

function controlledEnvironment(): NodeJS.ProcessEnv {
  const keys = process.platform === 'win32' ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP'] : ['PATH', 'HOME', 'TMPDIR', 'LANG'];
  return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

async function runCommand(root: string, command: RunRegressionProofOptions['command']): Promise<number> {
  return new Promise((resolve) => {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const executable = process.platform === 'win32' && command.executable === 'npm' ? process.execPath : command.executable;
    const args = process.platform === 'win32' && command.executable === 'npm' ? [npmCli, ...command.args] : command.args;
    const child = spawn(executable, args, { cwd: root, env: controlledEnvironment(), shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function checkedPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Changed test path escapes worktree: ${relativePath}`);
  return resolved;
}

export async function runRegressionProof(options: RunRegressionProofOptions): Promise<RegressionProofResult> {
  if (options.changed_tests.length === 0) return { valid: false, reason: 'no-changed-tests' };
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'harness-regression-proof-'));
  const baseRoot = path.join(temporaryRoot, 'base');
  const headRoot = path.join(temporaryRoot, 'head');
  let baseAdded = false;
  let headAdded = false;
  try {
    await execFileAsync('git', ['worktree', 'add', '--detach', baseRoot, options.base], { cwd: options.repository_root, windowsHide: true });
    baseAdded = true;
    await execFileAsync('git', ['worktree', 'add', '--detach', headRoot, options.head], { cwd: options.repository_root, windowsHide: true });
    headAdded = true;
    for (const testPath of options.changed_tests) {
      const source = checkedPath(headRoot, testPath);
      const destination = checkedPath(baseRoot, testPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
    }
    const [baseExit, headExit] = await Promise.all([runCommand(baseRoot, options.command), runCommand(headRoot, options.command)]);
    return evaluateRegressionProof({ base: { exit_code: baseExit, tests: options.changed_tests.length }, head: { exit_code: headExit, tests: options.changed_tests.length }, changed_tests: options.changed_tests, source_binding: 'protected-base' });
  } finally {
    if (baseAdded) await execFileAsync('git', ['worktree', 'remove', '--force', baseRoot], { cwd: options.repository_root, windowsHide: true }).catch(() => undefined);
    if (headAdded) await execFileAsync('git', ['worktree', 'remove', '--force', headRoot], { cwd: options.repository_root, windowsHide: true }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function loadTestQualityPolicy(contractRoot: string): Promise<TestQualityPolicy> {
  const policy = parse(await readFile(path.join(contractRoot, 'contracts/test-quality-policy.yaml'), 'utf8')) as TestQualityPolicy;
  const validate = await schemaValidator('test-quality-policy.schema.json');
  if (!validate(policy)) throw new Error(`Invalid test quality policy: ${schemaErrorMessages(validate.errors).join('; ')}`);
  return policy;
}
