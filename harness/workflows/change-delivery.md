# Change Delivery Workflow

## 1. Intake and Classification

Classify each request as defect, feature, maintenance, security, operational change, or investigation. Create a requirement record for non-defects. Record an ordinary defect in the bug tracker before repair; create an incident record for a suspected leak, unauthorized access, data exposure, or material operational failure. When a defect causes an incident, link both records. Split mixed work into separately reviewable records.

## 2. Plan and Approve

Create a design record for non-trivial behavior, architecture, or contract changes. Complete a risk assessment before work that handles data, credentials, external services, schema, CI, deployment, authentication, or authorization. Obtain required approval before execution, not after.

## 3. Implement and Verify

Implement in a focused change. Add tests before behavior changes where practical. Run the applicable quality gates from the project profile. Record exact commands, environment, result, and known gaps in the PR record.

## 4. Review and Release

Peer review verifies scope, security boundaries, tests, documentation, and rollback. Releases require a release record with owner, artifact identifier, monitoring signals, rollback steps, and approval evidence. Update project progress when a milestone, forecast, material risk, blocker, dependency, or release readiness changes.

## 5. Exception Handling

An exception is time-bounded and includes the failed gate, reason, risk, compensating control, approver, and expiry. Expired exceptions block delivery until renewed or removed.
