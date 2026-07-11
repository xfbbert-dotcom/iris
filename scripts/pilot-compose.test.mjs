import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const compose = loadPilotCompose();

test("pins every third-party pilot image to an immutable digest", () => {
  for (const serviceName of ["postgres", "redis", "caddy"]) {
    assert.match(
      compose.services[serviceName].image,
      /@sha256:[a-f0-9]{64}$/u,
      `${serviceName} image must be digest-pinned`,
    );
  }
});

test("gives the migration job database credentials only", () => {
  assert.deepEqual(Object.keys(compose.services.migrate.environment).sort(), ["DATABASE_URL"]);
  const appDatabase = new URL(compose.services.core.environment.DATABASE_URL);
  const migrationDatabase = new URL(compose.services.migrate.environment.DATABASE_URL);
  assert.notEqual(appDatabase.username, migrationDatabase.username);
  assert.notEqual(appDatabase.password, migrationDatabase.password);
  assert.notEqual(appDatabase.username, compose.services.postgres.environment.POSTGRES_USER);
});

test("initializes dedicated migrator and application database roles", () => {
  assert.ok(compose.services.postgres.environment.IRIS_MIGRATOR_USER);
  assert.ok(compose.services.postgres.environment.IRIS_MIGRATOR_PASSWORD);
  assert.ok(compose.services.postgres.environment.IRIS_APP_USER);
  assert.ok(compose.services.postgres.environment.IRIS_APP_PASSWORD);
  const initMount = compose.services.postgres.volumes.find(
    (volume) => volume.target === "/docker-entrypoint-initdb.d/10-iris-roles.sh",
  );
  assert.equal(initMount?.read_only, true);
  const grantMount = compose.services.postgres.volumes.find(
    (volume) => volume.target === "/opt/iris/grant-app-access.sql",
  );
  assert.equal(grantMount?.read_only, true);
});

test("gates the edge on authenticated runtime readiness", () => {
  const healthCommand = compose.services.core.healthcheck.test.join(" ");
  assert.match(healthCommand, /\/internal\/ingress-readiness/u);
  assert.match(healthCommand, /IRIS_INTERNAL_API_TOKEN/u);
  assert.doesNotMatch(healthCommand, /\/health/u);
  assert.doesNotMatch(healthCommand, /\/internal\/status/u);
  assert.equal(compose.services.caddy.depends_on.core.condition, "service_healthy");
  assert.equal(
    compose.services.caddy.environment.IRIS_INTERNAL_API_TOKEN,
    compose.services.core.environment.IRIS_INTERNAL_API_TOKEN,
  );
});

function loadPilotCompose() {
  const result = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "compose",
      "--env-file",
      "deploy/pilot/ci.env",
      "--file",
      "deploy/pilot/docker-compose.yml",
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Unable to render pilot Compose config: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}
