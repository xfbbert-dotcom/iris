import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

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
  const envFilePath = readEnvFilePath(args);
  if (envFilePath === undefined) {
    return { ...env };
  }

  const resolvedEnvFilePath = resolveEnvFilePath(envFilePath, env, fileExists);

  return {
    ...env,
    ...parseEnvFileContents(readTextFile(resolvedEnvFilePath)),
  };
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
  try {
    const env = buildInternalRolloutReadinessEnv({ args: process.argv.slice(2) });
    const report = buildInternalRolloutReadinessReport(env);
    process.stdout.write(formatInternalRolloutReadinessReport(report));
    process.exitCode = getInternalRolloutReadinessExitCode(report);
  } catch (error) {
    process.stderr.write(`${normalizeCliError(error)}\n`);
    process.exitCode = 2;
  }
}

function readEnvFilePath(args: string[]): string | undefined {
  let envFilePath: string | undefined;
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

    throw new Error(`Unsupported readiness argument: ${arg}`);
  }

  return envFilePath;
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
