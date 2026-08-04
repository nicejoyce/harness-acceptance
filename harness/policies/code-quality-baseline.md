# Enterprise Code Quality Baseline

This is a technology-neutral minimum. `rules/registry.yaml` is authoritative for IDs, severity, evidence, and exceptions. Stack rules may add constraints but cannot weaken this baseline.

## Modules

- `SEC-*`: secrets, authentication, authorization, auditability, error redaction, and privacy review.
- `DATA-*`: synthetic or redacted data, parameter binding, identifier allowlists, safe migrations, retention, and resource-bounded data access.
- `BOUND-*`: input/file/URL validation, allowlists, timeout/cancellation/limited retries, no shell concatenation or dynamic code execution.
- `ARCH-*`: composition first, useful abstractions, directional dependencies, bounded complexity, explicit contracts, and no swallowed errors.
- `API-*`: documented contracts, idempotency, bounded collections, contract tests, resilient asynchronous processing, and third-party authorization.
- `UI-*`: server-side authority, complete async states, safe validation, accessibility, no sensitive browser persistence, and high-risk confirmations.
- `TEST-*`: deterministic isolation, owned integration dependencies, key-journey E2E, changed-line coverage at 80%, critical security coverage at 90%, and evidence-based assertions.
- `DEP-*`: controlled dependencies, blocking critical/high vulnerabilities, reproducible immutable builds, and secure conditional container use.
- `OPS-*`: release ownership, rollback, configuration separation, observability, capacity/degradation, and incident stop-work rules.
- `DOC-*`: truthful status, synchronized documentation, traceable approvals, comprehensive review, conflict handling, and evidence.
- `AI-*`: declared write scope, explicit authority, preservation of user changes, evidence before success claims, and learning capture.
