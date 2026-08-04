# Iris Feishu User-Submitted Document Command Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for behavior changes. Keep this scope limited to the ordinary Feishu in-chat entry point; do not expand into broader document UX hardening.

**Goal:** Let ordinary employees submit a readable Feishu document to Iris from a group chat by explicitly @ mentioning Iris with a document-registration command and link.

**Architecture:** Extend the existing `FeishuMentionAnswerResponder` rather than adding a new event route. The responder already owns mention detection, runtime reply gating, reply deduplication, and safe Feishu replies. When the stripped mention text contains an explicit user-document command and a supported Feishu document URI, it registers `user_submitted_document` through the existing document source registry, sends the registered source to the existing document sync planner, replies with a short confirmation, and skips model answer generation. Ordinary document-link questions continue through the answer path.

**Tech Stack:** TypeScript Core, Vitest, existing Feishu message responder, document source registry, document sync planner, Event Worker runtime wiring.

## Acceptance

- [x] `@Iris please register document <Feishu doc link>` registers a canonical `user_submitted_document`.
- [x] Submission uses the Feishu sender ID and message timestamp as evidence inputs.
- [x] Submission enqueues sync through the existing document sync planner.
- [x] Iris replies with a short confirmation and does not call the model.
- [x] Ordinary @ questions that contain a Feishu document link still call the answer draft path.
- [x] Explicit submission commands with no readable Feishu link reply with a link request and do not call the model.
- [x] Explicit submission commands while document reading is disabled reply fail-closed and do not call the model.
- [x] Event Worker wires the same link extractor, runtime document capability gate, registry, and sync planner into the responder.
- [x] Existing group-visible document discovery remains unchanged.

## Verification

- Red observed: `npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts` failed because the command still entered the model answer path.
- Green observed:
  - `npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts`
  - `npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts tests/runtime-startup-promise.test.ts`
  - `npm --workspace apps/core run typecheck`
- Follow-up red observed: `npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts` failed because explicit malformed or disabled submission commands fell through to the model path.
- Follow-up green observed:
  - `npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts`
  - `npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts tests/runtime-startup-promise.test.ts`
  - `npm --workspace apps/core run typecheck`

## Follow-Up Backlog

- Real Feishu pilot: send a manual submission command in the pilot group, wait for sync, and ask Iris a question that requires the submitted document.
- Improve user-facing sync status once the team has used the command naturally.
- Add finer document capability controls only if pilot usage shows user-submitted documents need a separate switch from general document reading.
