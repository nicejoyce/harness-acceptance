export interface MutationSmokeInput { total: number; killed: number; timeout: number; equivalent: number; changed_modules: string[] }
export interface MutationSmokeResult { valid: boolean; score: number; total: number; killed: number; timeout: number; equivalent: number }

export function evaluateMutationSmoke(input: MutationSmokeInput): MutationSmokeResult {
  const score = input.total > 0 ? Number(((input.killed / input.total) * 100).toFixed(2)) : 0;
  return {
    valid: input.total > 0 && input.changed_modules.length > 0 && input.killed === input.total && input.timeout === 0,
    score, total: input.total, killed: input.killed, timeout: input.timeout, equivalent: input.equivalent,
  };
}

export function evaluateStrykerReport(report: unknown, changedModules: string[], threshold: number): MutationSmokeResult {
  const files = (report as { files?: Record<string, { mutants?: Array<{ status?: string }> }> })?.files ?? {};
  const selected = new Set(changedModules.map((file) => file.replaceAll('\\', '/')));
  const statuses = Object.entries(files).flatMap(([file, value]) => selected.has(file.replaceAll('\\', '/')) ? (value.mutants ?? []).map((mutant) => mutant.status ?? 'Unknown') : []);
  const killed = statuses.filter((status) => status === 'Killed').length;
  const timeout = statuses.filter((status) => status === 'Timeout').length;
  const equivalent = statuses.filter((status) => status === 'Ignored').length;
  const total = statuses.length;
  const score = total > 0 ? Number(((killed / total) * 100).toFixed(2)) : 0;
  return { valid: total > 0 && score >= threshold && timeout === 0, score, total, killed, timeout, equivalent };
}
