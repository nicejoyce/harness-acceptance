import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { finalizeManifest } from './evidence.ts';
import { contractsDigest, sha256, stableJson } from './hash.ts';
import { redact } from './redaction.ts';
import { PlanningError, verifyPlan } from './planner.ts';
import { approvalForGate, approvalsForRole, validateApprovals } from './approvals.ts';
import { assertGitPlanContext, canonicalPath, gitRepositoryRoot, pathsReferToSameLocation } from './git.ts';
import { executionContextFromParts, executionContextsEqual } from './context.ts';
import { terminateProcessTree } from './process-tree.ts';
import type { ApprovalRecord, CiProvenance, CommandDescriptor, ContractBundle, EvidenceManifest, ExceptionRecord, ExecutionPlan, GateEvidence, GateState, PlannedGate } from './types.ts';

export interface RunOptions {
  output_dir: string;
  project_root?: string;
  signal?: AbortSignal;
  exceptions?: ExceptionRecord[];
  approvals?: ApprovalRecord[];
  repository?: string;
  pull_request?: number;
  base_sha?: string;
  head_sha?: string;
  ci_provenance?: CiProvenance;
}

async function repositoryRoot(bundle: ContractBundle, projectRoot?: string): Promise<string> {
  if (projectRoot) return canonicalPath(projectRoot);
  try {
    return await gitRepositoryRoot(bundle.root);
  } catch {
    return canonicalPath(bundle.root);
  }
}

function resolveWorkingDirectory(root: string, cwd: string): string {
  const candidate = path.resolve(root, cwd);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Command cwd escapes repository root: ${cwd}`);
  return candidate;
}

function controlledEnvironment(command: CommandDescriptor): NodeJS.ProcessEnv {
  const keys = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG'];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key] !== undefined) environment[key] = process.env[key];
  for (const key of command.inherited_environment ?? []) if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, command.environment ?? {});
  return environment;
}

function commandSecrets(command: CommandDescriptor): string[] {
  return (command.sensitive_environment ?? []).map((key) => command.environment?.[key] ?? (command.inherited_environment?.includes(key) ? process.env[key] : undefined)).filter((value): value is string => value !== undefined);
}

async function executeGate(root: string, gate: PlannedGate, command: CommandDescriptor, outputDir: string, signal?: AbortSignal): Promise<GateEvidence> {
  const started = new Date();
  const chunks: Buffer[] = [];
  let state: GateState = 'failed';
  let exitCode: number | null = null;
  let timedOut = false;

  let executable = command.executable;
  let args = command.args;
  if (process.platform === 'win32' && (command.executable.toLowerCase() === 'npm' || command.executable.toLowerCase() === 'npx')) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command.executable.toLowerCase()}-cli.js`);
    await access(cli);
    executable = process.execPath;
    args = [cli, ...command.args];
  }

  await new Promise<void>((resolve) => {
    const child = spawn(executable, args, {
      cwd: resolveWorkingDirectory(root, command.cwd),
      env: controlledEnvironment(command),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) void terminateProcessTree(child.pid);
    }, command.timeout_seconds * 1000);
    const abort = () => { if (child.pid) void terminateProcessTree(child.pid); };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => chunks.push(Buffer.from(`${error.name}: ${error.message}\n`)));
    child.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      exitCode = code;
      state = timedOut ? 'timed_out' : signal?.aborted ? 'cancelled' : code === 0 ? 'passed' : 'failed';
      resolve();
    });
  });

  const ended = new Date();
  const safeGateId = gate.id.replace(/[^a-zA-Z0-9.-]/g, '_');
  const logPath = path.join('logs', `${safeGateId}.log`).replaceAll('\\', '/');
  const log = redact(Buffer.concat(chunks).toString('utf8'), commandSecrets(command));
  await mkdir(path.join(outputDir, 'logs'), { recursive: true });
  await writeFile(path.join(outputDir, logPath), log, 'utf8');

  return {
    gate_id: gate.id,
    rule_ids: gate.rule_ids,
    command_digest: sha256(stableJson(command)),
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended.valueOf() - started.valueOf(),
    exit_code: exitCode,
    state,
    log_path: logPath,
    log_sha256: sha256(log),
  };
}

