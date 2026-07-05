import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  buildInternalRolloutReadinessReport,
  type InternalRolloutReadinessReport,
} from "./internal-rollout-readiness.js";
import type { EnvLike } from "../config/env.js";

export type BuildInternalRolloutReadinessEnvInput = {
  args?: string[];
  env?: EnvLike;
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
  readTextFile = readTextFileSync,
}: BuildInternalRolloutReadinessEnvInput = {}): EnvLike {
  const envFilePath = readEnvFilePath(args);
  if (envFilePath === undefined) {
    return { ...env };
  }

  return {
    ...env,
    ...parseEnvFileContents(readTextFile(envFilePath)),
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
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(assignment);
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

  return trimmed;
}

function parseQuotedEnvFileValue(
  value: string,
  quote: "\"" | "'",
  lineNumber: number,
): string {
  if (!value.endsWith(quote) || value.length === 1) {
    throw new Error(`Invalid env file line ${lineNumber}`);
  }

  return value.slice(1, -1);
}

function readTextFileSync(path: string): string {
  return readFileSync(path, "utf8");
}

function normalizeCliError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown readiness CLI error";
}
