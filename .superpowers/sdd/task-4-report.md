# Task 4 Report: Version 2 Python Extraction Contracts and Prompt

## Status

Complete. The Python AI Worker accepts and returns schema version 2 while preserving schema version 1 at the existing endpoint. It proposes only structured memory, thread, and action operations; Core remains responsible for final span, state-transition, version, and persistence validation.

## Changes

- Added strict v2 request context: mention identities, current-group threads/actions, bounded enabled operation families, and duplicate-ID checks.
- Added discriminated, exact-key thread and action operation models with finite confidence, evidence spans, owner candidates, expected versions, and due-date evidence requirements.
- Added v2 XML prompt construction with all group content nested beneath `untrusted_extraction_input`, escaped XML data, mentions, threads, actions, and the required untrusted-data system instruction.
- Added v2 response ownership checks for eligible evidence, current-group targets, request-bound sender/mention owners, enabled families, nonblank spans, and globally unique operation keys.
- Extended the existing `/v1/memory/extract` route to parse and serialize both v1 and v2 models without changing its route, auth, or size boundary.
- Added v2 contract, prompt-injection, service-boundary, owner, capability, and API compatibility coverage while retaining v1 coverage.

## Commit

`feat: add thread and action extraction contract`

## Test Commands And Results

1. `cd workers/ai; python -m pytest tests/test_memory_extraction.py tests/test_api.py -q`
   - TDD RED: 69 passed, 1 failed because `MemoryExtractionResponseV2` was absent.
2. Same focused command after the initial v2 response model: 70 passed.
3. Same focused command after the v2 request/operation test: 70 passed, 1 failed because `MemoryExtractionRequestV2` was absent.
4. Same focused command after the v2 contract implementation: 71 passed.
5. Same focused command after the prompt test: 71 passed, 1 failed because `V2_SYSTEM_INSTRUCTION` was absent.
6. Same focused command after prompt implementation: 72 passed.
7. Same focused command after response ownership tests: 72 passed, 1 failed because v2 ownership validation was absent.
8. Same focused command after ownership validation: 73 passed.
9. Same focused command after the API v2 test: 73 passed, 1 failed because the route accepted only v1.
10. Same focused command after API version-union support: 74 passed.
11. Same focused command after owner/capability boundary tests: 73 passed, 1 failed because request-bound owner and enabled-family checks were absent.
12. Same focused command after final service checks: 74 passed.
13. `cd workers/ai; python -m pytest`: 160 passed.
14. `cd workers/ai; python -m compileall iris_worker`: exit 0.
15. `cd workers/ai; python -m pip check`: `No broken requirements found.`
16. `git diff --check`: exit 0; Git emitted only the repository's LF-to-CRLF informational warnings.
17. A later `cd workers/ai; python -m pytest` run had one unrelated timing-sensitive failure in `test_total_wall_clock_deadline_stops_endless_slow_response` (`chunks_yielded == 1`, expected at least 2). The exact test passed 10 consecutive reruns; no scope-external test or client code was changed.

## Concerns

- The Worker validates proposal shape and request ownership only. TypeScript Core must continue to verify exact evidence-span containment, current versions, group scope, allowed state transitions, and all database writes before applying any operation.
- No proactive speech, cross-group context, answer-context behavior, or knowledge-base writes were added.
- The full-suite timing test noted above is a residual environmental-flake concern; final verification is rerun after this report update.
