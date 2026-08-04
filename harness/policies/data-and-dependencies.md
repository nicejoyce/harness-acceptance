# Data and Dependency Policy

## Data

- Classify data before collection: public, internal, confidential, restricted.
- Use synthetic or explicitly owned test data. Do not put production data, credentials, or personal data into fixtures, logs, screenshots, or documentation.
- Define retention, access owner, encryption, deletion, and export controls for confidential or restricted data.
- Perform privacy review before adding telemetry, analytics, data export, or a new processor.

## Dependencies

- Add only pinned, justified dependencies from approved sources.
- Review license, maintenance, vulnerability posture, transitive impact, and replacement plan before adding a runtime dependency.
- Update manifest and lock file only through the approved package manager.
- Record exceptions to known vulnerabilities with owner, compensating control, and expiry.
