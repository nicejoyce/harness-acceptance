# GitHub Harness End-to-End Acceptance Record

## Repository Controls

- Repository: `nicejoyce/harness-acceptance`
- Default branch: `main`
- Independent reviewer: `<record the supplied login>`
- Reviewer permission: `Write`
- Required approvals: `2`
- Required CODEOWNER review: `true`
- Dismiss stale approvals: `true`
- Required Harness Check: `harness-final`
- Expected platform set: `<linux/win32/darwin IDs from signed Plan>`
- Observed platform set: `<platform IDs from signed Evidence>`
- Signed delivery record: `<final-record.md artifact or Check summary URL>`
- Administrator bypass: `disabled`
- Force push and branch deletion: `disabled`
- Branch-protection API evidence: `<URL or response artifact>`

## Signing Configuration

- Active key ID: `<SHA-256 key ID>`
- Signing private material location: repository Actions Secrets, using the identifier declared by the trusted workflow
- Public-key Variable name: `HARNESS_ED25519_PUBLIC_KEYS_JSON`
- Key material exposed in logs or artifacts: `false`

## Scenario Matrix

| Scenario | PR URL | Run ID | Check Run ID | Base SHA | Head SHA | Plan SHA-256 | Key ID | Review ID | Expected Check | Observed Check | Merge blocked/allowed | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| No approval | | | | | | | | n/a | failure | | blocked | |
| Independent APPROVED | | | | | | | | | success | | allowed | |
| New head after approval | | | | | | | | | failure | | blocked | |
| Reapproval of new head | | | | | | | | | success | | allowed | |
| Review dismissed | | | | | | | | | failure | | blocked | |
| CHANGES_REQUESTED | | | | | | | | | failure | | blocked | |
| Context mismatch | | | | | | | | | failure | | blocked | |
| Evidence tampering | | | | | | | | | failure | | blocked | |
| Matrix failure or cancellation | | | | | | | | | failure | | blocked | |
| Unknown signing key ID | | | | | | | | | failure | | blocked | |
| Python non-Node fixture | | | | | | | | | success | | allowed | |
| Author self-approval attempt | | | | | | | | | failure | | blocked | |
| Bot/App review presented as human rule attestation | | | | | | | | | failure | | blocked | |
| Generic review presented as rule attestation | | | | | | | | | failure | | blocked | |
| No-meaning coverage test | | | | | | | | | failure | | blocked | |
| Base implementation does not fail new regression test | | | | | | | | | failure | | blocked | |
| Missing, duplicate, or extra platform Evidence | | | | | | | | | failure | | blocked | |
| Dependency install scripts enabled | | | | | | | | | failure | | blocked | |
| Unknown path classified as low risk | | | | | | | | | failure | | blocked | |

## Five-Dimension Reassessment

| Dimension | Score | Linked evidence | Remaining gap |
|---|---:|---|---|
| Context and knowledge governance | | | |
| Workflow and agent orchestration | | | |
| Verification and trusted evidence | | | |
| Security and risk governance | | | |
| Portability and continuous evolution | | | |

Completion requires every dimension to score at least 9.0 and the arithmetic mean to be at least 9.2.
