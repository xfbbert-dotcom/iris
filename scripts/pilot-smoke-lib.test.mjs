import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDurableRuntimeMutation,
  assertFastFeishuAcknowledgement,
  assertHealthyInternalStatus,
  assertPilotActivationReady,
  assertRuntimeGloballyDisabled,
} from "./pilot-smoke-lib.mjs";

const activationReadyStatus = {
  ok: true,
  status: "healthy",
  summary: {
    degradedComponentCount: 0,
    stoppedEnabledRuntimeComponentCount: 0,
  },
  components: {
    runtimeControl: {
      ok: true,
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      revision: 7,
      persistence: { storage: "postgres", ok: true },
    },
    eventWorker: {
      ok: true,
      enabled: true,
      running: true,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
    },
    documentSync: {
      ok: true,
      enabled: true,
      running: true,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    },
    reindex: {
      ok: true,
      enabled: true,
      running: true,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    },
  },
};

test("accepts a fully healthy internal status snapshot", () => {
  assert.doesNotThrow(() =>
    assertHealthyInternalStatus({
      ok: true,
      status: "healthy",
      summary: {
        degradedComponentCount: 0,
        stoppedEnabledRuntimeComponentCount: 0,
      },
    }),
  );
});

test("rejects a status snapshot with a degraded component", () => {
  assert.throws(
    () =>
      assertHealthyInternalStatus({
        ok: false,
        status: "degraded",
        summary: {
          degradedComponentCount: 1,
          stoppedEnabledRuntimeComponentCount: 0,
        },
      }),
    /healthy internal status/u,
  );
});

test("rejects a status snapshot with a stopped enabled runtime", () => {
  assert.throws(
    () =>
      assertHealthyInternalStatus({
        ok: false,
        status: "degraded",
        summary: {
          degradedComponentCount: 1,
          stoppedEnabledRuntimeComponentCount: 1,
        },
      }),
    /healthy internal status/u,
  );
});

test("rejects a malformed status snapshot", () => {
  assert.throws(() => assertHealthyInternalStatus({ ok: true }), /healthy internal status/u);
});

test("requires the pilot runtime to start globally disabled", () => {
  assert.doesNotThrow(() =>
    assertRuntimeGloballyDisabled({
      components: { runtimeControl: { globalEnabled: false } },
    }),
  );
  assert.throws(
    () =>
      assertRuntimeGloballyDisabled({
        components: { runtimeControl: { globalEnabled: true } },
      }),
    /globally disabled/u,
  );
});

test("accepts durable desired enablement only while the restarted live gate remains disabled", () => {
  assert.doesNotThrow(() => assertPilotActivationReady(activationReadyStatus));
});

test("rejects a live gate that reopened from durable desired enablement", () => {
  assert.throws(
    () =>
      assertPilotActivationReady({
        ...activationReadyStatus,
        components: {
          ...activationReadyStatus.components,
          runtimeControl: {
            ...activationReadyStatus.components.runtimeControl,
            globalEnabled: true,
            activationRequired: false,
          },
        },
      }),
    /globally disabled/u,
  );
});

for (const persistence of [
  { storage: "in_memory", ok: true },
  { storage: "postgres", ok: false },
]) {
  test(`rejects activation without healthy Postgres persistence: ${JSON.stringify(persistence)}`, () => {
    assert.throws(
      () =>
        assertPilotActivationReady({
          ...activationReadyStatus,
          components: {
            ...activationReadyStatus.components,
            runtimeControl: {
              ...activationReadyStatus.components.runtimeControl,
              persistence,
            },
          },
        }),
      /Postgres runtime-control persistence/u,
    );
  });
}

for (const [componentName, countName] of [
  ["eventWorker", "pendingEventCount"],
  ["eventWorker", "deadLetterEventCount"],
  ["documentSync", "pendingJobCount"],
  ["documentSync", "deadLetterJobCount"],
  ["reindex", "pendingJobCount"],
  ["reindex", "deadLetterJobCount"],
]) {
  test(`rejects activation when ${componentName}.${countName} is nonzero`, () => {
    assert.throws(
      () =>
        assertPilotActivationReady({
          ...activationReadyStatus,
          components: {
            ...activationReadyStatus.components,
            [componentName]: {
              ...activationReadyStatus.components[componentName],
              [countName]: 1,
            },
          },
        }),
      /workers and queues/u,
    );
  });
}

test("rejects activation when a required worker is stopped", () => {
  assert.throws(
    () =>
      assertPilotActivationReady({
        ...activationReadyStatus,
        components: {
          ...activationReadyStatus.components,
          documentSync: {
            ...activationReadyStatus.components.documentSync,
            running: false,
          },
        },
      }),
    /workers and queues/u,
  );
});

test("accepts only a durable successful runtime mutation", () => {
  assert.doesNotThrow(() =>
    assertDurableRuntimeMutation({
      responseStatus: 200,
      body: { globalEnabled: true, durable: true },
      enabled: true,
    }),
  );
  assert.throws(
    () =>
      assertDurableRuntimeMutation({
        responseStatus: 200,
        body: { globalEnabled: true },
        enabled: true,
      }),
    /durable runtime mutation/u,
  );
});

test("accepts a successful Feishu acknowledgement inside the deadline", () => {
  assert.doesNotThrow(() =>
    assertFastFeishuAcknowledgement({
      status: 200,
      body: { ok: true },
      elapsedMs: 100,
      deadlineMs: 2_500,
    }),
  );
});

test("rejects a Feishu acknowledgement that misses the deadline", () => {
  assert.throws(
    () =>
      assertFastFeishuAcknowledgement({
        status: 200,
        body: { ok: true },
        elapsedMs: 2_501,
        deadlineMs: 2_500,
      }),
    /Feishu callback acknowledgement/u,
  );
});
