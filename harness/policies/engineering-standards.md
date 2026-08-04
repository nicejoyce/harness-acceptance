# Engineering Standards

- Pin and review dependency versions through the approved package manager; do not hand-edit lock files.
- Define input validation, timeouts, cancellation, error propagation, and resource cleanup at every external boundary.
- Keep public contracts versioned and backward-compatible or document a migration and deprecation plan.
- Use least privilege, parameterized data access, encrypted secrets storage, and structured logs without secrets.
- Keep unit tests deterministic. Put integration and E2E tests behind explicit environments and test data ownership.
- Prefer reproducible builds; record tool versions, artifact digest, and verification evidence for releases.
- Require a human peer review for material changes and security review for high-risk changes.
