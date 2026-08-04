# Task 7 Report: Content-Free Internal Answer Receipt Inspection

Base: `86cf44cac35e16991313b32d801409bf348f275f`

Commit: `0148f5bd9f5a249267ee7c17181918e44faeca4c`

## RED

- `npm exec --workspace apps/core -- vitest run tests/answer-reply-api.test.ts`
  initially failed as expected because `GET /internal/answer-replies/:provider/:incomingMessageId`
  was not registered. The new authorized, validation, unavailable/not-found, and error-boundary
  assertions received `404` rather than their required route behavior.
- `node --test --test-concurrency=1 scripts/pilot-smoke-lib.test.mjs` initially failed as expected
  because the smoke output had no `publicAnswerReply` result and did not request the answer-reply
  public boundary path.

## GREEN

- Focused answer-reply API: 1 file, 5 tests passed.
- Internal API/startup/runtime: 3 files, 34 tests passed.
- Public smoke/compose: 66 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 164 files and 2,857 tests passed; 2 files and 213 database-dependent tests skipped.
- `git diff --cached --check`: passed before commit.

## Response Field Audit

The route reads only `eventWorkerRuntime?.answerReplies.findByIncomingMessage`; it has no mutation
access. It is registered after the app's existing internal bearer hook.

- Delivery allowlist: `id`, `provider`, `incomingMessageId`, `chatId`, `state`,
  `renderedReplyFingerprint`, `semanticFingerprint`, reply and safe-notice message IDs, attempt
  counters, `version`, and the required created/updated/state timestamps.
- Source allowlist: trace identity, ranks, source/snapshot/fragment IDs, chunk index, source
  metadata, content hash, embedding profile ID, and initial permission-check timestamp.
- Event allowlist: event identity, delivery ID, sequence, type, optional attempt number, source
  count, source IDs, and creation timestamp.
- The mapper uses explicit properties and ordered `map()` calls. It does not spread delivery,
  source, or event objects.
- Excluded: `preparedReplyText`, answer text, fragment text, prompts, credentials/tokens,
  provider bodies, exception messages, UUIDs, and arbitrary object properties.

## Public Boundary Audit

- Invalid provider, blank or over-512 incoming message IDs return bounded `400` before a repository
  call. A same-prefix wildcard fallback lets long IDs reach this validator without changing global
  Fastify routing limits.
- Missing receipt and unavailable answer-reply runtime return bounded `404`; repository failures
  return a fixed `500` error without exposing the exception message.
- Unauthorized callers are stopped by the existing bearer hook with `401` before the route can
  inspect repository availability or receipt existence.
- Caddy configuration and matchers were not changed. Public smoke now requires
  `/internal/answer-replies/feishu/public-boundary-probe` to return `404` and records
  `public-answer-reply-404`.

## Concerns

None for Task 7. The full suite's 213 skips are the existing database-dependent skips when the
database test environment is unavailable.

## Fix Round 1

Addressed review findings:

- `buildApp()` registers the answer-reply API only when the constructed event-worker runtime exposes
  `answerReplies`. An existing event worker without that inspection capability now leaves the route
  absent and returns Fastify's normal bounded `404` boundary response.
- Incoming message IDs must be supplied exactly. Whitespace-padded values now return bounded `400`
  without a repository lookup; accepted values retain their original string for the lookup.

Covering test files:

- `apps/core/tests/answer-reply-api.test.ts`
- `apps/core/tests/event-worker-runtime.test.ts`
- `apps/core/tests/server-startup.test.ts`

RED command and result:

```text
npm exec --workspace apps/core -- vitest run tests/answer-reply-api.test.ts
```

Result: 2 expected failures before implementation. A whitespace-padded ID returned `200`, and an
event worker without `answerReplies` returned the dedicated `answer_reply_unavailable` response.

GREEN command and result:

```text
npm exec --workspace apps/core -- vitest run tests/answer-reply-api.test.ts tests/event-worker-runtime.test.ts tests/server-startup.test.ts
```

Result: 3 files and 36 tests passed.

Typecheck command and result:

```text
npm run typecheck
```

Result: passed.
