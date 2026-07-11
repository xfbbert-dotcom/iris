# Iris Mention Blank Answer Fallback Implementation Plan

## Goal

Give users visible feedback when an explicit @Iris mention reaches the model but the answer draft is blank.

## Steps

- [x] Add a failing responder test where `generateDraft` throws `model answer draft must not be blank`.
- [x] Observe the red failure: `maybeRespond` rejected instead of replying.
- [x] Catch only that exact blank-answer error inside the mention responder.
- [x] Send a concise fallback reply with the same deterministic UUID path.
- [x] Mark the message handled after the fallback reply so platform retries are deduplicated.
- [x] Run focused mention responder tests.

## Verification

- RED: `npm --workspace apps/core run test -- tests/feishu-mention-answer-responder.test.ts -t "blank answer"` failed because the blank-answer error propagated.
- GREEN: `npm --workspace apps/core run test -- tests/feishu-mention-answer-responder.test.ts -t "blank answer"` passed.
- Focused file: `npm --workspace apps/core run test -- tests/feishu-mention-answer-responder.test.ts` passed with `12` tests.
