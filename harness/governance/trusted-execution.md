# Trusted Execution

This document is the authority for GitHub CI trust. Local `evidence verify` detects inconsistent artifacts, but only the protected GitHub workflow can produce the signed final decision.

## Job Boundaries

1. `prepare-context` is trusted. It runs Harness code and contracts from the protected base SHA, reads current GitHub reviews, builds the immutable Plan, and bundles the PR source without executing project commands.
2. `harness` is untrusted project execution. Its matrix jobs use `permissions: {}`, receive no `GH_TOKEN` or OIDC credential, recreate a clean checkout, and emit Evidence outside the project repository.
3. `harness-final` is trusted. It fetches current reviews again, validates every Evidence manifest against canonical base contracts and GitHub job conclusions, recomputes the result, signs it, verifies it against an external trust anchor, and publishes the only stable Check named `harness-final`.

An untrusted Evidence manifest is input data, never the final trust decision. A missing, skipped, cancelled, malformed, mismatched, or failed input fails closed.

## Immutable Context

GitHub-bound Plan, Run, Evidence verification, and Final aggregation all require the same `repository`, `pull_request`, `base_sha`, and `head_sha`. The declared head must equal the checkout `HEAD`; the base/head diff and changed-file set must match exactly. Any mismatch invalidates the run.

Execution starts from a clean checkout. The Harness rejects tracked, staged, untracked, and ignored files present before project commands run. Dependency preparation is the profile-declared `gate.setup`; generated dependencies may appear only after the clean check. Evidence is written outside the project checkout.

## Ed25519 Trust Anchors

The final Job reads the active PKCS8 DER Base64 private key from the Actions Secret `HARNESS_ED25519_PRIVATE_KEY_B64`. It must never be committed, stored in an artifact, printed, or exposed to project jobs.

Trusted SPKI DER Base64 public keys are supplied through the repository variable `HARNESS_ED25519_PUBLIC_KEYS_JSON`. Its JSON object maps each lowercase SHA-256 `key_id` to one public key. `final verify` selects the external key by the envelope `key_id`, rejects unknown IDs and non-Ed25519 keys, and never trusts key material supplied by the signed artifact. `HARNESS_ED25519_PUBLIC_KEY_B64` remains a one-key compatibility input for one migration cycle.

Rotate keys in this order: add the new public key to the keyring, replace the private-key Secret, verify that a new run uses the new `key_id`, wait for in-flight runs to finish, then remove the old public key. On suspected disclosure, remove the affected public key, rotate the private key, rerun affected pull requests, and create an incident record.

Verify a downloaded signed result with a separately obtained public-key configuration:

```powershell
$env:HARNESS_ED25519_PUBLIC_KEYS_JSON = '<trusted key_id-to-public-key JSON>'
npm run harness -- final verify --input final.signed.json --json
```

## Repository Enforcement

Protect the default branch, require one non-author CODEOWNER approval, dismiss stale approvals after new commits, require resolved conversations and an up-to-date branch, block force pushes and deletion, and disallow bypass. Configure `harness-final` as the only required Harness Check; matrix checks remain diagnostic.

Trust depends on the base workflow, CODEOWNERS, contracts, repository permissions, signing Secret, public keyring, and branch rules remaining protected from the PR author.
