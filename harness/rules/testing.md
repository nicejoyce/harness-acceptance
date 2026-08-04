# Testing Rules

- Unit tests are deterministic, isolated, and verify success, boundary, and failure behavior under `TEST-001`, `TEST-002`, and `TEST-007`.
- Integration tests use owned, isolated, cleanable components and no third-party business side effects under `TEST-003` and `TEST-009`.
- E2E covers a key journey and both visible and backend state under `TEST-004`.
- Changed lines require 80% coverage; auth, authorization, payment, deletion, and security code require 90%; total coverage cannot decline under `TEST-005` and `TEST-006`.
- Failed, skipped, absent, or unavailable tests block merge absent a valid exception under `TEST-008`.
