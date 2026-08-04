import { minimatch } from 'minimatch';

import type { Classification, ClassificationInput, ContractBundle } from './types.ts';

function normalizeFile(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: false }));
}

export function classifyChanges(bundle: ContractBundle, input: ClassificationInput): Classification {
  const changedFiles = [...new Set(input.changed_files.map(normalizeFile))].sort();
  const routes = bundle.routes.routes
    .filter((route) => changedFiles.some((file) => matches(file, route.include) && !matches(file, route.exclude ?? [])))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    changed_files: changedFiles,
    route_ids: routes.map((route) => route.id),
    rule_ids: [...new Set(routes.flatMap((route) => route.rules))].sort(),
    gate_ids: [...new Set(routes.flatMap((route) => route.gates))].sort(),
    approvals: [...new Set(routes.flatMap((route) => route.approvals))].sort(),
    risk_labels: [...new Set(input.risk_labels ?? [])].sort(),
    operation: input.operation,
    target_environment: input.target_environment,
  };
}
