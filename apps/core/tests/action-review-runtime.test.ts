import { describe, expect, it, vi } from "vitest";

import type { ActionApprovalRuntime } from "../src/runtime/action-approval-runtime.js";
import { createActionReviewRuntime } from "../src/runtime/action-review-runtime.js";

describe("createActionReviewRuntime", () => {
  const env = {
    IRIS_ACTION_REVIEW_ENABLED: "true",
    IRIS_REVIEW_PUBLIC_ORIGIN: "https://iris.example.com",
    IRIS_REVIEW_SESSION_SECRET: "s".repeat(32),
    FEISHU_APP_ID: "cli_review",
    FEISHU_APP_SECRET: "review-secret",
  };

  it("is disabled without allocating review dependencies", () => {
    expect(createActionReviewRuntime()).toBeUndefined();
  });

  it("shares the action-approval repository and has idempotent independent cleanup", async () => {
    const repository = {} as ActionApprovalRuntime["repository"];
    const actionApprovalRuntime = { repository } as ActionApprovalRuntime;
    const close = vi.fn(async () => undefined);
    const runtime = createActionReviewRuntime({
      env,
      actionApprovalRuntime,
      dependencies: { close },
    });

    expect(runtime?.repository).toBe(repository);
    await runtime?.close();
    await runtime?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed when enabled without the action-approval runtime", () => {
    expect(() => createActionReviewRuntime({ env })).toThrow(
      "actionApprovalRuntime is required when action reviews are enabled",
    );
  });
});
