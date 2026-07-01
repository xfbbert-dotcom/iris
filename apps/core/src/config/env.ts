import type { FeishuAuthConfig } from "../feishu/feishu-auth.js";

export type EnvLike = Record<string, string | undefined>;

export function readFeishuAuthConfig(env: EnvLike = process.env): FeishuAuthConfig {
  return {
    verificationToken: readOptionalEnv(env.FEISHU_VERIFICATION_TOKEN),
    encryptKey: readOptionalEnv(env.FEISHU_ENCRYPT_KEY)
  };
}

function readOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
