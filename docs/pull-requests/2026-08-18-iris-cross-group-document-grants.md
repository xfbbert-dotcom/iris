# Iris Cross-Group Document Grants

## Release Status

Live acceptance passed; ready for integration.

Coverage advances to `首个跨群文档回答闭环已实现（默认拒绝）`. The exact reviewed build was
exercised in three real Feishu groups and returned to default-deny. This does not claim broad rollout
or completion of the wider cross-group memory, draft, and action scope.

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

Local verification and exact-SHA CI are complete.

| Gate | Result | Metadata-only note |
| --- | --- | --- |
| Focused Core | Pass | 438 passed, 49 environment-gated PostgreSQL skips |
| Full verification | Pass | `npm run verify` exited 0; Core 3462 passed/260 skipped; Python 181 passed |
| PostgreSQL migration/concurrency | Pass | Exact-SHA CI ran `Test Postgres integrations` successfully |
| Pilot contracts | Pass | 172 passed; 1 executable Caddy probe skipped because the Docker daemon is unavailable |
| Exact-SHA CI | Pass | [`f1e8d96f` CI run 32131906475](https://github.com/xfbbert-dotcom/iris/actions/runs/32131906475); Core and AI Worker passed |

## Live Acceptance Evidence

The live run occurred from `2026-08-18T11:53:15.887Z` through `2026-08-18T12:01:45.932Z`.
Its original terminal summary was not retained, so on `2026-08-19` the metadata-only attestation was
reconstructed from append-only PostgreSQL facts and live Feishu reply readback. The recovery
validator reported `result=pass`, `failedStep=null`, and `rollbackPass=true`; the private artifact
remains outside the repository with SHA-256
`8374bb0d304f68ae5a3094793909f353e93a24059465aa541f7885cdea0cc147`.

| Gate | Result | Allowed evidence |
| --- | --- | --- |
| Exact build/default denial | Pass | SHA `f1e8d96fbd29f5dc1cdabc8e309f0d24a516916e`; Core image `sha256:9e10ba9a30ec8858543733cb6729da0c3b3870a5bc7f952598ecf7f829244dba`; migration count 1; reviewed encrypted backup present |
| Pre-grant grantee/control denial | Pass | Two unique incoming messages, one delivery each, zero pilot-source traces, and both provider replies excluded the target marker |
| Initial grant | Pass | One append-only `12 -> 13` grant event for the exact source/grantor/grantee projection |
| Grantee answer/control denial | Pass | Grantee had one delivery whose pilot-source traces were all bound to grant version 13; control had zero pilot-source traces; provider reply readback matched both outcomes |
| Prepared-answer revocation | Pass | Exact-SHA PostgreSQL integration gate passed; live `13 -> 14` revoke followed by a grantee reply with zero pilot-source traces and no target-marker disclosure |
| Begin-send/revoke race | Pass | Exact-SHA PostgreSQL serialization tests passed and reject send-after-revoke |
| Regrant/replay | Pass | One append-only `14 -> 15` grant event, one bound grantee delivery, no duplicate event/delivery, target marker visible only to the grantee, and control remained denied |
| Default-deny rollback | Pass | Final `15 -> 16` revoke; Caddy stopped; global and all capabilities disabled; active pilot grants, pending/DLQ/outbox work, and unresolved deliveries all zero; five-second mutable fingerprint stable |

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
- The answer-only first loop is closed, but the wider IRIS-CORE-004 ambition remains partial until
  the explicitly excluded cross-group capabilities are designed, implemented, and separately
  accepted.
