# Data and Dependency Policy

## Data

- Classify data before collection: public, internal, confidential, restricted.
- Use synthetic or explicitly owned test data. Do not put production data, credentials, or personal data into fixtures, logs, screenshots, or documentation.
- Define retention, access owner, encryption, deletion, and export controls for confidential or restricted data.
- Perform privacy review before adding telemetry, analytics, data export, or a new processor.

## Dependencies

- Reinstalling an already reviewed lockfile with the approved registry, install scripts disabled, no new native modules, and no new network capability is a preauthorized operation; it is not a dependency-graph change.
- Any manifest, lockfile, registry, install-script, native-module, or network-capability change is a privileged dependency change and requires approval.
- Lockfile integrity, license, SBOM, vulnerability-scan, and install-script-scan evidence must be present. Missing or unknown evidence fails closed.
- Add only pinned, justified dependencies from approved sources.
- Review license, maintenance, vulnerability posture, transitive impact, and replacement plan before adding a runtime dependency.
- Update manifest and lock file only through the approved package manager.
- Record exceptions to known vulnerabilities with owner, compensating control, and expiry.
