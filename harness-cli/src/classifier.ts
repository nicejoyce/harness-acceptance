import { minimatch } from 'minimatch';

import type { Classification, ClassificationInput, ContractBundle, RiskTier, RouteDefinition } from './types.ts';

const riskRank: Record<RiskTier, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function normalizeFile(file: string): string {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) throw new Error(`Unsafe path for classification: ${file}`);
  return normalized;
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: false }));
}

export function classifyChanges(bundle: ContractBundle, input: ClassificationInput): Classification {
  const changedFiles = [...new Set(input.changed_files.map(normalizeFile))].sort();
  const byId = new Map(bundle.routes.routes.map((route) => [route.id, route]));
  const selected = new Map<string, RouteDefinition>();
  let unknown = false;
  const selectWithParents = (route: RouteDefinition, visiting = new Set<string>()): void => {
    if (selected.has(route.id)) return;
    if (visiting.has(route.id)) throw new Error(`Route inheritance cycle: ${route.id}`);
    visiting.add(route.id);
    if (route.extends) {
      const parent = byId.get(route.extends);
      if (!parent) throw new Error(`Unknown extended route: ${route.extends}`);
      selectWithParents(parent, visiting);
    }
    selected.set(route.id, route);
  };
  for (const file of changedFiles) {
    const explicit = bundle.routes.routes.filter((route) => !route.fallback && matches(file, route.include) && !matches(file, route.exclude ?? []));
    const routes = explicit.length > 0 ? explicit : bundle.routes.routes.filter((route) => route.fallback && matches(file, route.include) && !matches(file, route.exclude ?? []));
    if (explicit.length === 0) unknown = true;
    for (const route of routes) selectWithParents(route);
  }
  const routes = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
  const riskTier = routes.reduce<RiskTier>((highest, route) => riskRank[route.risk_tier ?? 'medium'] > riskRank[highest] ? (route.risk_tier ?? 'medium') : highest, 'low');

  return {
    changed_files: changedFiles,
    route_ids: routes.map((route) => route.id),
    rule_ids: [...new Set(routes.flatMap((route) => route.rules))].sort(),
    gate_ids: [...new Set(routes.flatMap((route) => route.gates))].sort(),
    approvals: [...new Set([...routes.flatMap((route) => route.approvals), ...(unknown ? ['engineering'] : [])])].sort(),
    risk_labels: [...new Set(input.risk_labels ?? [])].sort(),
    operation: input.operation,
    target_environment: input.target_environment,
    risk_tier: riskTier,
  };
}
