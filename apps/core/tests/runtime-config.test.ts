import { describe, expect, it } from "vitest";

import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";

describe("createDefaultRuntimeConfig", () => {
  it("keeps the development default enabled when startup configuration is absent", () => {
    expect(createDefaultRuntimeConfig({}).globalEnabled).toBe(true);
  });

  it("starts globally disabled when explicitly configured fail closed", () => {
    expect(
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: " false " }).globalEnabled,
    ).toBe(false);
  });

  it("supports explicit startup enablement", () => {
    expect(createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "TRUE" }).globalEnabled).toBe(
      true,
    );
  });

  it("rejects invalid startup enablement instead of silently enabling Iris", () => {
    expect(() =>
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "sometimes" }),
    ).toThrow("IRIS_RUNTIME_GLOBAL_ENABLED must be true or false");
    expect(() => createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "   " })).toThrow(
      "IRIS_RUNTIME_GLOBAL_ENABLED must be true or false",
    );
  });
});
