import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = loadPilotCompose();
const acceptanceRunbook = readFileSync(
  "docs/runbooks/iris-automatic-memory-extraction-acceptance.md",
  "utf8",
);
const conversationStateAcceptanceRunbookPath =
  "docs/runbooks/iris-semantic-thread-action-memory-acceptance.md";
const caddyfile = readFileSync("deploy/pilot/Caddyfile", "utf8");
const pilotCiEnv = readFileSync("deploy/pilot/ci.env", "utf8");
const pilotEnvExample = readFileSync(".env.pilot.example", "utf8");

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
    compose.services.caddy.environment.IRIS_INGRESS_HEALTH_TOKEN,
    compose.services.core.environment.IRIS_INGRESS_HEALTH_TOKEN,
  );
  assert.notEqual(
    compose.services.caddy.environment.IRIS_INGRESS_HEALTH_TOKEN,
    compose.services.core.environment.IRIS_INTERNAL_API_TOKEN,
  );
  assert.equal(compose.services.caddy.environment.IRIS_INTERNAL_API_TOKEN, undefined);
});

test("starts the pilot runtime globally disabled", () => {
  assert.equal(compose.services.core.environment.IRIS_RUNTIME_GLOBAL_ENABLED, "false");
  assert.match(compose.services.core.environment.IRIS_FEISHU_BOT_OPEN_ID, /^ou_[A-Za-z0-9]+$/u);
});

test("keeps automatic memory extraction private with dedicated model egress", () => {
  const aiWorker = compose.services["ai-worker"];
  const core = compose.services.core;

  assert.match(aiWorker.build.context, /[\\/]workers[\\/]ai$/u);
  assert.equal(aiWorker.ports, undefined);
  assert.deepEqual(aiWorker.networks, { backend: null, "model-egress": null });
  assert.equal(aiWorker.networks.edge, undefined);
  assert.equal(compose.networks.backend.internal, true);
  assert.equal(compose.networks["model-egress"].driver, "bridge");
  assert.notEqual(compose.networks["model-egress"].internal, true);
  for (const [serviceName, service] of Object.entries(compose.services)) {
    if (serviceName !== "ai-worker") {
      assert.equal(
        service.networks?.["model-egress"],
        undefined,
        `${serviceName} must not join model-egress`,
      );
    }
  }
  assert.equal(aiWorker.user, "10001:10001");
  assert.deepEqual(aiWorker.logging, {
    driver: "json-file",
    options: { "max-file": "5", "max-size": "10m" },
  });
  assert.deepEqual(aiWorker.healthcheck, {
    test: [
      "CMD",
      "python",
      "-c",
      "import json, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3); body = json.load(response); response.close(); assert body == {'ok': True, 'service': 'iris-ai-worker', 'schemaVersion': 1}",
    ],
    timeout: "5s",
    interval: "10s",
    retries: 12,
    start_period: "10s",
  });
  assert.equal(aiWorker.restart, "unless-stopped");
  assert.equal(aiWorker.environment.IRIS_AI_WORKER_PORT, "8000");
  assert.equal(aiWorker.environment.IRIS_AI_WORKER_TOKEN, core.environment.IRIS_AI_WORKER_TOKEN);
  assert.equal(aiWorker.environment.IRIS_MODEL_PROVIDER, undefined);
  assert.equal(aiWorker.environment.IRIS_MODEL_BASE_URL, "https://memory-model.invalid/v1");
  assert.equal(aiWorker.environment.IRIS_MODEL_API_KEY, "ci-memory-model-key");
  assert.equal(aiWorker.environment.IRIS_MODEL_NAME, "ci-memory-model");
  assert.equal(aiWorker.environment.IRIS_MODEL_TIMEOUT_MS, "30000");
  assert.equal(aiWorker.environment.IRIS_MODEL_MAX_RESPONSE_BYTES, "65536");
  assert.equal(core.environment.IRIS_MODEL_BASE_URL, "https://model.invalid/v1");
  assert.equal(core.environment.IRIS_MODEL_API_KEY, "ci-model-key");
  assert.equal(core.environment.IRIS_MODEL_NAME, "ci-model");
  assert.equal(core.image.split(":").at(-1), aiWorker.image.split(":").at(-1));

  assert.equal(core.environment.IRIS_AI_WORKER_BASE_URL, "http://ai-worker:8000");
  assert.ok(core.environment.IRIS_AI_WORKER_TOKEN);
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_ENABLED, "false");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_INTERVAL_MS, "1000");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_BATCH_LIMIT, "20");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE, "0.85");
  assert.equal(core.depends_on["ai-worker"].condition, "service_started");
});

