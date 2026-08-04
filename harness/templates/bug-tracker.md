# Bug Tracker

> Record defects: existing behavior, design, or implementation does not meet its stated or observable expectation.
> Lifecycle: `Open` -> `In Progress` -> `Fixed` -> `Verified` -> `Closed`.

## Active Bugs

| Bug ID | Component / Requirement | Severity | Root Cause Category | Status | Reported | Owner | Summary |
|---|---|---|---|---|---|---|---|
| BUG-<id> | <component or requirement> | Critical \| High \| Medium \| Low | <category> | Open \| In Progress | <YYYY-MM-DD> | <owner> | <short description> |

## Closed History

| Bug ID | Component / Requirement | Root Cause Category | Status | Reported | Fixed | Verified | Summary |
|---|---|---|---|---|---|---|---|
| BUG-<id> | <component or requirement> | <category> | Closed | <YYYY-MM-DD> | <YYYY-MM-DD> | <YYYY-MM-DD> | <short description> |

## Bug Detail: BUG-<id> <title>

- **Affected component / requirement:** <component or requirement>
- **Severity and priority:** <severity / priority>
- **Reported by / date:** <person or source / YYYY-MM-DD>
- **Owner:** <owner>
- **Status:** Open | In Progress | Fixed | Verified | Closed
- **Environment and version:** <environment / version>

### Symptom and Reproduction

<Observed result, expected result, and deterministic reproduction steps.>

### Impact and Root Cause

<Affected users, data, security or operational impact, followed by the root-cause category and analysis.>

### Resolution and Verification

<Fix location, regression test or other evidence, verifier, verification date, and any residual risk.>

## Operating Rules

- This tracker is the authoritative record for ordinary defects; assign a unique `BUG-<id>` and update the matching active or closed table in the same change.
- A security incident, suspected data exposure, unauthorized access, or material service failure also requires an incident record; do not replace it with this tracker.
- Link related requirement, design, risk, test, release, and incident records. Do not include secrets, personal data, or production logs without approved redaction.