export async function runPlan(bundle: ContractBundle, plan: ExecutionPlan, options: RunOptions): Promise<EvidenceManifest> {
  const context = executionContextFromParts(options.repository, options.pull_request, options.base_sha, options.head_sha);
  if (!executionContextsEqual(plan.context, context)) throw new PlanningError('Run GitHub execution context does not match the plan');
  await verifyPlan(bundle, plan, options.exceptions ?? []);
  const approvalDiagnostics = await validateApprovals(bundle, options.approvals ?? [], {
    source_revision: plan.source_revision,
    repository: context?.repository,
    pull_request: context?.pull_request,
  });
  if (approvalDiagnostics.length > 0) throw new Error(JSON.stringify(approvalDiagnostics));
  const root = await repositoryRoot(bundle, options.project_root);
  if (plan.source_revision || plan.source_base_revision) {
    if (!plan.source_revision || !plan.source_base_revision) throw new PlanningError('Git-bound plans require both source revisions');
    const gitRoot = await gitRepositoryRoot(root);
    if (!await pathsReferToSameLocation(gitRoot, root)) throw new PlanningError('Project root must be the Git repository root');
    await assertGitPlanContext(root, plan.source_base_revision, plan.source_revision, plan.changed_files);
  } else {
    try {
      await gitRepositoryRoot(root);
      throw new PlanningError('Plans executed inside a Git repository must be Git-bound');
    } catch (error) {
      if (error instanceof PlanningError) throw error;
    }
  }
  const outputDir = path.resolve(options.output_dir);
  await mkdir(outputDir, { recursive: true });
  const exceptions = options.exceptions ?? [];
  const approvals = options.approvals ?? [];
  await Promise.all([
    writeFile(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
    writeFile(path.join(outputDir, 'exceptions.json'), `${JSON.stringify(exceptions, null, 2)}\n`, 'utf8'),
    writeFile(path.join(outputDir, 'approvals.json'), `${JSON.stringify(approvals, null, 2)}\n`, 'utf8'),
  ]);
  const started = new Date();
  const results: GateEvidence[] = [];

  for (const gate of plan.gates) {
    if (gate.depends_on.some((id) => results.find((result) => result.gate_id === id)?.state !== 'passed')) continue;
    if (gate.exception_id) {
      const now = new Date().toISOString();
      results.push({ gate_id: gate.id, rule_ids: gate.rule_ids, started_at: now, ended_at: now, duration_ms: 0, exit_code: null, state: 'exception', exception_id: gate.exception_id });
      continue;
    }
    if (gate.kind === 'manual-review') {
      const now = new Date().toISOString();
      const approval = approvalForGate(approvals, gate.id);
      results.push({ gate_id: gate.id, rule_ids: gate.rule_ids, started_at: now, ended_at: now, duration_ms: 0, exit_code: null, state: approval ? 'passed' : 'failed', ...(approval ? { approval_id: approval.id, approval_digest: sha256(stableJson(approval)) } : {}) });
      continue;
    }
    const command = gate.command ? bundle.profile.commands[gate.command] : undefined;
    if (!command) {
      const now = new Date().toISOString();
      results.push({ gate_id: gate.id, rule_ids: gate.rule_ids, started_at: now, ended_at: now, duration_ms: 0, exit_code: null, state: 'failed' });
      continue;
    }
    results.push(await executeGate(root, gate, command, outputDir, options.signal));
  }

  const ended = new Date();
  const manualGateIds = new Set(plan.gates.filter((gate) => gate.kind === 'manual-review').map((gate) => gate.id));
  const approvalEvidence = plan.approvals.map((role) => {
    const matching = approvalsForRole(approvals, role, manualGateIds);
    return { role, approval_ids: matching.map((record) => record.id).sort(), state: matching.length > 0 ? 'passed' as const : 'failed' as const };
  });
  const manifest = finalizeManifest({
    version: 1,
    harness_version: '0.1.0',
    run_id: randomUUID(),
    repository_root: root,
    context: plan.context,
    commit_sha: plan.source_revision,
    ci_provenance: options.ci_provenance ?? null,
    platform: process.platform,
    node_version: process.version,
    operation: plan.operation,
    target_environment: plan.target_environment,
    changed_files: plan.changed_files,
    route_ids: plan.route_ids,
    contracts_sha256: contractsDigest(bundle),
    plan_path: 'plan.json',
    plan_sha256: sha256(stableJson(plan)),
    exceptions_path: 'exceptions.json',
    exceptions_sha256: sha256(stableJson(exceptions)),
    approvals_path: 'approvals.json',
    approvals_sha256: sha256(stableJson(approvals)),
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    gates: results,
    approvals: approvalEvidence,
    result: results.length === plan.gates.length
      && results.every((result) => result.state === 'passed' || result.state === 'exception')
      && approvalEvidence.every((approval) => approval.state === 'passed') ? 'passed' : 'failed',
    manifest_sha256: '',
  });
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
