import type { EvidenceManifest } from './types.ts';

export const ExitCode = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  CONTRACT_INVALID: 2,
  PLANNING_FAILED: 3,
  GATE_FAILED: 4,
  EVIDENCE_INVALID: 5,
  GATE_TIMED_OUT: 6,
  RUN_CANCELLED: 7,
} as const;

export function exitCodeForManifest(manifest: EvidenceManifest): number {
  if (manifest.gates.some((gate) => gate.state === 'cancelled')) return ExitCode.RUN_CANCELLED;
  if (manifest.gates.some((gate) => gate.state === 'timed_out')) return ExitCode.GATE_TIMED_OUT;
  return manifest.result === 'passed' ? ExitCode.SUCCESS : ExitCode.GATE_FAILED;
}
