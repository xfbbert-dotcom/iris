# Iris Raw Event Queue ACK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent raw Feishu events from being silently lost after the gateway has already acknowledged them.

**Architecture:** Add an explicit processed-event acknowledgement to `RawEventQueue`. In-memory queues keep dequeued events in an in-flight map until ACK or failure. Redis queues move dequeued payloads into a processing list and recover abandoned processing payloads before polling.

**Tech Stack:** TypeScript, Vitest, Redis list/set primitives via existing `eval` hooks.

---

### Task 1: Worker ACK Contract

**Files:**
- Modify: `apps/core/src/events/raw-event-queue.ts`
- Modify: `apps/core/src/events/raw-event-worker.ts`
- Test: `apps/core/tests/raw-event-worker.test.ts`

- [ ] Add `handleProcessedEvent(event: RawEvent): Promise<void>` to `RawEventQueue`.
- [ ] Write a failing worker test proving successful processing calls `handleProcessedEvent`.
- [ ] Run the focused worker test and observe RED.
- [ ] Update `createRawEventWorker` to ACK successful events before returning a processed result.
- [ ] Run the focused worker test and observe GREEN.

### Task 2: In-Memory In-Flight Semantics

**Files:**
- Modify: `apps/core/src/events/in-memory-raw-event-queue.ts`
- Test: `apps/core/tests/raw-event-queue.test.ts`

- [ ] Write a failing test proving a dequeued event stays claimed until `handleProcessedEvent`.
- [ ] Run the focused queue test and observe RED.
- [ ] Add an in-flight map, keep seen keys while events are in-flight, and release them on ACK/failure.
- [ ] Update existing tests that expected immediate seen-key release to expect release after ACK.
- [ ] Run the in-memory raw event queue tests and observe GREEN.

### Task 3: Redis Processing List

**Files:**
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Test: `apps/core/tests/redis-raw-event-queue.test.ts`
- Test: `apps/core/tests/event-worker-runtime.test.ts`

- [ ] Write failing Redis tests proving dequeue moves payloads to a processing list without releasing seen keys.
- [ ] Write a failing Redis test proving `handleProcessedEvent` removes the processing payload and releases the seen key.
- [ ] Run focused Redis tests and observe RED.
- [ ] Implement a dequeue eval script that moves one payload from pending to processing.
- [ ] Implement processing-list recovery before dequeue.
- [ ] Implement Redis `handleProcessedEvent`.
- [ ] Update runtime Redis client mocks only where the type requires it.
- [ ] Run focused Redis/runtime tests and observe GREEN.

### Task 4: Verification

**Files:**
- No production edits unless verification exposes a real bug.

- [ ] Run raw event worker, in-memory queue, Redis queue, and event worker runtime tests together.
- [ ] Run full core test suite.
- [ ] Run Python worker tests.
- [ ] Run Docker Compose config verification.
- [ ] Commit and push the patch.
