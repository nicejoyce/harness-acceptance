import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import type { FinalResult } from './aggregate.ts';
import { verifyEvidence } from './evidence.ts';
import { stableJson } from './hash.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import { verifySignedFinalResult, type SignedFinalResult } from './signing.ts';
import type { ApprovalRecord, EvidenceManifest } from './types.ts';

export interface PolicyThreshold {
  id: string;
  value: number;
}

export interface DeliveryRecord {
  version: 1;
  facts: {
    repository: string | null;
    pull_request: number | null;
    base_sha: string | null;
    head_sha: string | null;
    commit_sha: string | null;
    result: FinalResult['result'];
    lane: EvidenceManifest['lane'];
    risk_tier: EvidenceManifest['risk_tier'];
    route_ids: string[];
    platform: string;
    expected_platforms: FinalResult['expected_platforms'];
    execution_platforms: FinalResult['execution_platforms'];
    platform_reason_codes: string[];
    fallback_full_matrix: boolean;
    platform_mode: FinalResult['platform_mode'];
    gates: Array<{ id: string; rule_ids: string[]; state: string }>;
    tool_versions: { harness: string; node: string };
    thresholds: PolicyThreshold[];
    approvals: FinalResult['approvals'];
    plan_sha256: string;
    evidence_sha256: string;
    signing_key_id: string;
  };
  human_authored: {
    objective: null;
    design_motivation: null;
    risk_judgment: null;
    business_rationale: null;
    rollback_decision: null;
  };
}

export interface DeriveDeliveryRecordOptions {
  contract_root: string;
  project_root: string;
  manifest_path: string;
  final_path: string;
  trusted_public_keys: Map<string, string>;
}

