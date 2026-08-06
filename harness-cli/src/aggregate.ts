import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyEvidence } from './evidence.ts';
import { stableJson } from './hash.ts';
import { loadPolicyThresholds, type PolicyThreshold } from './records.ts';
import type { ApprovalRecord, EvidenceManifest, ExecutionContext, ExecutionPlan, RuleAttestationRecord } from './types.ts';
import type { PlatformId } from './platforms.ts';

export type GitHubJobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped';

export interface FinalEvidenceSummary {
  platform: string;
  manifest_sha256: string;
  result: EvidenceManifest['result'];
}

export interface FinalApprovalSummary {
  id: string;
  role: string;
  approver: string;
  approval_reference: string;
  review_id: number;
}

export interface FinalResult {
  version: 1;
  context: ExecutionContext | null;
  generated_at: string;
  check_name: 'harness-final';
  job_conclusion: GitHubJobConclusion;
  plan_sha256: string;
  expected_platforms: PlatformId[];
  execution_platforms: PlatformId[];
  platform_reason_codes: string[];
  fallback_full_matrix: boolean;
  platform_mode: 'shadow' | 'enforce' | 'fallback';
  evidence: FinalEvidenceSummary[];
  approvals: FinalApprovalSummary[];
  thresholds: PolicyThreshold[];
  result: 'passed' | 'failed';
}

export interface AggregateOptions {
  contract_root: string;
  project_root: string;
  context: ExecutionContext | null;
  manifest_paths: string[];
  job_conclusion: GitHubJobConclusion;
  expected_approvals: ApprovalRecord[];
  expected_rule_attestations: RuleAttestationRecord[];
  generated_at?: Date;
}

export async function aggregateTrustedEvidence(options: AggregateOptions): Promise<FinalResult> {
  if (options.manifest_paths.length === 0) throw new Error('At least one evidence manifest is required');
  const manifests: EvidenceManifest[] = [];

  for (const manifestPath of options.manifest_paths) {
    const verification = await verifyEvidence(options.contract_root, manifestPath, options.project_root, options.context);
    if (!verification.valid) throw new Error(`Evidence verification failed for ${manifestPath}: ${JSON.stringify(verification.diagnostics)}`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceManifest;
    if (manifest.lane !== 'full') throw new Error(`Final aggregation accepts full lane Evidence only: ${manifestPath}`);
    const approvalsPath = path.resolve(path.dirname(path.resolve(manifestPath)), manifest.approvals_path);
    const approvals = JSON.parse(await readFile(approvalsPath, 'utf8')) as ApprovalRecord[];
    if (stableJson(approvals) !== stableJson(options.expected_approvals)) throw new Error(`Evidence approval snapshot does not match current trusted approvals: ${manifestPath}`);
    const ruleAttestationsPath = path.resolve(path.dirname(path.resolve(manifestPath)), manifest.rule_attestations_path);
    const ruleAttestations = JSON.parse(await readFile(ruleAttestationsPath, 'utf8')) as RuleAttestationRecord[];
    if (stableJson(ruleAttestations) !== stableJson(options.expected_rule_attestations)) throw new Error(`Evidence rule attestation snapshot does not match current trusted reviews: ${manifestPath}`);
    manifests.push(manifest);
  }

  const planDigests = new Set(manifests.map((manifest) => manifest.plan_sha256));
  if (planDigests.size !== 1) throw new Error('Evidence manifests do not share one canonical plan');
  const planPath = path.resolve(path.dirname(path.resolve(options.manifest_paths[0]!)), manifests[0]!.plan_path);
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as ExecutionPlan;
  const actualPlatforms = manifests.map((manifest) => manifest.platform);
  if (new Set(actualPlatforms).size !== actualPlatforms.length) throw new Error('Duplicate platform Evidence is not allowed');
  const missingPlatforms = plan.execution_platforms.filter((platform) => !actualPlatforms.includes(platform));
  if (missingPlatforms.length > 0) throw new Error(`Platform Evidence missing: ${missingPlatforms.join(', ')}`);
  const extraPlatforms = actualPlatforms.filter((platform) => !plan.execution_platforms.includes(platform as PlatformId));
  if (extraPlatforms.length > 0) throw new Error(`Platform Evidence extra: ${extraPlatforms.join(', ')}`);
  const evidence = manifests
    .map((manifest) => ({ platform: manifest.platform, manifest_sha256: manifest.manifest_sha256, result: manifest.result }))
    .sort((left, right) => left.platform.localeCompare(right.platform));
  const approvals = options.expected_approvals.map((record) => ({
    id: record.id,
    role: record.role,
    approver: record.approver,
    approval_reference: record.approval_reference,
    review_id: record.review_id,
  })).sort((left, right) => left.id.localeCompare(right.id));

  return {
    version: 1,
    context: options.context,
    generated_at: (options.generated_at ?? new Date()).toISOString(),
    check_name: 'harness-final',
    job_conclusion: options.job_conclusion,
    plan_sha256: manifests[0]!.plan_sha256,
    expected_platforms: [...plan.expected_platforms],
    execution_platforms: [...plan.execution_platforms],
    platform_reason_codes: [...plan.platform_reason_codes],
    fallback_full_matrix: plan.fallback_full_matrix,
    platform_mode: plan.platform_mode,
    evidence,
    approvals,
    thresholds: await loadPolicyThresholds(options.contract_root),
    result: options.job_conclusion === 'success' && evidence.every((item) => item.result === 'passed') ? 'passed' : 'failed',
  };
}
