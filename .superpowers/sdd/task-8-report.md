# Task 8 Report: Conversation-State Answer Context

## Scope

Implemented only the answer read path: a bounded PostgreSQL conversation-state
provider, prompt assembly, document retrieval context, and answer-draft runtime
gating. No Task 9 API/acceptance or Task 10 deployment files were changed.

## RED

Command:

```powershell
npm exec --workspace apps/core -- vitest run tests/conversation-state-context-provider.test.ts tests/context-assembly.test.ts tests/document-retrieval-context.test.ts tests/answer-draft-runtime.test.ts
```

Result: failed as expected. The new provider module was missing, and the three
existing layers had no discussion/action context sections or runtime wiring.

## GREEN

Commands:

```powershell
npm exec --workspace apps/core -- vitest run tests/conversation-state-context-provider.test.ts tests/context-assembly.test.ts tests/document-retrieval-context.test.ts tests/answer-draft-runtime.test.ts
npm run typecheck
git diff --check
```

Result: 4 focused files / 75 tests passed; `tsc --noEmit` passed; `git diff
--check` passed (only CRLF checkout warnings were emitted).

## Files

- Added `apps/core/src/conversation-state/conversation-state-context-provider.ts`
- Added `apps/core/tests/conversation-state-context-provider.test.ts`
- Updated `apps/core/src/memory/context-assembly.ts`
- Updated `apps/core/src/memory/document-retrieval-context.ts`
- Updated `apps/core/src/agent/answer-draft-orchestrator.ts`
- Updated `apps/core/src/runtime/answer-draft-runtime.ts`
- Updated focused tests for context assembly, document retrieval, and runtime

## Review

- Candidate and merged source state are constrained in SQL; canonical merge
  targets are the only discussion rows returned to prompts.
- Resolved threads require normalized query-term overlap. Open threads sort
  first, then lexical overlap, activity, and ID. Actions require a selected
  thread, matching owner, or description-term match.
- Both state sections cap at six entries independently. New state fields are
  truncated before XML escaping, and live chat remains a final, independent
  20-message anchor.
- State is wired only for Postgres persistence and only calls through when
  `canReadGroupContext(groupId) === true`; drafts without a group ID pass no
  state group. The existing document permission guard is unchanged.

## Commit

`feat: retrieve semantic conversation state for answers` (this Task 8 change
set, including this report)

## Concerns

None. Mock SQL-contract checks are now supplemented by the real PostgreSQL
provider coverage recorded below.

## Task 8 Read Correctness Follow-up

### RED

Commands:

```powershell
$env:IRIS_TEST_DATABASE_URL = 'postgres://iris:iris@localhost:5432/iris'
npm exec --workspace apps/core -- vitest run tests/conversation-state-context-provider.test.ts
```

Results: the new tokenizer contract failed because the prior implementation
emitted one full CJK string, retained `the`, and reduced `100%` to `100`.
The real PostgreSQL test also failed because an A -> B -> C merge chain did
not return C when only A matched. A later RED exposed `吗` becoming a trailing
CJK n-gram, and the explicit resolved no-match assertion exposed `no` matching
the word `canonical`.

### GREEN

Commands:

```powershell
$env:IRIS_TEST_DATABASE_URL = 'postgres://iris:iris@localhost:5432/iris'
npm exec --workspace apps/core -- vitest run tests/conversation-state-context-provider.test.ts
npm exec --workspace apps/core -- vitest run tests/conversation-state-context-provider.test.ts tests/context-assembly.test.ts tests/document-retrieval-context.test.ts tests/answer-draft-runtime.test.ts
npm run typecheck
git diff --check
```

Results: real PostgreSQL provider tests passed (5/5); all four Task 8 focused
files passed (78/78); typecheck passed; `git diff --check` passed.

### PostgreSQL Coverage

The real integration section uses `IRIS_TEST_DATABASE_URL`, runs migrations,
and verifies current-group isolation, candidate and merged-source exclusion,
A -> B -> C terminal resolution, CJK n-gram overlap, case/punctuation-stable
English terms, literal underscore and percent matching, resolved no-match
exclusion, selected-thread/owner/description action routes, unrelated action
exclusion, deterministic open-thread ties, and fail-closed cycle, overdeep,
and cross-group merge chains.

### Follow-up Scope

The provider now uses bounded deterministic Latin/digit and CJK-bigram query
terms with stopword filtering. Thread and action lexical overlap use `strpos`
for literal PostgreSQL matching; no document permission guard, live-chat
anchor, Task 9 API, or deployment behavior changed.
