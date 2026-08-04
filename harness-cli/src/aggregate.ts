import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyEvidence } from './evidence.ts';
import { stableJson } from './hash.ts';
import type { ApprovalRecord, EvidenceManifest, ExecutionContext } from './types.ts';

export type GitHubJobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped';

export interface FinalEvidenceSummary {
  platform: string;
  manifest_sha256: string;
  result: EvidenceManifest['result'];
}

export interface FinalResult {
  version: 1;
  context: ExecutionContext | null;
  generated_at: string;
  check_name: 'harness-final';
  job_conclusion: GitHubJobConclusion;
  plan_sha256: string;
  evidence: FinalEvidenceSummary[];
  result: 'passed' | 'failed';
}

export interface AggregateOptions {
  contract_root: string;
  project_root: string;
  context: ExecutionContext | null;
  manifest_paths: string[];
  job_conclusion: GitHubJobConclusion;
  expected_approvals: ApprovalRecord[];
  generated_at?: Date;
}

export async function aggregateTrustedEvidence(options: AggregateOptions): Promise<FinalResult> {
  if (options.manifest_paths.length === 0) throw new Error('At least one evidence manifest is required');
  const manifests: EvidenceManifest[] = [];

  for (const manifestPath of options.manifest_paths) {
    const verification = await verifyEvidence(options.contract_root, manifestPath, options.project_root, options.context);
    if (!verification.valid) throw new Error(`Evidence verification failed for ${manifestPath}: ${JSON.stringify(verification.diagnostics)}`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceManifest;
    const approvalsPath = path.resolve(path.dirname(path.resolve(manifestPath)), manifest.approvals_path);
    const approvals = JSON.parse(await readFile(approvalsPath, 'utf8')) as ApprovalRecord[];
    if (stableJson(approvals) !== stableJson(options.expected_approvals)) throw new Error(`Evidence approval snapshot does not match current trusted approvals: ${manifestPath}`);
    manifests.push(manifest);
  }

  const planDigests = new Set(manifests.map((manifest) => manifest.plan_sha256));
  if (planDigests.size !== 1) throw new Error('Evidence manifests do not share one canonical plan');
  const evidence = manifests
    .map((manifest) => ({ platform: manifest.platform, manifest_sha256: manifest.manifest_sha256, result: manifest.result }))
    .sort((left, right) => left.platform.localeCompare(right.platform));

  return {
    version: 1,
    context: options.context,
    generated_at: (options.generated_at ?? new Date()).toISOString(),
    check_name: 'harness-final',
    job_conclusion: options.job_conclusion,
    plan_sha256: manifests[0]!.plan_sha256,
    evidence,
    result: options.job_conclusion === 'success' && evidence.every((item) => item.result === 'passed') ? 'passed' : 'failed',
  };
}
