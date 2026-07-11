import assert from "node:assert/strict";
import test from "node:test";

import { assertHealthyInternalStatus } from "./pilot-smoke-lib.mjs";

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
