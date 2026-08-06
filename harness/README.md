# Enterprise Development Harness

`harness/` is the canonical policy distribution for a stack-neutral executable development harness. Node.js 24 runs the Harness CLI; governed projects may use any frontend, backend, database, language, or build tool.

## Operating Model

1. Read `governance/document-hierarchy.md` and the project profile before changing code.
2. Classify work with `workflows/change-delivery.md`.
3. Obtain approval before any action marked `approval-required` in the profile or policy.
4. Record requirements, ordinary defects, project progress, design decisions, risk, tests, and release evidence using `templates/`; use `governance/record-ownership.md` to route records.
5. Read `policies/code-quality-baseline.md`, `rules/registry.yaml`, and `contracts/quality-baseline.yaml` to determine applicable rules, severity, thresholds, and evidence.
6. Run the project-profile commands selected by the quality gates; attach actual output to the PR or release record.

## Safety Defaults

- Local, read-only inspection is allowed by default.
- Network calls, production access, credentials, destructive actions, user-data operations, and third-party side effects require explicit approval.
- Never automate account creation, identity evasion, security bypass, data scraping, or terms-of-service circumvention.
- A failed or unavailable check blocks its gate; it is never silently reported as passing.

## Bootstrap

```powershell
npm ci
npm run harness -- validate --root harness
npm run harness -- plan --root harness --changed-file src/example.ts --operation merge --environment test --output .harness/plan.json
npm run harness -- run --root harness --plan .harness/plan.json --output .harness/evidence
npm run harness -- evidence verify --root harness --manifest .harness/evidence/manifest.json
```

Commands are structured as `executable` plus `args`; implicit shell execution is forbidden. `validate`, `plan`, `run`, and `evidence verify` are implemented once in TypeScript and used locally and in CI.

Runtime credentials must be named in `inherited_environment` and, when sensitive, in `sensitive_environment`. Sensitive values must never be stored in `environment` or committed to the project profile; contract validation rejects that configuration.

For GitHub pull requests, configure `approvals.roles` with authorized GitHub login names. The workflow converts commit-bound `APPROVED` reviews into structured approval records through `approvals github` only when a trusted identity snapshot reports `user.type === User`, current organization membership or repository collaborator permission, and a reviewer distinct from the PR author. Bot/App reviews remain audit-only Agent attestations. A later `CHANGES_REQUESTED`, `DISMISSED`, or identity revocation removes approval. Approval records are bound to the repository, pull request, review ID, and plan commit. Conditional gates are fail-closed and require the corresponding `*-required` pull-request label. Evidence verification must use the canonical Harness root, not the evidence directory.

Git-bound plans require a non-empty base/head diff, the exact current `HEAD`, the exact changed-file set, and a checkout with no tracked, staged, untracked, or ignored files before project commands run. Stable CLI exit codes are `0` success, `1` internal error, `2` invalid contracts, `3` planning or Git-context failure, `4` ordinary gate failure, `5` invalid evidence, `6` gate timeout, and `7` cancellation.

`evidence verify` proves schema, digest, canonical-plan, approval, exception, and repository consistency. SHA-256 digests are not signatures and do not independently prove that a command ran. GitHub uses a trusted `prepare-context` Job, credential-free project matrix, and trusted `harness-final` Job to recompute and sign one final result with Ed25519. See `governance/trusted-execution.md` for context binding, key custody, verification, rotation, and branch-protection requirements.

Platform selection is computed by the protected base Plan. Ordinary changes predict Linux; Windows path/process semantics and macOS permission semantics add their platform, while control-plane, release, lockfile, unknown, or policy failures use the full `linux/win32/darwin` matrix. The current policy is Shadow Mode: all execution platforms still run and `platform-sample.json` records the prediction, full results, commit SHA, and Plan digest. At least 30 paired samples with zero non-flaky false negatives are required before platform omission can be enabled.

`records render` verifies the signed Final and Evidence before generating a delivery record. Hashes, gates, approvals, platforms, thresholds, tool versions, and the signing key ID are derived facts; objective, design motivation, risk judgment, business rationale, and rollback decision remain empty human-authored fields. The optional `harness-service` exposes only validate, plan, evidence verification, and an isolated server-side hidden-test endpoint; it never accepts arbitrary shell commands or treats MCP as a trust root.

## Layout

- `config/`: project-specific facts and approved commands
- `contracts/`: measurable quality gates
- `governance/`: authority and record rules
- `policies/`: non-negotiable safety and engineering boundaries
- `rules/`: module-owned mandatory rules and stack adaptation
- `enforcement/`: interfaces for hooks, CI, scanning, and coverage gates
- `skills/`: setup, debug, review, release, and incident workflows
- `workflows/`: repeatable delivery and response paths
- `templates/`: auditable records
- `scripts/`: compatibility wrappers for the TypeScript CLI
- `tests/`: contract checks for the harness itself
