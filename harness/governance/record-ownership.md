# Record Ownership and Routing

Each concern has one authoritative record. Other documents may summarize it, but must link back and must not create a conflicting status.

| Concern | Authoritative Record | Use It When | Must Not Replace |
|---|---|---|---|
| Product scope and planned non-defect work | Requirement record | A feature, maintenance, security, or operational request is accepted | Bug tracker or project progress |
| Ordinary defect | Bug tracker | Existing behavior does not meet its stated or observable expectation | Incident record |
| Security, data, or material operational incident | Incident record | Suspected leak, unauthorized access, data exposure, or material service failure | Bug tracker; link both when a defect caused the incident |
| Project phase, milestone, forecast, risks, and blockers | Project progress | A cross-work-item delivery status needs reporting | Requirement, bug, incident, or release evidence |
| Technical decision | ADR | A consequential technical trade-off is accepted | Design or progress record |
| Behavior or architecture design | Design record | Non-trivial behavior, contract, or architecture changes | Requirement or progress record |
| Verification strategy and evidence | Test plan and recorded command output | Tests, scans, reviews, or other gates run | A status claim without evidence |
| Release readiness and execution | Release record | A release is planned, approved, or performed | Project progress |

## Routing Rules

1. Split mixed requests into the relevant records before implementation.
2. Link records when one concern affects another; retain the detailed history only in its authoritative record.
3. Resolve conflicting status by the document hierarchy and the most recent verified evidence. A dashboard or progress summary never overrides the source record.