test("keeps semantic thread and action extraction disabled by default", () => {
  const expectedValues = {
    IRIS_THREAD_EXTRACTION_GROUP_IDS: "",
    IRIS_ACTION_EXTRACTION_GROUP_IDS: "",
    IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR: "0.65",
    IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "0.85",
  };

  for (const [name, expected] of Object.entries(expectedValues)) {
    assert.equal(readEnvAssignment(pilotCiEnv, name), expected, `${name} must match in CI env`);
    assert.equal(
      readEnvAssignment(pilotEnvExample, name),
      expected,
      `${name} must match in pilot example`,
    );
    assert.equal(compose.services.core.environment[name], expected);
  }

  assert.equal(compose.services["ai-worker"].ports, undefined);
  assert.equal(compose.services["ai-worker"].networks.edge, undefined);
  assert.doesNotMatch(caddyfile, /ai-worker/u);
  assert.doesNotMatch(caddyfile, /@internal|path \/internal|reverse_proxy \/internal/u);
  assert.equal(compose.services.core.environment.IRIS_PROACTIVE_SPEECH_ENABLED, undefined);
});

test("requires zero conversation-state queues, DLQs, and projection repairs before rollout", () => {
  const runbook = readFileSync(conversationStateAcceptanceRunbookPath, "utf8");

  for (const marker of [
    "/internal/status",
    "/internal/ingress-readiness",
    "pendingJobCount",
    "processingJobCount",
    "delayedJobCount",
    "deadLetterJobCount",
    "pendingProjectionRepairCount",
    "failedProjectionRepairCount",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "u"), `${marker} gate is required`);
  }
  assert.match(runbook, /proactiveSpeech[^\n]*false/u);
});

test("renders the pilot example with disabled extraction and placeholder secrets", () => {
  for (const name of [
    "IRIS_AI_WORKER_TOKEN",
    "IRIS_MEMORY_EXTRACTION_ENABLED",
    "IRIS_MEMORY_EXTRACTION_INTERVAL_MS",
    "IRIS_MEMORY_EXTRACTION_BATCH_LIMIT",
    "IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE",
    "IRIS_MEMORY_EXTRACTION_MODEL_BASE_URL",
    "IRIS_MEMORY_EXTRACTION_MODEL_API_KEY",
    "IRIS_MEMORY_EXTRACTION_MODEL_NAME",
    "IRIS_MEMORY_EXTRACTION_MODEL_TIMEOUT_MS",
    "IRIS_MEMORY_EXTRACTION_MODEL_MAX_RESPONSE_BYTES",
  ]) {
    assert.match(pilotEnvExample, new RegExp(`^${name}=`, "mu"));
  }

  const exampleCompose = loadPilotCompose(".env.pilot.example");
  const core = exampleCompose.services.core;
  const aiWorker = exampleCompose.services["ai-worker"];
  const postgres = exampleCompose.services.postgres;

  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_ENABLED, "false");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_INTERVAL_MS, "1000");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_BATCH_LIMIT, "20");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE, "0.85");
  assert.equal(aiWorker.environment.IRIS_MODEL_TIMEOUT_MS, "30000");
  assert.equal(aiWorker.environment.IRIS_MODEL_MAX_RESPONSE_BYTES, "65536");

  for (const value of [
    postgres.environment.POSTGRES_PASSWORD,
    postgres.environment.IRIS_MIGRATOR_PASSWORD,
    postgres.environment.IRIS_APP_PASSWORD,
    core.environment.IRIS_INTERNAL_API_TOKEN,
    core.environment.IRIS_INGRESS_HEALTH_TOKEN,
    core.environment.FEISHU_VERIFICATION_TOKEN,
    core.environment.FEISHU_APP_SECRET,
    core.environment.IRIS_MODEL_API_KEY,
    core.environment.IRIS_EMBEDDING_API_KEY,
    core.environment.IRIS_AI_WORKER_TOKEN,
    aiWorker.environment.IRIS_AI_WORKER_TOKEN,
    aiWorker.environment.IRIS_MODEL_API_KEY,
  ]) {
    assert.match(value, /^replace-with-/u);
  }
  assert.doesNotMatch(JSON.stringify(exampleCompose), /ci-(?:model|internal|app|memory)/u);
});

test("gates real Feishu activation behind public boundary checks and fails closed", () => {
  const pilotSection = acceptanceRunbook.slice(
    acceptanceRunbook.indexOf("## Gates 10-12: One-Group Feishu Pilot"),
  );
  const orderedMarkers = [
    "10. Keep global Iris and the pilot group durably disabled",
    "Start Caddy",
    "public `/health`",
    "public `/internal/*`",
    "callback boundary",
    "Only then durably enable global Iris and the single pilot group",
    "11.",
    "12.",
  ];
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const markerIndex = pilotSection.indexOf(marker);
    assert.ok(markerIndex > previousIndex, `${marker} must appear in gate order`);
    previousIndex = markerIndex;
  }
  assert.match(
    pilotSection,
    /If any real-pilot gate fails, immediately disable the pilot group, disable global Iris, stop Caddy, and enter Rollback/u,
  );
});

function loadPilotCompose(envFile = "deploy/pilot/ci.env") {
  const result = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "compose",
      "--env-file",
      envFile,
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

function readEnvAssignment(contents, name) {
  const match = new RegExp(`^${escapeRegExp(name)}=(.*)$`, "mu").exec(contents);
  assert.ok(match, `${name} must be present`);
  return match[1].trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
