import type { Diagnostic } from './diagnostics.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import type { ApprovalRecord, ContractBundle } from './types.ts';

export interface ApprovalValidationContext {
  now?: Date;
  source_revision: string | null;
  repository?: string;
  pull_request?: number;
}

export async function validateApprovals(bundle: ContractBundle, records: ApprovalRecord[], context: ApprovalValidationContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const now = context.now ?? new Date();
  const gates = new Map(bundle.gates.gates.map((gate) => [gate.id, gate]));
  const validate = await schemaValidator('approval.schema.json');
  for (const record of records) {
    const document = `approvals/${record.id}`;
    if (!validate(record)) {
      diagnostics.push(...schemaErrorMessages(validate.errors).map((message) => ({ code: 'APPROVAL_INVALID' as const, document, path: '/', message })));
      continue;
    }
    const approvedAt = new Date(record.approved_at);
    const expiresAt = new Date(record.expires_at);
    if (!Number.isFinite(approvedAt.valueOf()) || !Number.isFinite(expiresAt.valueOf())) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/approved_at', message: `Approval ${record.id} contains an invalid timestamp` });
    else if (expiresAt <= approvedAt) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/expires_at', message: `Approval ${record.id} expires before or at approval time` });
    else if (expiresAt <= now || approvedAt > now) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/expires_at', message: `Approval ${record.id} is inactive` });
    const authorizedIdentities = bundle.profile.approvals.roles[record.role];
    if (!authorizedIdentities) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/role', message: `Approval role is not configured: ${record.role}` });
    else if (!authorizedIdentities.some((identity) => identity.toLowerCase() === record.approver.toLowerCase())) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/approver', message: `Approver ${record.approver} is not authorized for role ${record.role}` });
    if (!context.source_revision || record.commit_sha !== context.source_revision) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/commit_sha', message: `Approval ${record.id} does not match the execution commit` });
    if (!context.repository || record.repository.toLowerCase() !== context.repository.toLowerCase()) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/repository', message: `Approval ${record.id} does not match the execution repository` });
    if (!context.pull_request || record.pull_request !== context.pull_request) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/pull_request', message: `Approval ${record.id} does not match the pull request` });
    const expectedReference = `https://github.com/${record.repository}/pull/${record.pull_request}#pullrequestreview-${record.review_id}`;
    if (record.approval_reference !== expectedReference) diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/approval_reference', message: `Approval ${record.id} has an invalid GitHub review reference` });
    for (const gateId of record.gate_ids) {
      const gate = gates.get(gateId);
      if (!gate || gate.kind !== 'manual-review') diagnostics.push({ code: 'APPROVAL_INVALID', document, path: '/gate_ids', message: `Approval references a non-review gate: ${gateId}` });
    }
  }
  return diagnostics;
}

export function approvalForGate(records: ApprovalRecord[], gateId: string): ApprovalRecord | undefined {
  return records.find((record) => record.gate_ids.includes(gateId));
}

export function approvalsForRole(records: ApprovalRecord[], role: string, manualGateIds: Set<string>): ApprovalRecord[] {
  return records.filter((record) => record.role === role && record.gate_ids.some((gateId) => manualGateIds.has(gateId)));
}
