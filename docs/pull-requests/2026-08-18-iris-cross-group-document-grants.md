# Iris Cross-Group Document Grants

## Release Status

Pending live acceptance.

Coverage remains `首个跨群文档回答闭环代码完成，真实验收待执行`. This document does not claim
deployment, real Feishu behavior, or pilot completion.

## Scope

- Adds explicit, versioned, append-only grant/revoke facts for one document source and one grantee
  group.
- Applies grant eligibility before ranking, revalidates before prompt construction, binds the grant
  to the answer receipt, and validates it atomically at begin-send.
- Serializes revoke against active or unknown answer attempts.
- Adds authenticated metadata-only governance, content-free status/readiness, and bounded Admin
  Console controls.
- Keeps the product default-deny because no wildcard exists and an empty active grant set shares
  nothing.

## Automated Evidence

Local verification is complete; exact-SHA CI and live acceptance remain release gates.

| Gate | Result | Metadata-only note |
| --- | --- | --- |
| Focused Core | Pass | 438 passed, 49 environment-gated PostgreSQL skips |
| Full verification | Pass | `npm run verify` exited 0; Core 3462 passed/260 skipped; Python 181 passed |
| PostgreSQL migration/concurrency | Pending CI | Tests collected locally; `IRIS_TEST_DATABASE_URL` is unset, so real-PostgreSQL cases skipped |
| Pilot contracts | Pass | 166 passed; 1 executable Caddy probe skipped because the Docker daemon is unavailable |
| Exact-SHA CI | Pending | SHA and check URLs |

## Live Acceptance Evidence

Use [the acceptance controller](../runbooks/iris-cross-group-document-grants-acceptance.md). Record
only IDs, versions, hashes, counts, timestamps, image digest, and pass/fail facts. The private
artifact remains outside the repository.

| Gate | Result | Allowed evidence |
| --- | --- | --- |
| Exact build/default denial | Pending | SHA, digest, migration/count/timestamp facts |
| Pre-grant grantee/control denial | Pending | message IDs and zero trace/disclosure counts |
| Initial grant | Pending | source/grant/event IDs, version, hashes, timestamp |
| Grantee answer/control denial | Pending | delivery/trace IDs, exact binding versions, counts |
| Prepared-answer revocation | Pending | receipt/event IDs and zero-send counts |
| Begin-send/revoke race | Pending | safe outcome label and counts |
| Regrant/replay | Pending | version/event/delivery counts |
| Default-deny rollback | Pending | stopped/disabled/drained counts and stable fingerprints |

## Default-Deny And Rollback

- No wildcard or implicit relationship authorizes a group.
- Every exit stops Caddy, revokes the pilot grant, disables all three groups and global/capability
  state, drains queues/DLQs/outboxes, and leaves active pilot grant count zero.
- Mutable-state hashes must remain stable across the quiet window; append-only facts must remain.
- A rollback pass cannot convert a failed acceptance into a release pass.

## Explicit Non-Claims

- Cross-group memory and cross-group knowledge drafts remain missing.
- Proactive cross-group use, task creation, Wiki writes, wildcard grants, and broad rollout remain
  out of scope.
- The requirement remains partial until exact-SHA CI and the live three-group controller pass.
