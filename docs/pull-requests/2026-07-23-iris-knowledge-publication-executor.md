# Iris Phase 5B-3 Knowledge Publication Executor

## Scope

This change closes the loop from an approved `publish_knowledge_draft` action proposal to a governed Feishu wiki write.

- Adds the `0035_knowledge_publications.sql` migration for publication facts and execution outcome records.
- Adds a Postgres claim/complete/fail path for approved publication executions.
- Adds runtime gates so publication claims fail closed unless global runtime and `writeKnowledgeBase` are enabled and the source group is not disabled.
- Adds a bounded Feishu wiki/docx publisher.
- Wires the publication executor into the action approval runtime.
- Records publisher failures as `failed` and post-write completion failures as `reconciliation_required`.

The executor remains default-off in production because `writeKnowledgeBase=false`, `IRIS_APPROVAL_ACTIONS_ENABLED=false`, and `IRIS_KNOWLEDGE_CARD_ENABLED=false` are still enforced during deployment.

## Verification

- `git diff --check`: passed.
- `npm --workspace apps/core run typecheck`: passed.
- `npm --workspace apps/core run build`: passed.
- `npm --workspace apps/core test -- --reporter=dot`: 130 files passed, 2 skipped; 2,262 tests passed, 165 skipped.
- `npm run test:python`: 178 passed.
- `npm run pilot:config`: passed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: ready, 16/16 checks passed.
- `npm run test:pilot`: 123 passed.
- GitHub PR #13 checks: Core success, AI Worker success.

## Deployment Evidence

- Candidate SHA: `fc88e80417c1da0b18fdf22b8909b6c3c9bb8078`.
- Core image: `iris-core:fc88e80417c1da0b18fdf22b8909b6c3c9bb8078`.
- AI Worker image: `iris-ai-worker:fc88e80417c1da0b18fdf22b8909b6c3c9bb8078`.
- Backup created before migration: `/opt/iris/repository/backups/iris-20260723T083005Z.bundle.tar.age`.
- Migration `0035_knowledge_publications.sql`: applied once.
- Publication tables present: `knowledge_publications`, `action_executions`.
- Runtime after deploy: `globalEnabled=false`, `desiredGlobalEnabled=false`.
- Capabilities after deploy: `generateKnowledgeDrafts=false`, `writeKnowledgeBase=false`, `proactiveSpeech=false`.
- Caddy after deploy: stopped.
- Event/document/reindex queues and DLQs: zero through `/internal/status`.
- Approval interaction queue: zero by direct Redis count.
- Unsafe publication/action counts: zero.

## Next Gate

The next step is not more generic hardening. The next product gate is a tightly scoped real Feishu acceptance for Phase 5B-3:

1. Keep public ingress closed and runtime disabled.
2. Enable only the pilot group and only the minimum capability needed for publication.
3. Create one approved draft/proposal pair.
4. Confirm the executor writes exactly one Feishu wiki/docx node under the authorized target.
5. Confirm duplicate execution is idempotent and revoked runtime/role gates fail closed.
6. Return runtime to disabled and record zero queue/DLQ counts.

## Real Publication Acceptance - 2026-07-23 / Rechecked 2026-07-24

- Migration `0035_knowledge_publications.sql` was applied exactly once in the pilot database.
- A real Feishu publication succeeded for an approved `publish_knowledge_draft` proposal.
- The successful execution reached `state=succeeded` with provider `feishu_wiki` and response classification `success`.
- The publication fact recorded a Feishu wiki node token, document token, `docx` document type, content hash, target policy, target policy version, and permission check summary.
- The corresponding draft reached `published`; failed publication attempts remained `failed` with bounded classification and did not create publication facts.
- Recheck on 2026-07-24 confirmed current runtime is fail-closed: `globalEnabled=false`, `desiredGlobalEnabled=false`, all known pilot groups disabled, `writeKnowledgeBase=false`, `proactiveSpeech=false`, `callExternalTools=false`.
- Recheck on 2026-07-24 confirmed event/document/reindex pending and DLQ counts are zero, knowledge-card queue/DLQ is zero, and action approval outbox has no pending/processing/outcome_unknown/terminalFailed work.
- Phase 5B-3 is therefore accepted for the first internal pilot write loop. Follow-up work should target bulk publication governance, conflict detection, friendlier publication history, and reconciliation UX rather than extending this acceptance gate.
