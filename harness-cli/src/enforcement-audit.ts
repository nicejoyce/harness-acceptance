import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { loadContracts } from './contracts.ts';
import { schemaErrorMessages, schemaValidator } from './schema.ts';
import type { EnforcedRuleDefinition } from './types.ts';

type EnforcementMode = EnforcedRuleDefinition['enforcement']['mode'];

interface InventoryRuleBase {
  id: string;
  mode: EnforcementMode;
  evidence_type: string;
  owner: string;
  implementation_status: 'implemented' | 'planned' | 'unverifiable';
  known_gap: string | null;
}

type InventoryRule = InventoryRuleBase & {
  verifier_gate_ids?: string[];
  attestation_policy_id?: string;
};

interface EnforcementInventory {
  version: 1;
  rules: InventoryRule[];
}

export interface EnforcementAuditDiagnostic {
  code: 'INVENTORY_INVALID' | 'INVENTORY_COVERAGE_MISMATCH' | 'INVENTORY_DECLARATION_MISMATCH';
  rule_id?: string;
  message: string;
}

export interface EnforcementAuditResult {
  valid: boolean;
  diagnostics: EnforcementAuditDiagnostic[];
  summary: {
    total_rules: number;
    modes: Record<EnforcementMode, number>;
    unclassified: number;
    blocker_advisory: number;
    blocker_rule_declares_only_peer_review: number;
    blocker_without_effective_control: number;
    reused_gate_combinations: number;
    rules_without_gates: number;
  };
}

function equalStringSets(left: string[] = [], right: string[] = []): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export async function auditEnforcement(root: string): Promise<EnforcementAuditResult> {
  const diagnostics: EnforcementAuditDiagnostic[] = [];
  const inventoryPath = path.join(root, 'contracts/enforcement-inventory.yaml');
  let inventory: EnforcementInventory | undefined;
  try {
    inventory = parse(await readFile(inventoryPath, 'utf8')) as EnforcementInventory;
  } catch (error) {
    diagnostics.push({ code: 'INVENTORY_INVALID', message: error instanceof Error ? error.message : 'Unable to read enforcement inventory' });
  }

  if (inventory) {
    const validate = await schemaValidator('enforcement-inventory.schema.json');
    if (!validate(inventory)) {
      diagnostics.push(...schemaErrorMessages(validate.errors).map((message) => ({ code: 'INVENTORY_INVALID' as const, message })));
      inventory = undefined;
    }
  }

  const bundle = await loadContracts(root);
  if (bundle.registry.version !== 4) {
    diagnostics.push({ code: 'INVENTORY_DECLARATION_MISMATCH', message: 'Enforcement inventory requires rule registry v4' });
  }
  const rules = bundle.registry.version === 4 ? bundle.registry.rules : [];
  const inventoryRules = inventory?.rules ?? [];
  const inventoryById = new Map(inventoryRules.map((rule) => [rule.id, rule]));
  const duplicateInventoryIds = inventoryRules.filter((rule, index) => inventoryRules.findIndex((candidate) => candidate.id === rule.id) !== index).map((rule) => rule.id);
  const registryIds = new Set(rules.map((rule) => rule.id));

  for (const ruleId of new Set(duplicateInventoryIds)) diagnostics.push({ code: 'INVENTORY_COVERAGE_MISMATCH', rule_id: ruleId, message: `Duplicate inventory rule: ${ruleId}` });
  for (const rule of rules) if (!inventoryById.has(rule.id)) diagnostics.push({ code: 'INVENTORY_COVERAGE_MISMATCH', rule_id: rule.id, message: `Inventory omits rule: ${rule.id}` });
  for (const entry of inventoryRules) if (!registryIds.has(entry.id)) diagnostics.push({ code: 'INVENTORY_COVERAGE_MISMATCH', rule_id: entry.id, message: `Inventory contains unknown rule: ${entry.id}` });

  for (const rule of rules) {
    const entry = inventoryById.get(rule.id);
    if (!entry) continue;
    const expectedOwner = bundle.registry.modules[rule.module]?.owner;
    if (entry.mode !== rule.enforcement.mode || entry.owner !== expectedOwner) {
      diagnostics.push({ code: 'INVENTORY_DECLARATION_MISMATCH', rule_id: rule.id, message: `Inventory mode or owner does not match registry rule ${rule.id}` });
      continue;
    }
    if (rule.enforcement.mode === 'machine-enforced' && !equalStringSets(entry.verifier_gate_ids, rule.enforcement.verifier_gate_ids)) {
      diagnostics.push({ code: 'INVENTORY_DECLARATION_MISMATCH', rule_id: rule.id, message: `Inventory verifier gates do not match registry rule ${rule.id}` });
    }
    if (rule.enforcement.mode === 'human-attested' && entry.attestation_policy_id !== rule.enforcement.attestation_policy_id) {
      diagnostics.push({ code: 'INVENTORY_DECLARATION_MISMATCH', rule_id: rule.id, message: `Inventory attestation policy does not match registry rule ${rule.id}` });
    }
  }

  const modes: Record<EnforcementMode, number> = { 'machine-enforced': 0, 'human-attested': 0, advisory: 0 };
  for (const rule of rules) modes[rule.enforcement.mode] += 1;
  const gateCombinations = new Map<string, number>();
  for (const rule of rules) {
    const key = [...rule.gates].sort().join(',');
    if (key) gateCombinations.set(key, (gateCombinations.get(key) ?? 0) + 1);
  }
  const blockerRules = rules.filter((rule) => rule.severity === 'BLOCKER');
  const summary = {
    total_rules: rules.length,
    modes,
    unclassified: rules.filter((rule) => !inventoryById.has(rule.id)).length,
    blocker_advisory: blockerRules.filter((rule) => rule.enforcement.mode === 'advisory').length,
    blocker_rule_declares_only_peer_review: blockerRules.filter((rule) => equalStringSets(rule.gates, ['gate.peer-review'])).length,
    blocker_without_effective_control: blockerRules.filter((rule) => inventoryById.get(rule.id)?.implementation_status !== 'implemented').length,
    reused_gate_combinations: [...gateCombinations.values()].filter((count) => count > 1).length,
    rules_without_gates: rules.filter((rule) => rule.gates.length === 0).length,
  };
  return { valid: diagnostics.length === 0, diagnostics, summary };
}
