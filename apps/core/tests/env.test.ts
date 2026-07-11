import { describe, expect, it } from "vitest";
import { readFeishuAuthConfig } from "../src/config/env.js";

describe("readFeishuAuthConfig", () => {
  it("reads Feishu verification token and encrypt key from the environment", () => {
    expect(
      readFeishuAuthConfig({
        FEISHU_VERIFICATION_TOKEN: "token-a",
        FEISHU_ENCRYPT_KEY: "encrypt-a"
      })
    ).toEqual({
      verificationToken: "token-a",
      encryptKey: "encrypt-a"
    });
  });

  it("treats blank strings as missing values", () => {
    expect(
      readFeishuAuthConfig({
        FEISHU_VERIFICATION_TOKEN: "   ",
        FEISHU_ENCRYPT_KEY: ""
      })
    ).toEqual({});
  });
});
