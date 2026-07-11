import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installGracefulShutdown } from "../src/runtime/graceful-shutdown.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("installGracefulShutdown", () => {
  it("closes application resources once on SIGTERM", async () => {
    const processTarget = new FakeProcessTarget();
    const close = vi.fn(async () => undefined);

    installGracefulShutdown({ close }, { processTarget });
    processTarget.emit("SIGTERM");
    processTarget.emit("SIGINT");
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
    expect(processTarget.exit).not.toHaveBeenCalled();
    expect(processTarget.listenerCount("SIGTERM")).toBe(0);
    expect(processTarget.listenerCount("SIGINT")).toBe(0);
  });

  it("forces exit before the Docker stop grace period when close stalls", async () => {
    vi.useFakeTimers();
    const processTarget = new FakeProcessTarget();
    const close = vi.fn(() => new Promise<void>(() => undefined));

    installGracefulShutdown(
      { close },
      { processTarget, timeoutMs: 25_000, reportError: vi.fn() },
    );
    processTarget.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(25_000);

    expect(close).toHaveBeenCalledOnce();
    expect(processTarget.exit).toHaveBeenCalledWith(1);
  });

  it("reports cleanup failure and exits non-zero", async () => {
    const processTarget = new FakeProcessTarget();
    const cleanupError = new Error("close failed");
    const reportError = vi.fn();

    installGracefulShutdown(
      { close: vi.fn(async () => Promise.reject(cleanupError)) },
      { processTarget, reportError },
    );
    processTarget.emit("SIGINT");
    await vi.waitFor(() => expect(processTarget.exit).toHaveBeenCalledWith(1));

    expect(reportError).toHaveBeenCalledWith("Iris graceful shutdown failed", cleanupError);
  });
});

class FakeProcessTarget extends EventEmitter {
  readonly exit = vi.fn((_code: number) => undefined);
}
