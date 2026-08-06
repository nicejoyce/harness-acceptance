import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePlatformMetrics, platformAuditSampleFromFinal, type PlatformAuditSample } from '../src/platform-metrics.ts';

function sample(index: number, overrides: Partial<PlatformAuditSample> = {}): PlatformAuditSample {
  return {
    commit_sha: 'a'.repeat(40),
    plan_sha256: 'b'.repeat(64),
    predicted_platforms: ['linux'],
    fallback_full_matrix: false,
    full_matrix: [
      { platform: 'linux', result: 'passed', flaky: false },
      { platform: 'win32', result: 'passed', flaky: false },
      { platform: 'darwin', result: 'passed', flaky: false },
    ],
    sample_id: `sample-${index}`,
    full_matrix_commit_sha: 'a'.repeat(40),
    full_matrix_plan_sha256: 'b'.repeat(64),
    ...overrides,
  };
}

test('keeps Shadow Mode eligible only after 30 same-plan samples with zero non-flaky false negatives', () => {
  const samples = Array.from({ length: 29 }, (_, index) => sample(index));
  let report = evaluatePlatformMetrics(samples);
  assert.equal(report.valid_samples, 29);
  assert.equal(report.eligible_for_enforcement, false);
  report = evaluatePlatformMetrics([...samples, sample(29)]);
  assert.equal(report.valid_samples, 30);
  assert.equal(report.false_negative_rate, 0);
  assert.equal(report.eligible_for_enforcement, true);
});

test('derives a Shadow Mode sample from the signed Final payload', () => {
  const sample = platformAuditSampleFromFinal({
    version: 1,
    context: { repository: 'org/repo', pull_request: 1, base_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40) },
    generated_at: '2026-08-06T00:00:00.000Z',
    check_name: 'harness-final',
    job_conclusion: 'success',
    plan_sha256: 'c'.repeat(64),
    expected_platforms: ['linux'],
    execution_platforms: ['linux', 'win32', 'darwin'],
    platform_reason_codes: ['platform.baseline'],
    fallback_full_matrix: false,
    platform_mode: 'shadow',
    evidence: [{ platform: 'linux', manifest_sha256: 'd'.repeat(64), result: 'passed' }, { platform: 'win32', manifest_sha256: 'e'.repeat(64), result: 'passed' }, { platform: 'darwin', manifest_sha256: 'f'.repeat(64), result: 'passed' }],
    approvals: [],
    thresholds: [],
    result: 'passed',
  });
  assert.deepEqual(sample.predicted_platforms, ['linux']);
  assert.equal(sample.full_matrix_commit_sha, sample.commit_sha);
  assert.equal(sample.full_matrix_plan_sha256, sample.plan_sha256);
});

test('counts omitted-platform failures as false negatives but keeps flaky failures separate', () => {
  const samples = [
    sample(1, { full_matrix: [{ platform: 'linux', result: 'passed', flaky: false }, { platform: 'win32', result: 'failed', flaky: false }, { platform: 'darwin', result: 'passed', flaky: false }] }),
    sample(2, { full_matrix: [{ platform: 'linux', result: 'passed', flaky: false }, { platform: 'win32', result: 'failed', flaky: true }, { platform: 'darwin', result: 'passed', flaky: false }] }),
  ];
  const report = evaluatePlatformMetrics(samples);
  assert.equal(report.false_negative_count, 1);
  assert.equal(report.false_negative_rate, 0.5);
  assert.equal(report.flaky_failure_rate, 0.5);
  assert.equal(report.eligible_for_enforcement, false);
});

test('excludes samples whose commit or plan does not match its paired full matrix', () => {
  const report = evaluatePlatformMetrics([
    sample(1),
    sample(2, { full_matrix_plan_sha256: 'c'.repeat(64) }),
    sample(3, { full_matrix_commit_sha: 'd'.repeat(40) }),
  ]);
  assert.equal(report.valid_samples, 1);
  assert.equal(report.invalid_samples, 2);
  assert.ok(report.diagnostics.every((item: { code: string }) => item.code === 'METRICS_SAMPLE_MISMATCH'));
});
