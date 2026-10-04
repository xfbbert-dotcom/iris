import { expect, test, vi } from "vitest";
import * as config from "../src/config/runtime-config.js";
import { pdAssessment, pdContext } from "./fixtures/proactive-discussion.js";
import type { PdRepository } from "../src/proactive-discussion/repository.js";
import type { PdClaimedDelivery } from "../src/proactive-discussion/repository.js";

const enabledEnv = { IRIS_PROACTIVE_DISCUSSION_ENABLED: "true", IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: "oc_637a9aca45f01943477f4e17f1fc5b9a" };
async function factory() {
  const module = await import("../src/runtime/proactive-discussion-runtime.js").catch(() => undefined);
  expect(module?.createProactiveDiscussionRuntime).toBeTypeOf("function");
  return module!.createProactiveDiscussionRuntime;
}

test("disabled runtime starts dependency free and operational failure stays stopped/degraded", async () => {
  const create = await factory();
  const resources = vi.fn(async () => { throw new Error("secret upstream error"); });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const disabled = create({ env: {}, createResources: resources });
  await disabled.start();
  expect(resources).not.toHaveBeenCalled();
  expect(await disabled.getStatus()).toMatchObject({ enabled: false, running: false, ok: true });
  await disabled.close();
  expect(timers).not.toHaveBeenCalled();
  timers.mockRestore();
  const failed = create({ env: enabledEnv, createResources: resources });
  await expect(failed.start()).resolves.toBeUndefined();
  expect(await failed.getStatus()).toMatchObject({ enabled: true, running: false, ok: false });
  expect(JSON.stringify(await failed.getStatus())).not.toContain("secret");
  await failed.close();
});

test("bounded close prevents late assessment rendering and drains owned pool once", async () => {
  vi.useFakeTimers();
  try {
    const create = await factory();
    let resolve!: (value: ReturnType<typeof pdAssessment>) => void;
    const pending = new Promise<ReturnType<typeof pdAssessment>>(done => { resolve = done; });
    const render = vi.fn(async () => ({ assessment: pdAssessment(), draft: { text: "late", evidenceRefs: [] } }));
    const commit = vi.fn(async () => "prepared");
    const close = vi.fn(async () => undefined);
    const context = pdContext();
    const repository = { claimEvaluation: async () => ({ id: "j", chatId: context.chatId, purpose: "assessment",
      messageId: "m2", contentHash: "a".repeat(64), leaseToken: "l", attempt: 1, policyVersion: 1 }),
      commitEvaluation: commit, failEvaluation: async () => undefined, claimDelivery: vi.fn(async () => null),
      getStatus: async () => ({ pending: 1, failed: 0, deadLetter: 0, unknown: 0, lastSuccessAt: null }),
    } as unknown as PdRepository;
    const runtime = create({ env: enabledEnv, createResources: async () => ({ repository, botOpenId: "bot",
      contextBuilder: { load: async () => context }, model: { assess: async () => pending, render },
      reader: { listRecentMessages: async () => [] }, replier: { replyText: async () => ({ replyMessageId: "never" }) },
      membership: { isCurrentMember: async () => false }, sourceVerifier: { verify: async () => true }, close }) });
    await runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    const stopping = runtime.close();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(await runtime.getStatus()).toMatchObject({ running: false, ok: false, drainPending: true });
    expect(close).not.toHaveBeenCalled();
    resolve(pdAssessment());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(render).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(repository.claimDelivery).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
    expect(await runtime.getStatus()).not.toHaveProperty("drainPending");
  } finally { vi.useRealTimers(); }
});

test("new runtime cannot silently enable every group", () => {
  const read = (config as Record<string, unknown>).readProactiveDiscussionConfig as (env: Record<string, string>) => unknown;
  expect(read).toBeTypeOf("function");
  expect(read({})).toEqual({ enabled: false, opinionMode: "legacy", groupIds: [], pollIntervalMs: 1000, batchLimit: 10 });
  for (const group of ["", "*", "oc_some_other_group", "oc_637a9aca45f01943477f4e17f1fc5b9a,oc_other"]) {
    expect(() => read({ IRIS_PROACTIVE_DISCUSSION_ENABLED: "true", IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: group })).toThrow();
  }
  expect(read({ IRIS_PROACTIVE_DISCUSSION_ENABLED: "true", IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: "oc_637a9aca45f01943477f4e17f1fc5b9a" }))
    .toMatchObject({ enabled: true, groupIds: ["oc_637a9aca45f01943477f4e17f1fc5b9a"] });
  expect(config.createDefaultRuntimeConfig({ IRIS_PROACTIVE_DISCUSSION_ENABLED: "false" }))
    .toEqual(config.createDefaultRuntimeConfig({ IRIS_PROACTIVE_DISCUSSION_ENABLED: "true" }));
});

