import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const compose = loadLocalCompose();

test("binds local Postgres and Redis ports to loopback only", () => {
  assert.deepEqual(compose.services.postgres.ports, [
    {
      mode: "ingress",
      host_ip: "127.0.0.1",
      target: 5432,
      published: "5432",
      protocol: "tcp",
    },
  ]);
  assert.deepEqual(compose.services.redis.ports, [
    {
      mode: "ingress",
      host_ip: "127.0.0.1",
      target: 6379,
      published: "6379",
      protocol: "tcp",
    },
  ]);
});

function loadLocalCompose() {
  const result = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    ["compose", "config", "--format", "json"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    const details =
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `docker compose exited with status ${String(result.status)}`;
    throw new Error(`Unable to render local Compose config: ${details}`);
  }

  return JSON.parse(result.stdout);
}
