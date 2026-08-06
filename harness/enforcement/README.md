# Enforcement Interfaces

Progress from local checks to pre-commit, CI gates, branch protection, and release approval. Map SEC/DATA/BOUND to secret/SAST/API tests; ARCH to complexity/boundary/ADR checks; TEST to coverage and artifacts; DEP to locked install/SBOM/license/container scans; OPS/DOC/AI to records, approvals, and audit logs. Examples are interfaces only; project profile binds actual tools.

The executable P0 path is `.github/workflows/harness.yml`. Configure only `harness-final` as the required Harness Check and require two independent non-author CODEOWNER approvals. `prepare-context` creates the canonical Plan and approvals from the protected base; credential-free `harness` matrix jobs execute project commands and emit untrusted Evidence; `harness-final` fetches current reviews, verifies all context-bound Evidence, recomputes the result, signs it with Ed25519, and publishes the stable Check.

Local SHA-256 verification detects inconsistent or modified artifacts but is not an execution signature. Verify `final.signed.json` with `final verify` and an externally obtained `HARNESS_ED25519_PUBLIC_KEYS_JSON`. The trust claim is valid only while the base workflow, branch protection, CODEOWNERS, signing key, public-key configuration, and repository permissions remain protected. See `../governance/trusted-execution.md`.
