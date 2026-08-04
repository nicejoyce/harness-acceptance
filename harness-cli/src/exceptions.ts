import { minimatch } from 'minimatch';

import type { Diagnostic } from './diagnostics.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import type { ContractBundle, ExceptionRecord } from './types.ts';

export interface ExceptionContext {
  changed_files: string[];
  now: Date;
}

export async function validateExceptions(bundle: ContractBundle, records: ExceptionRecord[], context: ExceptionContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const gates = new Map(bundle.gates.gates.map((gate) => [gate.id, gate]));
  const rules = new Map(bundle.registry.rules.map((rule) => [rule.id, rule]));
  const validate = await schemaValidator('exception.schema.json');

  for (const record of records) {
    const document = `exceptions/${record.id}`;
    if (!validate(record)) {
      diagnostics.push(...schemaErrorMessages(validate.errors).map((message) => ({ code: 'EXCEPTION_INVALID' as const, document, path: '/', message })));
      continue;
    }
    const expiresAt = new Date(record.expires_at);
    if (!Number.isFinite(expiresAt.valueOf()) || expiresAt <= context.now) {
      diagnostics.push({ code: 'EXCEPTION_EXPIRED', document, path: '/expires_at', message: `Exception ${record.id} is expired` });
    }
    const scopeMatches = context.changed_files.every((file) => record.scope.paths.some((pattern) => minimatch(file.replaceAll('\\', '/'), pattern, { dot: true })));
    if (!scopeMatches) diagnostics.push({ code: 'EXCEPTION_SCOPE_MISMATCH', document, path: '/scope/paths', message: `Exception ${record.id} does not cover all changed files` });

    for (const gateId of record.gate_ids) {
      const gate = gates.get(gateId);
      if (!gate) diagnostics.push({ code: 'EXCEPTION_INVALID', document, path: '/gate_ids', message: `Unknown gate: ${gateId}` });
      else if (gate.severity === 'BLOCKER' || !gate.exception_allowed) diagnostics.push({ code: 'BLOCKER_EXCEPTION_FORBIDDEN', document, path: '/gate_ids', message: `Gate cannot be excepted: ${gateId}` });
    }
    for (const ruleId of record.rule_ids) {
      const rule = rules.get(ruleId);
      if (!rule) diagnostics.push({ code: 'EXCEPTION_INVALID', document, path: '/rule_ids', message: `Unknown rule: ${ruleId}` });
      else if (rule.severity === 'BLOCKER' || !rule.exception_allowed) diagnostics.push({ code: 'BLOCKER_EXCEPTION_FORBIDDEN', document, path: '/rule_ids', message: `Rule cannot be excepted: ${ruleId}` });
    }
    const authorizedApprovers = Object.values(bundle.profile.approvals.roles).flat();
    if (!authorizedApprovers.includes(record.approver)) {
      diagnostics.push({ code: 'EXCEPTION_INVALID', document, path: '/approver', message: `Approver is not authorized: ${record.approver}` });
    }
  }
  return diagnostics;
}

export function applicableException(records: ExceptionRecord[], gateId: string): ExceptionRecord | undefined {
  return records.find((record) => record.gate_ids.includes(gateId));
}
