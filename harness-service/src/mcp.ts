import type { HarnessServiceCore } from './server.ts';

export function createHarnessMcpTools(core: HarnessServiceCore): Record<string, (input: unknown) => Promise<unknown>> {
  return {
    validate: core.validate,
    plan: core.plan,
    evidence_verify: core.evidenceVerify,
  };
}
