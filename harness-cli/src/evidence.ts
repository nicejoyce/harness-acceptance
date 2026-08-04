import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { approvalsForRole, validateApprovals } from './approvals.ts';
import { loadContracts } from './contracts.ts';
import type { Diagnostic, ValidationResult } from './diagnostics.ts';
import { contractsDigest, sha256, stableJson } from './hash.ts';
import { verifyPlan } from './planner.ts';
import { assertGitPlanContext, gitRepositoryRoot } from './git.ts';
import { executionContextsEqual, validateExecutionContext } from './context.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import type { ApprovalRecord, EvidenceManifest, ExceptionRecord, ExecutionContext, ExecutionPlan } from './types.ts';

function withoutManifestDigest(manifest: EvidenceManifest): Omit<EvidenceManifest, 'manifest_sha256'> {
  const { manifest_sha256: _ignored, ...content } = manifest;
  return content;
}

export function finalizeManifest(manifest: EvidenceManifest): EvidenceManifest {
  return { ...manifest, manifest_sha256: sha256(stableJson(withoutManifestDigest(manifest))) };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readSnapshot<T>(evidenceRoot: string, relativePath: string, document: string, diagnostics: Diagnostic[]): Promise<T | undefined> {
  const snapshotPath = path.resolve(evidenceRoot, relativePath);
  if (!inside(evidenceRoot, snapshotPath)) {
    diagnostics.push({ code: 'EVIDENCE_INVALID', document, path: '/', message: 'Snapshot path escapes the evidence root' });
    return undefined;
  }
  try {
    return JSON.parse(await readFile(snapshotPath, 'utf8')) as T;
  } catch (error) {
    diagnostics.push({ code: 'EVIDENCE_ARTIFACT_MISSING', document, path: '/', message: error instanceof Error ? error.message : 'Snapshot is missing or invalid' });
    return undefined;
  }
}

function digestDiagnostic(actual: string, expected: string, document: string, manifestPath: string): Diagnostic[] {
  return actual === expected ? [] : [{ code: 'EVIDENCE_DIGEST_MISMATCH', document: manifestPath, path: document, message: `${document} does not match its snapshot` }];
}

export interface EvidenceVerificationContext {
  repository: string;
  pull_request: number;
  base_sha: string;
  head_sha: string;
}

export async function verifyEvidence(contractRoot: string, manifestPath: string, projectRoot = contractRoot, context: ExecutionContext | null = null): Promise<ValidationResult> {
  const diagnostics: Diagnostic[] = [];
  let manifest: EvidenceManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceManifest;
  } catch (error) {
    return { valid: false, diagnostics: [{ code: 'EVIDENCE_INVALID', document: manifestPath, path: '/', message: error instanceof Error ? error.message : 'Invalid evidence manifest' }] };
  }

  const validate = await schemaValidator('evidence.schema.json');
  if (!validate(manifest)) {
    return {
      valid: false,
      diagnostics: schemaErrorMessages(validate.errors).map((message) => ({ code: 'EVIDENCE_INVALID', document: manifestPath, path: '/', message })),
    };
  }

  const evidenceRoot = path.dirname(path.resolve(manifestPath));
  const expectedManifestDigest = sha256(stableJson(withoutManifestDigest(manifest)));
  if (manifest.manifest_sha256 !== expectedManifestDigest) {
    diagnostics.push({ code: 'EVIDENCE_DIGEST_MISMATCH', document: manifestPath, path: '/manifest_sha256', message: 'Manifest digest does not match its content' });
  }

  let bundle;
  try {
    bundle = await loadContracts(contractRoot);
    diagnostics.push(...digestDiagnostic(manifest.contracts_sha256, contractsDigest(bundle), '/contracts_sha256', manifestPath));
  } catch (error) {
    diagnostics.push({ code: 'EVIDENCE_INVALID', document: contractRoot, path: '/', message: error instanceof Error ? error.message : 'Canonical contracts are invalid' });
  }

  const plan = await readSnapshot<ExecutionPlan>(evidenceRoot, manifest.plan_path, manifest.plan_path, diagnostics);
  const exceptions = await readSnapshot<ExceptionRecord[]>(evidenceRoot, manifest.exceptions_path, manifest.exceptions_path, diagnostics);
  const approvals = await readSnapshot<ApprovalRecord[]>(evidenceRoot, manifest.approvals_path, manifest.approvals_path, diagnostics);

  if (plan) {
    const validatePlan = await schemaValidator('plan.schema.json');
    if (!validatePlan(plan)) diagnostics.push(...schemaErrorMessages(validatePlan.errors).map((message) => ({ code: 'PLAN_INVALID' as const, document: manifest.plan_path, path: '/', message })));
    diagnostics.push(...digestDiagnostic(manifest.plan_sha256, sha256(stableJson(plan)), '/plan_sha256', manifestPath));
    if (stableJson({ operation: manifest.operation, target_environment: manifest.target_environment, changed_files: manifest.changed_files, route_ids: manifest.route_ids }) !== stableJson({ operation: plan.operation, target_environment: plan.target_environment, changed_files: plan.changed_files, route_ids: plan.route_ids })) {
      diagnostics.push({ code: 'PLAN_INVALID', document: manifestPath, path: '/', message: 'Manifest routing inputs do not match the plan snapshot' });
    }
    if (manifest.commit_sha !== plan.source_revision) diagnostics.push({ code: 'PLAN_INVALID', document: manifestPath, path: '/commit_sha', message: 'Evidence commit does not match the plan source revision' });
    if (!executionContextsEqual(manifest.context, plan.context)) diagnostics.push({ code: 'PLAN_INVALID', document: manifestPath, path: '/context', message: 'Evidence context does not match the plan snapshot' });
  }
  try {
    const expectedContext = validateExecutionContext(context);
    if (!executionContextsEqual(manifest.context, expectedContext)) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: '/context', message: 'Evidence context does not match the expected GitHub context' });
  } catch (error) {
    diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: '/context', message: error instanceof Error ? error.message : 'Invalid GitHub execution context' });
  }
  if (exceptions) diagnostics.push(...digestDiagnostic(manifest.exceptions_sha256, sha256(stableJson(exceptions)), '/exceptions_sha256', manifestPath));
  if (approvals) diagnostics.push(...digestDiagnostic(manifest.approvals_sha256, sha256(stableJson(approvals)), '/approvals_sha256', manifestPath));

  if (bundle && plan && exceptions) {
    try {
      await verifyPlan(bundle, plan, exceptions, new Date(manifest.started_at));
      if (plan.source_revision || plan.source_base_revision) {
        if (!plan.source_revision || !plan.source_base_revision) throw new Error('Git-bound evidence requires both source revisions');
        const gitRoot = await gitRepositoryRoot(projectRoot);
        if (gitRoot !== path.resolve(projectRoot)) throw new Error('Project root must be the Git repository root');
        await assertGitPlanContext(gitRoot, plan.source_base_revision, plan.source_revision, plan.changed_files);
      } else {
        try {
          await gitRepositoryRoot(projectRoot);
          throw new Error('Evidence inside a Git repository must be Git-bound');
        } catch (error) {
          if (error instanceof Error && error.message === 'Evidence inside a Git repository must be Git-bound') throw error;
        }
      }
    } catch (error) {
      diagnostics.push({ code: 'PLAN_INVALID', document: manifest.plan_path, path: '/', message: error instanceof Error ? error.message : 'Plan is not canonical' });
    }
  }
  if (bundle && approvals) diagnostics.push(...await validateApprovals(bundle, approvals, {
    now: new Date(manifest.started_at),
    source_revision: plan?.source_revision ?? null,
    repository: plan?.context?.repository,
    pull_request: plan?.context?.pull_request,
  }));

  const planGates = new Map(plan?.gates.map((gate) => [gate.id, gate]) ?? []);
  const approvalRecords = new Map(approvals?.map((record) => [record.id, record]) ?? []);
  const evidenceGateIds = new Set<string>();
  for (const gate of manifest.gates) {
    if (evidenceGateIds.has(gate.gate_id)) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: '/gates', message: `Duplicate gate evidence: ${gate.gate_id}` });
    evidenceGateIds.add(gate.gate_id);
    const planned = planGates.get(gate.gate_id);
    if (!planned || stableJson(planned.rule_ids) !== stableJson(gate.rule_ids)) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}`, message: 'Gate evidence does not match the plan' });
    if (planned?.kind === 'command') {
      const validCommandState = gate.state === 'passed' ? gate.exit_code === 0 : gate.state === 'failed' ? gate.exit_code !== null && gate.exit_code !== 0 : gate.state === 'timed_out' || gate.state === 'cancelled' ? gate.exit_code === null : gate.state === 'exception';
      if (!validCommandState) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}/state`, message: 'Command state is inconsistent with its exit code' });
      if (!gate.command_digest || !gate.log_path || !gate.log_sha256) diagnostics.push({ code: 'EVIDENCE_ARTIFACT_MISSING', document: manifestPath, path: `/gates/${gate.gate_id}`, message: 'Command evidence requires a command digest and log artifact' });
    }
    if (planned?.kind === 'manual-review' && gate.exit_code !== null) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}/exit_code`, message: 'Manual review cannot have a process exit code' });
    if (planned?.kind === 'manual-review' && (gate.command_digest || gate.log_path || gate.log_sha256)) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}`, message: 'Manual review cannot contain command evidence' });
    if (planned?.exception_id && (gate.state !== 'exception' || gate.exception_id !== planned.exception_id)) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}`, message: 'Exception evidence does not match the plan' });
    if (!planned?.exception_id && (gate.state === 'exception' || gate.exception_id)) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}/exception_id`, message: 'Unexpected exception evidence' });
    if (planned?.kind === 'manual-review' && gate.state === 'passed') {
      const approval = gate.approval_id ? approvalRecords.get(gate.approval_id) : undefined;
      if (!approval || !approval.gate_ids.includes(gate.gate_id) || gate.approval_digest !== sha256(stableJson(approval))) diagnostics.push({ code: 'APPROVAL_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}`, message: 'Manual review is not backed by its approval snapshot' });
    }
    if (planned?.kind === 'command' && planned.command && bundle) {
      const command = bundle.profile.commands[planned.command];
      if (!command || gate.command_digest !== sha256(stableJson(command))) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}/command_digest`, message: 'Command evidence does not match canonical contracts' });
    }
    if (!gate.log_path || !gate.log_sha256) continue;
    const logPath = path.resolve(evidenceRoot, gate.log_path);
    if (!inside(evidenceRoot, logPath)) {
      diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: `/gates/${gate.gate_id}/log_path`, message: 'Evidence path escapes the evidence root' });
      continue;
    }
    try {
      await access(logPath);
      if (sha256(await readFile(logPath)) !== gate.log_sha256) diagnostics.push({ code: 'EVIDENCE_DIGEST_MISMATCH', document: gate.log_path, path: '/', message: `Log digest mismatch for ${gate.gate_id}` });
    } catch {
      diagnostics.push({ code: 'EVIDENCE_ARTIFACT_MISSING', document: gate.log_path, path: '/', message: `Log artifact is missing for ${gate.gate_id}` });
    }
  }

  const manualGateIds = new Set(plan?.gates.filter((gate) => gate.kind === 'manual-review').map((gate) => gate.id) ?? []);
  const expectedApprovals = (plan?.approvals ?? []).map((role) => {
    const matching = approvalsForRole(approvals ?? [], role, manualGateIds);
    return { role, approval_ids: matching.map((record) => record.id).sort(), state: matching.length > 0 ? 'passed' : 'failed' };
  });
  if (stableJson(manifest.approvals) !== stableJson(expectedApprovals)) diagnostics.push({ code: 'APPROVAL_INVALID', document: manifestPath, path: '/approvals', message: 'Required approval evidence does not match the plan and approval snapshot' });

  const complete = plan !== undefined && manifest.gates.length === plan.gates.length;
  const expectedResult = complete
    && manifest.gates.every((gate) => gate.state === 'passed' || gate.state === 'exception')
    && manifest.approvals.every((approval) => approval.state === 'passed') ? 'passed' : 'failed';
  if (manifest.result !== expectedResult) diagnostics.push({ code: 'EVIDENCE_INVALID', document: manifestPath, path: '/result', message: 'Overall result is inconsistent with gate and approval states' });
  return { valid: diagnostics.length === 0, diagnostics };
}