test.each(["read", "declaration", "send"])("bounded shutdown during %s preserves delivery settlement without starting another send", async stage => {
  vi.useFakeTimers();
  try {
    const create = await factory(), context = pdContext();
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const record: string[] = [];
    const delivery: PdClaimedDelivery = { id: "d", chatId: context.chatId, issueId: "i", issueVersion: 1,
      basisVersion: 1, policyVersion: 1, contextVersion: 1, triggerMessageId: "m2", text: "advice", sources: context.sources,
      uuid: "uuid", state: "prepared", leaseToken: "lease", checkedRuntimeRevision: 1 };
    const repository = { claimEvaluation: async () => null, claimDelivery: async () => { record.push("claim"); return delivery; },
      readState: async () => { if (stage === "read") await stalled; return { contextVersion: 1 }; },
      beginSend: async () => { record.push("sending"); if (stage === "declaration") await stalled; return "sending"; },
      cancelDelivery: async () => { record.push("cancelled"); },
      finishSend: async ({ outcome }: { outcome: string }) => { record.push(outcome); },
      getStatus: async () => ({ pending: 1, failed: 0, deadLetter: 0, unknown: 0, lastSuccessAt: null }),
    } as unknown as PdRepository;
    const runtime = create({ env: enabledEnv, createResources: async () => ({ repository, botOpenId: "bot",
      contextBuilder: { load: async () => null }, model: { assess: async () => pdAssessment(), render: async () => null },
      reader: { listRecentMessages: async () => [] }, replier: { replyText: async () => { record.push("send"); await stalled; return { replyMessageId: "receipt" }; } },
      membership: { isCurrentMember: async () => false }, sourceVerifier: { verify: async () => true }, close: async () => { record.push("closed"); } }) });
    await runtime.start(); await vi.advanceTimersByTimeAsync(1000);
    const stopping = runtime.close(); await vi.advanceTimersByTimeAsync(5000); await stopping;
    expect(await runtime.getStatus()).toMatchObject({ running: false, ok: false, drainPending: true });
    release(); await vi.advanceTimersByTimeAsync(10_000);
    expect(record).toEqual(stage === "read" ? ["claim", "cancelled", "closed"]
      : stage === "declaration" ? ["claim", "sending", "outcome_unknown", "closed"]
        : ["claim", "sending", "send", "sent", "closed"]);
  } finally { vi.useRealTimers(); }
});

test("worker polling does not overlap and health follows current unresolved failures", async () => {
  vi.useFakeTimers();
  try {
    const create = await factory();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let failures = 1, claims = 0;
    const repository = { claimEvaluation: async () => { claims++; await gate; return null; }, claimDelivery: async () => null,
      getStatus: async () => ({ pending: 0, failed: failures, deadLetter: failures, unknown: 0, lastSuccessAt: null }),
    } as unknown as PdRepository;
    const runtime = create({ env: enabledEnv, createResources: async () => ({ repository, botOpenId: "bot",
      contextBuilder: { load: async () => null }, model: { assess: async () => pdAssessment(), render: async () => null },
      reader: { listRecentMessages: async () => [] }, replier: { replyText: async () => ({}) },
      membership: { isCurrentMember: async () => false }, sourceVerifier: { verify: async () => true }, close: async () => undefined }) });
    await runtime.start(); await vi.advanceTimersByTimeAsync(9000);
    expect(claims).toBe(1);
    expect(await runtime.getStatus()).toMatchObject({ running: true, ok: false, failed: 1 });
    release(); await vi.advanceTimersByTimeAsync(0); failures = 0;
    expect(await runtime.getStatus()).toMatchObject({ running: true, ok: true, failed: 0 });
    await runtime.close();
  } finally { vi.useRealTimers(); }
});
