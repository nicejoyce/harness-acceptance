import type { PlatformId } from './platforms.ts';
import type { FinalResult } from './aggregate.ts';

export interface PlatformAuditResult {
  platform: PlatformId;
  result: 'passed' | 'failed';
  flaky: boolean;
}

export interface PlatformAuditSample {
  sample_id: string;
  commit_sha: string;
  plan_sha256: string;
  predicted_platforms: PlatformId[];
  fallback_full_matrix: boolean;
  full_matrix: PlatformAuditResult[];
  full_matrix_commit_sha: string;
  full_matrix_plan_sha256: string;
}

export interface PlatformMetricsDiagnostic {
  code: 'METRICS_SAMPLE_MISMATCH' | 'METRICS_INVALID';
  sample_id: string;
  message: string;
}

export interface PlatformMetricsReport {
  version: 1;
  valid_samples: number;
  invalid_samples: number;
  false_negative_count: number;
  false_negative_rate: number;
  full_matrix_fallback_rate: number;
  platform_savings: number;
  flaky_failure_rate: number;
  eligible_for_enforcement: boolean;
  diagnostics: PlatformMetricsDiagnostic[];
}

export function platformAuditSampleFromFinal(finalResult: FinalResult, sampleId = finalResult.generated_at): PlatformAuditSample {
  return {
    sample_id: sampleId,
    commit_sha: finalResult.context?.head_sha ?? '',
    plan_sha256: finalResult.plan_sha256,
    predicted_platforms: [...finalResult.expected_platforms],
    fallback_full_matrix: finalResult.fallback_full_matrix,
    full_matrix_commit_sha: finalResult.context?.head_sha ?? '',
    full_matrix_plan_sha256: finalResult.plan_sha256,
    full_matrix: finalResult.evidence.map((item) => ({ platform: item.platform as PlatformId, result: item.result, flaky: false })),
  };
}

export function evaluatePlatformMetrics(samples: PlatformAuditSample[]): PlatformMetricsReport {
  const diagnostics: PlatformMetricsDiagnostic[] = [];
  const valid: PlatformAuditSample[] = [];
  for (const sample of samples) {
    if (sample.full_matrix_commit_sha !== sample.commit_sha) {
      diagnostics.push({ code: 'METRICS_SAMPLE_MISMATCH', sample_id: sample.sample_id, message: 'Full matrix commit does not match predicted sample commit' });
      continue;
    }
    if (sample.full_matrix_plan_sha256 !== sample.plan_sha256) {
      diagnostics.push({ code: 'METRICS_SAMPLE_MISMATCH', sample_id: sample.sample_id, message: 'Full matrix plan does not match predicted sample plan' });
      continue;
    }
    if (new Set(sample.predicted_platforms).size !== sample.predicted_platforms.length || new Set(sample.full_matrix.map((item) => item.platform)).size !== sample.full_matrix.length) {
      diagnostics.push({ code: 'METRICS_INVALID', sample_id: sample.sample_id, message: 'Platform sample contains duplicate platform IDs' });
      continue;
    }
    valid.push(sample);
  }

  let falseNegativeCount = 0;
  let failureCount = 0;
  let flakyFailureCount = 0;
  let predictedCount = 0;
  let fullCount = 0;
  for (const sample of valid) {
    const predicted = new Set(sample.predicted_platforms);
    predictedCount += sample.predicted_platforms.length;
    fullCount += sample.full_matrix.length;
    for (const result of sample.full_matrix) {
      if (result.result !== 'failed') continue;
      failureCount += 1;
      if (result.flaky) flakyFailureCount += 1;
      if (!predicted.has(result.platform) && !result.flaky) falseNegativeCount += 1;
    }
  }
  const validCount = valid.length;
  return {
    version: 1,
    valid_samples: validCount,
    invalid_samples: diagnostics.length,
    false_negative_count: falseNegativeCount,
    false_negative_rate: validCount === 0 ? 0 : falseNegativeCount / validCount,
    full_matrix_fallback_rate: validCount === 0 ? 0 : valid.filter((sample) => sample.fallback_full_matrix).length / validCount,
    platform_savings: fullCount === 0 ? 0 : 1 - predictedCount / fullCount,
    flaky_failure_rate: failureCount === 0 ? 0 : flakyFailureCount / failureCount,
    eligible_for_enforcement: validCount >= 30 && falseNegativeCount === 0,
    diagnostics,
  };
}
