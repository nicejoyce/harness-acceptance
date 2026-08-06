# Reward-Hacking Acceptance Record

Use this record with a trusted base SHA. Every row must link to a reproducible local test or a GitHub run; `skipped` is not an accepted outcome.

| Attack scenario | Local fixture/command | Expected diagnostic or gate | Observed result | Evidence link |
|---|---|---|---|---|
| PR title or body interpolated into `run:` | `workflow-policy check` / `inline-pr-expression.yml` | `UNTRUSTED_RUN_INTERPOLATION` | | |
| Trusted job executes inside PR checkout | `trusted-project-run.yml` | `TRUSTED_JOB_EXECUTES_PR` | | |
| PR data selects command, image, path, or artifact | `pr-controlled-command.yml`, `nested-pr-selection.yml` | `PR_DATA_SELECTS_EXECUTION` | | |
| Tainted environment reaches shell/eval | `tainted-env-execution.yml` | `PR_DATA_SELECTS_EXECUTION` | | |
| Bot/App review impersonates human approval | `agent-attestations.test.ts` | human approval absent; agent record retained | | |
| Generic review impersonates rule attestation | `rule-attestations.test.ts` | `RULE_ATTESTATION_MISSING` | | |
| Approval becomes stale or identity is revoked | `github-approvals.test.ts`, `github-identities.test.ts` | `APPROVAL_INVALID` | | |
| Fast Evidence is promoted to merge Final | `aggregate.test.ts` | Full-lane rejection | | |
| Evidence hash, platform, or approval is forged | `records.test.ts`, `evidence.test.ts` | signed fact mismatch rejection | | |
| Added coverage tests do not fail on base | `regression-proof.test.ts` | base-fail/head-pass proof required | | |
| Meaningless tests or surviving mutants | `coverage.test.ts`, `mutation.test.ts` | coverage/mutation gate failure | | |
| Platform is omitted, duplicated, or invented | `platforms.test.ts`, `aggregate.test.ts` | exact platform-set rejection | | |
| Dependency scripts/native/network capability is enabled | `dependencies.test.ts` | privileged dependency approval | | |
| Unknown path or extension is classified as low risk | `classifier.test.ts`, `platforms.test.ts` | engineering approval/full matrix | | |

## Sign-Off

- Base SHA: `<40-64 hex>`
- Head SHA: `<40-64 hex>`
- Plan SHA-256: `<hash>`
- Evidence SHA-256: `<hashes>`
- Signed Final key ID: `<SHA-256 key ID>`
- Reviewer/attestation IDs: `<references>`
- Remaining external evidence: `<links or explicit blocker>`
