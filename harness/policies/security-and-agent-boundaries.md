# Security and Agent Boundaries

## Default Permission Model

Allowed by default: local read-only inspection, static analysis, and tests that use isolated local fixtures with no external side effects.

Approval required before execution: network probing beyond an approved allowlist; production or staging access; credential use; changes to CI, deployment, authentication, authorization, database schema, or public contracts; processing personal or customer data; installation of runtime dependencies; deletion, overwrite, reset, migration, or other destructive actions.

Never perform: credential or private-key disclosure; authentication bypass; account farming; identity/device evasion; circumvention of rate limits, anti-abuse controls, or platform terms; unauthorized traffic interception; hidden data exfiltration; production database mutation without approved runbook.

## Agent Requirements

- State the intended command, target, effect, and approval requirement before a privileged operation.
- Minimize data collection and redact tokens, passwords, personal data, and secrets from logs and reports.
- Stop on ambiguous authority, unexpected data exposure, or a failed safety check.
- Treat external status codes as availability evidence only, not permission to automate a service workflow.
- Preserve user changes and never use destructive version-control commands without explicit authorization.

## Incident Trigger

Stop work, preserve evidence, rotate exposed secrets through the approved owner, and use `templates/incident-record.md` for suspected leakage, unauthorized access, or policy breach.
