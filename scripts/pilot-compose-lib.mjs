import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pilotEnvFile = "deploy/pilot/ci.env";
const pilotComposeFile = "deploy/pilot/docker-compose.yml";

export function renderPilotCompose({ baseEnv = process.env } = {}) {
  return spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "compose",
      "--env-file",
      pilotEnvFile,
      "--file",
      pilotComposeFile,
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: withoutPilotVariables(baseEnv),
    },
  );
}

export function loadPilotCompose(options) {
  const result = renderPilotCompose(options);
  if (result.status !== 0) {
    const details =
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `docker compose exited with status ${String(result.status)}`;
    throw new Error(`Unable to render pilot Compose config: ${details}`);
  }

  return JSON.parse(result.stdout);
}

function withoutPilotVariables(baseEnv) {
  const isolatedEnv = { ...baseEnv };
  const contents = readFileSync(pilotEnvFile, "utf8");

  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line.trim());
    if (match !== null) {
      delete isolatedEnv[match[1]];
    }
  }

  return isolatedEnv;
}
