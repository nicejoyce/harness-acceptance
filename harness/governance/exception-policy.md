# Quality Gate Exception Policy

Only `REQUIRED` and `CONDITIONAL` rules may receive an exception. `BLOCKER` rules cannot be waived.

Each exception records rule ID, scope, business reason, risk, compensating control, verification evidence, approver, creation date, expiry, review date, and removal plan. Maximum validity is 30 days. An expired, incomplete, unapproved, or unverifiable exception restores the blocking gate. Exceptions cannot bypass law, platform terms, authentication/authorization, security redlines, or production-access approval.
