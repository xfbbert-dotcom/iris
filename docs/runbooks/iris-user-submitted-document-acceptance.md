# Iris User-Submitted Document Real-Feishu Acceptance

This runbook closes the remaining employee-facing document loop for the first 20-30 person
internal MVP. It verifies that an employee can explicitly give Iris a new Feishu document, Iris
registers and syncs it without using the answer model, and a later answer can retrieve and cite the
document.

This is a bounded pilot procedure. It does not authorize a daily rollout or cross-group sharing.

## Exit Criteria

The gate passes only when all of the following are true:

1. The submitted URL was not already present in the document-source registry.
2. The pilot user shares the document with the Iris app before submission.
3. A real pilot-group message matching `@Iris 请收录这个文档 <URL>` produces the bounded receipt
   confirmation.
4. Exactly one `user_submitted_document` source exists for the canonical URL and contains the
   submitting user evidence.
5. Document sync reaches `synced`, permission state reaches `allowed`, and an indexed snapshot is
   available.
6. A later real `@Iris` question returns the unique marker from that document and cites the same
   source.
7. A control group cannot retrieve the marker.
8. Event, document-sync, reindex, and approval-interaction queues and DLQs return to zero.
9. Cleanup restores global and desired-global runtime disabled, every known group disabled, Caddy
   stopped, and all unrelated default-off capabilities unchanged.

Any missing permission, unsupported URL, stale queue, duplicate source, cross-group result, or
answer without the submitted source fails the gate.

## Pilot Fixture

Create a new Feishu docx document that Iris has never seen. Put only bounded non-sensitive test
content in it:

```text
Iris user document acceptance
Acceptance marker: IRIS_USER_DOC_<YYYYMMDD>_<6 random digits>
This marker exists only for the user-submitted document acceptance.
```

Grant the Iris app read access to that document. Record the canonical docx URL and marker in the
private deployment log. Do not place credentials, personal data, or production secrets in the
fixture.

## Fail-Closed Preflight

Before opening public ingress, verify read-only:

- the intended candidate SHA and both Core/AI Worker image SHAs are exact;
- required GitHub checks are successful;
- `globalEnabled=false` and `desiredGlobalEnabled=false`;
- every known group, including pilot and control groups, is disabled;
- `proactiveSpeech=false`;
- proactive planning/delivery, memory extraction, and knowledge publication execution remain
  disabled unless separately required by another approved gate;
- Caddy is stopped;
- Core, Postgres, Redis, and AI Worker are healthy;
- event, document-sync, reindex, memory-extraction, and approval-interaction pending,
  processing, delayed, and DLQ counts are zero.

Do not continue if any preflight item differs. Repair the fail-closed state and rerun the complete
preflight.

## Bounded Window

1. Arm a root-owned automatic fail-closed timer before starting Caddy.
2. Enable only `replyWhenMentioned` and `readGroupDocuments` capabilities needed by this gate.
   Preserve all unrelated capability values.
3. Enable only the approved pilot group, then enable global runtime.
4. Re-read durable runtime state and require the exact pilot allowlist.
5. Start Caddy and verify public `/health` succeeds while public `/internal/*` remains `404`.
6. Do not enable semantic extraction, proactive planning/delivery, or knowledge-base writes.

If the timer expires, treat the window as failed and start again from preflight. Never infer a card
or message defect from a Feishu transport error until Caddy and timer state have been checked.

## Real Feishu Steps

In the pilot group, the human tester sends:

```text
@Iris 请收录这个文档 <new Feishu docx URL>
```

Expected reply:

```text
已收到这个文档，我会同步它的内容。同步完成后，你可以直接 @我提问。
```

The operator then verifies internally, without printing document body content:

- canonical URL and `sourceType=user_submitted_document`;
- one source row and one user-submission evidence item for the message;
- permission state `allowed`;
- sync state `synced`;
- latest snapshot and indexed fragment counts are non-zero;
- document-sync and reindex queues and DLQs are zero.

Only after those checks pass, the human tester sends:

```text
@Iris 用户提交文档的验收编号是什么？只回复编号。
```

The answer must contain exactly the fixture marker as its factual answer and cite the submitted
document. It must not substitute an authorized wiki or group-visible document marker.

Ask the same question in the disabled control group. Iris must not reply and must not create
control-group retrieval or memory facts.

## Cleanup

Stop Caddy first. Disable global runtime, disable every known group, and restore every temporarily
changed capability. Recreate Core only when an environment value changed. Then verify:

- `globalEnabled=false`;
- `desiredGlobalEnabled=false`;
- exact disabled-group inventory;
- Caddy and the automatic timer are stopped;
- all services are healthy;
- all pending, processing, delayed, and DLQ counts are zero;
- the approved candidate and deployed image SHAs did not change.

Keep the submitted source and append-only evidence as acceptance history. Do not delete durable
facts merely to make the next acceptance look clean.

## Evidence Record

Record only bounded metadata in the private deployment log and PR:

- candidate and image SHAs;
- pilot/control group IDs;
- canonical source type and source ID;
- submission message ID and reply message ID;
- permission/sync state;
- snapshot/index counts;
- answer message ID and citation source ID;
- final queue/DLQ counts;
- timer and cleanup result.

Do not record access tokens, document body content, user open IDs, prompts, or raw model responses.
