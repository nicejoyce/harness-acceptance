import { applicableException, validateExceptions } from './exceptions.ts';
import { classifyChanges } from './classifier.ts';
import { stableJson } from './hash.ts';
import { validateExecutionContext } from './context.ts';
import { plannedRuleAttestations } from './rule-attestations.ts';
import { loadPlatformPolicy, selectPlatforms } from './platforms.ts';
import type { Classification, ContractBundle, ExceptionRecord, ExecutionContext, ExecutionPlan, GateDefinition, PlannedGate } from './types.ts';

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningError';
  }
}

function requiredLabel(gate: GateDefinition): string {
  return `${gate.id.slice('gate.'.length).replace(/-test$/, '')}-required`;
}

function topologicalOrder(gates: GateDefinition[]): GateDefinition[] {
  const selected = new Map(gates.map((gate) => [gate.id, gate]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: GateDefinition[] = [];

  function visit(gate: GateDefinition): void {
    if (visited.has(gate.id)) return;
    if (visiting.has(gate.id)) throw new PlanningError(`Gate dependency cycle at ${gate.id}`);
    visiting.add(gate.id);
    for (const dependencyId of [...(gate.depends_on ?? [])].sort()) {
      const dependency = selected.get(dependencyId);
      if (!dependency) throw new PlanningError(`Required dependency ${dependencyId} is not selected for ${gate.id}`);
      visit(dependency);
    }
    visiting.delete(gate.id);
    visited.add(gate.id);
    ordered.push(gate);
  }

  for (const gate of [...gates].sort((left, right) => left.id.localeCompare(right.id))) visit(gate);
  return ordered;
}

export async function createPlan(bundle: ContractBundle, classification: Classification, exceptions: ExceptionRecord[], now = new Date(), sourceRevision: string | null = null, sourceBaseRevision: string | null = null, context: ExecutionContext | null = null, lane: 'fast' | 'full' = 'full'): Promise<ExecutionPlan> {
  const executionContext = validateExecutionContext(context);
  if (executionContext && (executionContext.head_sha !== sourceRevision || executionContext.base_sha !== sourceBaseRevision)) throw new PlanningError('GitHub execution context does not match Git base/head revisions');
  const exceptionDiagnostics = await validateExceptions(bundle, exceptions, { changed_files: classification.changed_files, now });
  if (exceptionDiagnostics.length > 0) throw new PlanningError(JSON.stringify(exceptionDiagnostics));
  let platformPolicy = null;
  try {
    platformPolicy = await loadPlatformPolicy(bundle.root);
  } catch {
    platformPolicy = null;
  }
  const platformSelection = selectPlatforms(platformPolicy, classification);
  const executionPlatforms = platformPolicy && !platformSelection.fallback_full_matrix && platformPolicy.mode === 'enforce'
    ? platformSelection.expected_platforms
    : platformPolicy?.full_matrix ?? ['darwin', 'linux', 'win32'];

  const catalog = new Map(bundle.gates.gates.map((gate) => [gate.id, gate]));
  const selected = new Map<string, GateDefinition>();
  const fastGateIds = new Set(['gate.setup', 'gate.format', 'gate.lint', 'gate.typecheck', 'gate.unit-test']);
  for (const id of classification.gate_ids) {
    if (lane === 'fast' && !fastGateIds.has(id)) continue;
    const gate = catalog.get(id);
    if (!gate) throw new PlanningError(`Unknown gate: ${id}`);
    if (gate.severity === 'CONDITIONAL' && !classification.risk_labels.includes(requiredLabel(gate))) {
      throw new PlanningError(`Applicability is unresolved for conditional gate ${id}; provide risk label ${requiredLabel(gate)}`);
    }
    selected.set(id, gate);
  }

  for (const gate of [...selected.values()]) {
    for (const dependencyId of gate.depends_on ?? []) {
      const dependency = catalog.get(dependencyId);
      if (!dependency) throw new PlanningError(`Unknown dependency: ${dependencyId}`);
      selected.set(dependencyId, dependency);
    }
  }

  const ruleIdsByGate = new Map<string, string[]>();
  for (const ruleId of classification.rule_ids) {
    const rule = bundle.registry.rules.find((candidate) => candidate.id === ruleId);
    for (const gateId of rule?.gates ?? []) {
      if (selected.has(gateId)) ruleIdsByGate.set(gateId, [...(ruleIdsByGate.get(gateId) ?? []), ruleId]);
    }
  }

  const gates: PlannedGate[] = topologicalOrder([...selected.values()]).map((gate) => {
    const record = applicableException(exceptions, gate.id);
    const gateRuleIds = [...(ruleIdsByGate.get(gate.id) ?? [])].sort();
    const exceptionCoversGate = record !== undefined && gateRuleIds.length > 0 && gateRuleIds.every((ruleId) => record.rule_ids.includes(ruleId));
    return {
      id: gate.id,
      severity: gate.severity,
      kind: gate.kind,
      ...(gate.command ? { command: gate.command } : {}),
      rule_ids: gateRuleIds,
      depends_on: [...(gate.depends_on ?? [])].sort(),
      ...(exceptionCoversGate ? { exception_id: record.id } : {}),
    };
  });

  return {
    version: 1,
    lane,
    risk_tier: classification.risk_tier,
    expected_platforms: platformSelection.expected_platforms,
    execution_platforms: executionPlatforms,
    platform_reason_codes: platformSelection.platform_reason_codes,
    fallback_full_matrix: platformSelection.fallback_full_matrix,
    platform_mode: platformPolicy ? platformPolicy.mode : 'fallback',
    context: executionContext,
    source_base_revision: sourceBaseRevision,
    source_revision: sourceRevision,
    operation: classification.operation,
    target_environment: classification.target_environment,
    changed_files: classification.changed_files,
    risk_labels: classification.risk_labels,
    route_ids: classification.route_ids,
    rule_ids: classification.rule_ids,
    rule_attestations: await plannedRuleAttestations(bundle, classification.rule_ids),
    approvals: classification.approvals,
    gates,
  };
}

export async function verifyPlan(bundle: ContractBundle, plan: ExecutionPlan, exceptions: ExceptionRecord[], now = new Date()): Promise<void> {
  const classification = classifyChanges(bundle, {
    changed_files: plan.changed_files,
    risk_labels: plan.risk_labels,
    operation: plan.operation,
    target_environment: plan.target_environment,
  });
  const expected = await createPlan(bundle, classification, exceptions, now, plan.source_revision, plan.source_base_revision, plan.context, plan.lane);
  if (stableJson(expected) !== stableJson(plan)) throw new PlanningError('Execution plan does not match canonical contracts and inputs');
}
