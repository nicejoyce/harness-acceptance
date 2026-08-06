import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';
import type { Diagnostic } from './diagnostics.ts';

type UnknownRecord = Record<string, unknown>;

interface WorkflowDocument extends UnknownRecord {
  env?: unknown;
  jobs?: Record<string, UnknownRecord>;
  on?: unknown;
}

const untrustedExpression = /\$\{\{[\s\S]*?github\s*\.\s*(?:head_ref\b|event\s*(?:\.\s*pull_request\b|\[\s*['"]pull_request['"]\s*\]))[\s\S]*?\}\}/i;
const sensitiveExpression = /\$\{\{[\s\S]*?(?:secrets\s*[.[]|github\s*\.\s*token\b)[\s\S]*?\}\}/i;
const projectRoot = String.raw`(?:\.?[\\/])?project(?:[\\/]|$)`;
const directProjectExecution = new RegExp(String.raw`(?:^|\n)\s*(?:&\s*)?["']?${projectRoot}`, 'im');
const projectEntrypointExecution = new RegExp(String.raw`(?:^|\n)\s*(?:node|npx|python|python3|bash|sh|pwsh|powershell)\s+(?:(?:--?[A-Za-z][A-Za-z-]*)(?:=\S+)?\s+)*["']?${projectRoot}`, 'im');
const projectPackageExecution = new RegExp(String.raw`(?:^|\n)\s*(?:npm|pnpm|yarn)\b[^\n]*?(?:--prefix|--cwd)\s+["']?${projectRoot}`, 'im');
const projectShellExecution = new RegExp(String.raw`(?:^|\n)\s*(?:source|\.)\s+["']?${projectRoot}`, 'im');
const interpreterSink = /(?:^|[\n;&|]\s*)(?:eval|source|\.)\s+|\b(?:bash|sh)\s+-c\b|\bnode\s+(?:-e|--eval)\b|\b(?:pwsh|powershell)\s+(?:-c|-command)\b/im;
const interpreterInput = /\b(?:bash|sh|node|python|python3|pwsh|powershell)\b[^\n]*(?:<|\$\()/i;
const projectPath = new RegExp(projectRoot, 'i');
const executionSelectingJobFields = ['runs-on', 'container', 'services', 'if', 'strategy', 'defaults', 'concurrency', 'environment', 'uses', 'with'] as const;
const executionSelectingStepFields = ['uses', 'shell', 'working-directory', 'if', 'with', 'timeout-minutes', 'continue-on-error'] as const;

function diagnostic(code: Diagnostic['code'], pathValue: string, message: string, document = 'workflow'): Diagnostic {
  return { code, document, path: pathValue, message };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsMatchingString(value: unknown, pattern: RegExp): boolean {
  if (typeof value === 'string') return pattern.test(value);
  if (Array.isArray(value)) return value.some((item) => containsMatchingString(item, pattern));
  if (isRecord(value)) return Object.values(value).some((item) => containsMatchingString(item, pattern));
  return false;
}

function containsUntrustedExpression(value: unknown): boolean {
  return containsMatchingString(value, untrustedExpression);
}

function isPullRequestTarget(on: unknown): boolean {
  if (on === 'pull_request_target') return true;
  if (Array.isArray(on)) return on.includes('pull_request_target');
  return isRecord(on) && Object.hasOwn(on, 'pull_request_target');
}

function isTrustedJob(job: UnknownRecord, workflow: WorkflowDocument): boolean {
  const permissions = job.permissions;
  const explicitlyUnprivileged = isRecord(permissions) && Object.keys(permissions).length === 0;
  return !explicitlyUnprivileged
    || containsMatchingString(job, sensitiveExpression)
    || containsMatchingString(workflow.env, sensitiveExpression);
}

function appendSelectorDiagnostics(diagnostics: Diagnostic[], value: unknown, pathValue: string): void {
  if (typeof value === 'string') {
    if (containsUntrustedExpression(value)) {
      diagnostics.push(diagnostic('PR_DATA_SELECTS_EXECUTION', pathValue, 'Pull request data selects trusted workflow execution behavior'));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendSelectorDiagnostics(diagnostics, item, `${pathValue}/${index}`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) appendSelectorDiagnostics(diagnostics, item, `${pathValue}/${key}`);
  }
}

function envEntries(...values: unknown[]): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const [key, item] of Object.entries(value)) entries.set(key, item);
  }
  return entries;
}

function referencesEnv(run: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`(?:\$${escaped}\b|\$\{${escaped}\}|\$env:${escaped}\b|%${escaped}%)`, 'i').test(run);
}

function executesEnvAsCommand(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`^\s*(?:&\s*)?["']?(?:\$${escaped}\b|\$\{${escaped}\}|\$env:${escaped}\b|%${escaped}%)`, 'i').test(line);
}

function taintedDataReachesInterpreter(run: string, taintedVariables: string[]): boolean {
  const logicalLines = run.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  return logicalLines.some((line) => taintedVariables.some((name) => referencesEnv(line, name)
    && (interpreterSink.test(line) || executesEnvAsCommand(line, name))));
}

function projectDataReachesInterpreter(run: string): boolean {
  const logicalLines = run.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  return logicalLines.some((line) => projectPath.test(line) && (interpreterSink.test(line) || interpreterInput.test(line)));
}

function safeCheckoutWith(step: UnknownRecord): UnknownRecord | null {
  if (typeof step.uses !== 'string' || !/^actions\/checkout@[^\s]+$/i.test(step.uses) || !isRecord(step.with)) return null;
  const checkoutPath = step.with.path;
  const persistCredentials = step.with['persist-credentials'];
  const ref = step.with.ref;
  const safePath = checkoutPath === 'project' || checkoutPath === 'trusted-harness';
  const safeCredentials = persistCredentials === false || persistCredentials === 'false';
  const safeRef = typeof ref === 'string'
    && /^\$\{\{\s*github\.event\.pull_request\.(?:base|head)\.sha\s*\}\}$/.test(ref);
  if (!safePath || !safeCredentials || !safeRef) return null;
  const { ref: _ref, ...remaining } = step.with;
  return remaining;
}

function executesProjectCheckout(step: UnknownRecord): boolean {
  if (typeof step['working-directory'] === 'string' && new RegExp(`^${projectRoot}`, 'i').test(step['working-directory'])) return true;
  if (typeof step.uses === 'string' && new RegExp(`^${projectRoot}`, 'i').test(step.uses)) return true;
  if (typeof step.run !== 'string') return false;
  return directProjectExecution.test(step.run)
    || projectEntrypointExecution.test(step.run)
    || projectPackageExecution.test(step.run)
    || projectShellExecution.test(step.run)
    || projectDataReachesInterpreter(step.run);
}

export function analyzeWorkflowPolicy(source: string): Diagnostic[] {
  let workflow: WorkflowDocument;
  try {
    workflow = parse(source) as WorkflowDocument;
  } catch (error) {
    return [diagnostic('YAML_INVALID', '/', error instanceof Error ? error.message : 'Invalid workflow YAML')];
  }
  if (!isRecord(workflow) || !isPullRequestTarget(workflow.on)) return [];

  const diagnostics: Diagnostic[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (!isRecord(job) || !isTrustedJob(job, workflow)) continue;
    const jobPath = `/jobs/${jobId}`;
    for (const field of executionSelectingJobFields) appendSelectorDiagnostics(diagnostics, job[field], `${jobPath}/${field}`);

    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((value, index) => {
      if (!isRecord(value)) return;
      const stepPath = `${jobPath}/steps/${index}`;
      if (containsUntrustedExpression(value.run)) {
        diagnostics.push(diagnostic('UNTRUSTED_RUN_INTERPOLATION', `${stepPath}/run`, 'Pull request data must enter trusted scripts through a validated environment variable'));
      }
      for (const field of executionSelectingStepFields) {
        const selectorValue = field === 'with' ? (safeCheckoutWith(value) ?? value[field]) : value[field];
        appendSelectorDiagnostics(diagnostics, selectorValue, `${stepPath}/${field}`);
      }
      if (executesProjectCheckout(value)) {
        diagnostics.push(diagnostic('TRUSTED_JOB_EXECUTES_PR', stepPath, 'Trusted jobs must not execute commands or actions from the pull request checkout'));
      }
      if (typeof value.run === 'string') {
        const taintedVariables = [...envEntries(workflow.env, job.env, value.env)]
          .filter(([, envValue]) => containsUntrustedExpression(envValue))
          .map(([name]) => name);
        if (taintedDataReachesInterpreter(value.run, taintedVariables)) {
          diagnostics.push(diagnostic('PR_DATA_SELECTS_EXECUTION', `${stepPath}/run`, 'Pull request data reaches a command interpreter through an environment variable'));
        }
      }
    });
  }
  return diagnostics;
}

export async function listWorkflowFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

function relativeWorkflowPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export async function analyzeWorkflowPolicyRoots(workflowRoot: string, baselineWorkflowRoot?: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const headFiles = await listWorkflowFiles(workflowRoot);
  const headPaths = new Set(headFiles.map((file) => relativeWorkflowPath(workflowRoot, file)));
  for (const file of headFiles) {
    const relative = relativeWorkflowPath(workflowRoot, file);
    diagnostics.push(...analyzeWorkflowPolicy(await readFile(file, 'utf8')).map((item) => ({ ...item, document: relative })));
  }
  if (baselineWorkflowRoot) {
    for (const file of await listWorkflowFiles(baselineWorkflowRoot)) {
      const relative = relativeWorkflowPath(baselineWorkflowRoot, file);
      if (!headPaths.has(relative)) diagnostics.push(diagnostic('TRUSTED_WORKFLOW_REMOVED', '/', 'Workflow present in the trusted baseline is missing from the pull request checkout', relative));
    }
  }
  return diagnostics;
}
