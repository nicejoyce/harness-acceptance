# Document Trigger Matrix

| Record | Read when | Update when | Owner |
|---|---|---|---|
| Project profile | Every change and before project commands | Toolchain, environment, owner, or approval boundary changes | Platform/Agent |
| Requirement | New feature, unclear scope, acceptance | Requirement scope or status changes | Product/Engineering |
| Bug tracker | A reported defect, before starting its repair, and before verification | Defect status, impact, root cause, owner, fix, or verification evidence changes | Engineering/QA |
| Design and ADR | Non-trivial behavior, contract, or architecture | Design or decision changes | Architecture |
| Risk and test plan | Data, external service, auth, schema, CI, deployment, or key journey change | Risk, evidence, or approval changes | Security/QA |
| Review and release records | Before merge or release | Gate, exception, artifact, monitoring, or rollback changes | Reviewer/Release owner |
| Incident record | Suspected leak, unauthorized access, or material failure | Timeline, status, or corrective action changes | Incident commander |
| Project progress | Project reviews, delivery planning, milestone decisions, and release readiness reviews | Phase, milestone, overall status, forecast, material risk, blocker, dependency, or release readiness changes; at least once per reporting cycle | Delivery owner |

Ordinary defects use the bug tracker; security, data, or material operational incidents use the incident record, with linked records when both apply. Update affected documentation in the same change when commands, rules, or project facts change. Never mark unverified work complete.
