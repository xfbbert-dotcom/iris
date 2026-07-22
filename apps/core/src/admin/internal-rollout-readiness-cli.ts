import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  buildInternalRolloutReadinessReport,
  type InternalRolloutReadinessReport,
} from "./internal-rollout-readiness.js";
import type { EnvLike } from "../config/env.js";

export type BuildInternalRolloutReadinessEnvInput = {
  args?: string[];
  env?: EnvLike;
  fileExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string;
};

export type ResolveInternalRolloutReadinessReportInput =
  BuildInternalRolloutReadinessEnvInput & {
    fetchImpl?: typeof fetch;
  };

const internalRolloutReadinessReportSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["ready", "ready_with_warnings", "blocked"]),
  schemaVersion: z.literal(1),
  checks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
    envVars: z.array(z.string()),
  })),
  summary: z.object({
    checkCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    warnCount: z.number().int().nonnegative(),
    failCount: z.number().int().nonnegative(),
    highestSeverity: z.enum(["pass", "warn", "fail"]),
  }),
});

export function formatInternalRolloutReadinessReport(
  report: InternalRolloutReadinessReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function getInternalRolloutReadinessExitCode(
  report: InternalRolloutReadinessReport,
): 0 | 1 {
  return report.ok ? 0 : 1;
}

export function buildInternalRolloutReadinessEnv({
  args = [],
  env = process.env,
  fileExists = existsSync,
  readTextFile = readTextFileSync,
}: BuildInternalRolloutReadinessEnvInput = {}): EnvLike {
  const { envFilePath } = readCliOptions(args);
  if (envFilePath === undefined) {
    return { ...env };
  }

  const resolvedEnvFilePath = resolveEnvFilePath(envFilePath, env, fileExists);

  return {
    ...env,
    ...parseEnvFileContents(readTextFile(resolvedEnvFilePath)),
  };
}

export async function resolveInternalRolloutReadinessReport({
  args = [],
  env = process.env,
  fetchImpl = fetch,
  fileExists = existsSync,
  readTextFile = readTextFileSync,
}: ResolveInternalRolloutReadinessReportInput = {}): Promise<InternalRolloutReadinessReport> {
  const resolvedEnv = buildInternalRolloutReadinessEnv({
    args,
    env,
    fileExists,
    readTextFile,
  });
  const { liveReadinessUrl } = readCliOptions(args);
  if (liveReadinessUrl === undefined) {
    return buildInternalRolloutReadinessReport(resolvedEnv);
  }

  const url = validateLiveReadinessUrl(liveReadinessUrl);
  const internalApiToken = resolvedEnv.IRIS_INTERNAL_API_TOKEN?.trim();
  if (!internalApiToken) {
    throw new Error("IRIS_INTERNAL_API_TOKEN is required for live readiness");
  }

  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${internalApiToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Live readiness request failed with HTTP ${response.status}`);
  }

  return internalRolloutReadinessReportSchema.parse(await response.json());
}

export function parseEnvFileContents(contents: string): EnvLike {
  const parsedEnv: EnvLike = {};
  const lines = contents.replace(/^\uFEFF/u, "").split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(assignment);
    if (match === null) {
      throw new Error(`Invalid env file line ${index + 1}`);
    }

    parsedEnv[match[1]] = parseEnvFileValue(match[2], index + 1);
  }

  return parsedEnv;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void resolveInternalRolloutReadinessReport({ args: process.argv.slice(2) })
    .then((report) => {
      process.stdout.write(formatInternalRolloutReadinessReport(report));
      process.exitCode = getInternalRolloutReadinessExitCode(report);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${normalizeCliError(error)}\n`);
      process.exitCode = 2;
    });
}

function readCliOptions(args: string[]): {
  envFilePath?: string;
  liveReadinessUrl?: string;
} {
  let envFilePath: string | undefined;
  let liveReadinessUrl: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env-file") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --env-file");
      }
      envFilePath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      const value = arg.slice("--env-file=".length);
      if (value.length === 0) {
        throw new Error("Missing value for --env-file");
      }
      envFilePath = value;
      continue;
    }
    if (arg === "--live-readiness-url") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --live-readiness-url");
      }
      liveReadinessUrl = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--live-readiness-url=")) {
      const value = arg.slice("--live-readiness-url=".length);
      if (value.length === 0) {
        throw new Error("Missing value for --live-readiness-url");
      }
      liveReadinessUrl = value;
      continue;
    }

    throw new Error(`Unsupported readiness argument: ${arg}`);
  }

  return { envFilePath, liveReadinessUrl };
}

function validateLiveReadinessUrl(value: string): URL {
  const url = new URL(value);
  const isLoopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "::1";
  if (!isLoopback) {
    throw new Error("Live readiness URL must use a loopback host");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Live readiness URL must use HTTP or HTTPS");
  }
  if (
    url.pathname !== "/internal/readiness"
    || url.search.length > 0
    || url.hash.length > 0
    || url.username.length > 0
    || url.password.length > 0
  ) {
    throw new Error("Live readiness URL must be the exact /internal/readiness endpoint");
  }

  return url;
}

function resolveEnvFilePath(
  envFilePath: string,
  env: EnvLike,
  fileExists: (path: string) => boolean,
): string {
  if (isAbsolute(envFilePath) || fileExists(envFilePath)) {
    return envFilePath;
  }

  const originalNpmCwd = env.INIT_CWD;
  if (typeof originalNpmCwd === "string" && originalNpmCwd.length > 0) {
    const originalCwdEnvFilePath = join(originalNpmCwd, envFilePath);
    if (fileExists(originalCwdEnvFilePath)) {
      return originalCwdEnvFilePath;
    }
  }

  return envFilePath;
}

function parseEnvFileValue(value: string, lineNumber: number): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"")) {
    return parseQuotedEnvFileValue(trimmed, "\"", lineNumber).replace(
      /\\([nrt"\\])/gu,
      (_match, escaped: string) => {
        if (escaped === "n") {
          return "\n";
        }
        if (escaped === "r") {
          return "\r";
        }
        if (escaped === "t") {
          return "\t";
        }

        return escaped;
      },
    );
  }
  if (trimmed.startsWith("'")) {
    return parseQuotedEnvFileValue(trimmed, "'", lineNumber);
  }

  return stripUnquotedEnvFileComment(value).trim();
}

function parseQuotedEnvFileValue(
  value: string,
  quote: "\"" | "'",
  lineNumber: number,
): string {
  const closingQuoteIndex = findClosingQuoteIndex(value, quote);
  if (closingQuoteIndex === undefined) {
    throw new Error(`Invalid env file line ${lineNumber}`);
  }

  const trailingContent = value.slice(closingQuoteIndex + 1).trim();
  if (trailingContent.length > 0 && !trailingContent.startsWith("#")) {
    throw new Error(`Invalid env file line ${lineNumber}`);
  }

  return value.slice(1, closingQuoteIndex);
}

function stripUnquotedEnvFileComment(value: string): string {
  const commentStart = /\s#/u.exec(value);
  if (commentStart === null) {
    return value;
  }

  return value.slice(0, commentStart.index);
}

function findClosingQuoteIndex(value: string, quote: "\"" | "'"): number | undefined {
  let isEscaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "\"" && isEscaped) {
      isEscaped = false;
      continue;
    }
    if (quote === "\"" && character === "\\") {
      isEscaped = true;
      continue;
    }
    if (character === quote) {
      return index;
    }
  }

  return undefined;
}

function readTextFileSync(path: string): string {
  return readFileSync(path, "utf8");
}

function normalizeCliError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown readiness CLI error";
}
