# Change Review Record: <title>

## Human-Authored Responsibility

Objective: <what outcome is required>
Design motivation: <why this approach was chosen>
Risk judgment: <owner assessment>
Business rationale: <business reason>
Rollback decision: <when and how to roll back>

## Signed Harness Facts

Do not hand-edit pass/fail state, hashes, platforms, gates, thresholds, tool versions, or approval references. Generate this section with:

`harness records render --manifest <manifest> --final <signed-final> --format markdown`

<!-- harness-signed-facts:start -->
<generated signed facts>
<!-- harness-signed-facts:end -->

## Supporting Records

Risk record: <path>
Design record: <path>
Release or rollback record: <path>
