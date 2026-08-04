# Infrastructure and Delivery Rules

- Dependencies, lock files, vulnerabilities, reproducible builds, and immutable artifacts follow `DEP-*`.
- Releases, configuration, monitoring, capacity, rollback, incidents, and drills follow `OPS-*`.
- CI runs configured applicable gates: format, lint, typecheck, unit, build, security, plus conditional integration, E2E, migration, privacy, and container checks.
- CI, deployment, runtime dependency, schema, auth, and public contract changes require approval before execution.