async function optionalYaml(file: string): Promise<unknown | undefined> {
  try {
    return parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function loadPolicyThresholds(contractRoot: string): Promise<PolicyThreshold[]> {
  const result: PolicyThreshold[] = [];
  const quality = await optionalYaml(path.join(contractRoot, 'contracts/quality-baseline.yaml')) as { thresholds?: Record<string, unknown> } | undefined;
  for (const [id, value] of Object.entries(quality?.thresholds ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) result.push({ id, value });
  }
  const testQuality = await optionalYaml(path.join(contractRoot, 'contracts/test-quality-policy.yaml')) as { mutation?: { smoke_threshold?: unknown } } | undefined;
  if (typeof testQuality?.mutation?.smoke_threshold === 'number' && Number.isFinite(testQuality.mutation.smoke_threshold)) {
    result.push({ id: 'mutation_smoke_threshold', value: testQuality.mutation.smoke_threshold });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function approvalSummary(records: ApprovalRecord[]): FinalResult['approvals'] {
  return records.map((record) => ({
    id: record.id,
    role: record.role,
    approver: record.approver,
    approval_reference: record.approval_reference,
    review_id: record.review_id,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export async function deriveDeliveryRecord(options: DeriveDeliveryRecordOptions): Promise<DeliveryRecord> {
  const manifestPath = path.resolve(options.manifest_path);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceManifest;
  const evidenceVerification = await verifyEvidence(options.contract_root, manifestPath, options.project_root, manifest.context);
  if (!evidenceVerification.valid) throw new Error(`Evidence verification failed: ${JSON.stringify(evidenceVerification.diagnostics)}`);

  const envelope: unknown = JSON.parse(await readFile(path.resolve(options.final_path), 'utf8'));
  const validateFinal = await schemaValidator('final.schema.json');
  if (!validateFinal(envelope)) throw new Error(`Final schema is invalid: ${schemaErrorMessages(validateFinal.errors).join('; ')}`);
  const signed = envelope as SignedFinalResult;
  const publicKey = options.trusted_public_keys.get(signed.key_id);
  if (!publicKey || !verifySignedFinalResult(signed, publicKey)) throw new Error(`Final signature is invalid for key ID ${signed.key_id}`);

  if (stableJson(signed.payload.context) !== stableJson(manifest.context)) throw new Error('Final context does not match Evidence context');
  if (signed.payload.plan_sha256 !== manifest.plan_sha256) throw new Error('Final plan hash does not match Evidence');
  const platformEvidence = signed.payload.evidence.find((item) => item.platform === manifest.platform);
  if (!platformEvidence) throw new Error(`Final platform set does not include Evidence platform ${manifest.platform}`);
  if (platformEvidence.manifest_sha256 !== manifest.manifest_sha256) throw new Error('Final Evidence hash does not match the manifest');
  if (platformEvidence.result !== manifest.result) throw new Error('Final result does not match the Evidence result');

  const evidenceRoot = path.dirname(manifestPath);
  const approvalsPath = path.resolve(evidenceRoot, manifest.approvals_path);
  if (!inside(evidenceRoot, approvalsPath)) throw new Error('Evidence approval path escapes the evidence root');
  const approvals = JSON.parse(await readFile(approvalsPath, 'utf8')) as ApprovalRecord[];
  if (stableJson(approvalSummary(approvals)) !== stableJson(signed.payload.approvals)) throw new Error('Final approval facts do not match the verified Evidence snapshot');

  return {
    version: 1,
    facts: {
      repository: manifest.context?.repository ?? null,
      pull_request: manifest.context?.pull_request ?? null,
      base_sha: manifest.context?.base_sha ?? null,
      head_sha: manifest.context?.head_sha ?? null,
      commit_sha: manifest.commit_sha,
      result: signed.payload.result,
      lane: manifest.lane,
      risk_tier: manifest.risk_tier,
      route_ids: [...manifest.route_ids],
      platform: manifest.platform,
      expected_platforms: [...signed.payload.expected_platforms],
      execution_platforms: [...signed.payload.execution_platforms],
      platform_reason_codes: [...signed.payload.platform_reason_codes],
      fallback_full_matrix: signed.payload.fallback_full_matrix,
      platform_mode: signed.payload.platform_mode,
      gates: manifest.gates.map((gate) => ({ id: gate.gate_id, rule_ids: [...gate.rule_ids], state: gate.state })),
      tool_versions: { harness: manifest.harness_version, node: manifest.node_version },
      thresholds: structuredClone(signed.payload.thresholds),
      approvals: structuredClone(signed.payload.approvals),
      plan_sha256: manifest.plan_sha256,
      evidence_sha256: manifest.manifest_sha256,
      signing_key_id: signed.key_id,
    },
    human_authored: {
      objective: null,
      design_motivation: null,
      risk_judgment: null,
      business_rationale: null,
      rollback_decision: null,
    },
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

export function renderDeliveryRecord(record: DeliveryRecord, format: 'markdown' | 'json'): string {
  if (format === 'json') return `${JSON.stringify(record, null, 2)}\n`;
  const facts = record.facts;
  const lines = [
    '# Harness Delivery Facts',
    '',
    `- Result: ${facts.result}`,
    `- Repository: ${facts.repository ?? ''}`,
    `- Pull request: ${facts.pull_request ?? ''}`,
    `- Base SHA: ${facts.base_sha ?? ''}`,
    `- Head SHA: ${facts.head_sha ?? ''}`,
    `- Commit SHA: ${facts.commit_sha ?? ''}`,
    `- Lane: ${facts.lane}`,
    `- Risk tier: ${facts.risk_tier}`,
    `- Routes: ${facts.route_ids.join(', ')}`,
    `- Platform: ${facts.platform}`,
    `- Expected platforms: ${facts.expected_platforms.join(', ')}`,
    `- Execution platforms: ${facts.execution_platforms.join(', ')}`,
    `- Platform reasons: ${facts.platform_reason_codes.join(', ')}`,
    `- Full-matrix fallback: ${facts.fallback_full_matrix}`,
    `- Platform mode: ${facts.platform_mode}`,
    `- Harness version: ${facts.tool_versions.harness}`,
    `- Node version: ${facts.tool_versions.node}`,
    `- Plan SHA-256: ${facts.plan_sha256}`,
    `- Evidence SHA-256: ${facts.evidence_sha256}`,
    `- Signing key ID: ${facts.signing_key_id}`,
    '',
    '## Gates',
    '',
    '| Gate | Rules | State |',
    '|---|---|---|',
    ...facts.gates.map((gate) => `| ${markdownCell(gate.id)} | ${markdownCell(gate.rule_ids.join(', '))} | ${markdownCell(gate.state)} |`),
    '',
    '## Policy Thresholds',
    '',
    '| Threshold | Value |',
    '|---|---:|',
    ...facts.thresholds.map((threshold) => `| ${markdownCell(threshold.id)} | ${threshold.value} |`),
    '',
    '## Approvals',
    '',
    '| ID | Role | Approver | Review | Reference |',
    '|---|---|---|---:|---|',
    ...facts.approvals.map((approval) => `| ${markdownCell(approval.id)} | ${markdownCell(approval.role)} | ${markdownCell(approval.approver)} | ${approval.review_id} | ${markdownCell(approval.approval_reference)} |`),
    '',
    '## Human-Authored Fields',
    '',
    '- Objective:',
    '- Design motivation:',
    '- Risk judgment:',
    '- Business rationale:',
    '- Rollback decision:',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
