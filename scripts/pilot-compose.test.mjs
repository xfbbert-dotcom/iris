import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const compose = loadPilotCompose();
const acceptanceRunbook = readFileSync(
  "docs/runbooks/iris-automatic-memory-extraction-acceptance.md",
  "utf8",
);
const conversationStateAcceptanceRunbookPath =
  "docs/runbooks/iris-semantic-thread-action-memory-acceptance.md";
const conversationStateAcceptanceRunbook = readFileSync(
  conversationStateAcceptanceRunbookPath,
  "utf8",
);
const knowledgeCardAcceptanceRunbook = readFileSync(
  "docs/runbooks/iris-knowledge-card-confirmation-acceptance.md",
  "utf8",
);
const documentReindexQueueSource = readFileSync(
  "apps/core/src/reindex/redis-document-reindex-queue.ts",
  "utf8",
);
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
});

test("keeps knowledge cards disabled with an empty pilot allowlist", () => {
  const expectedValues = {
    IRIS_KNOWLEDGE_CARD_ENABLED: "false",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "",
  };

  for (const [name, expected] of Object.entries(expectedValues)) {
    assert.equal(readEnvAssignment(pilotCiEnv, name), expected, `${name} must match in CI env`);
    assert.equal(compose.services.core.environment[name], expected);
  }
});

test("proxies exactly the two public Feishu callback paths and keeps the fallback closed", () => {
  const matcher = /^\s*@feishu\s+path\s+([^\r\n]+)$/mu.exec(caddyfile);
  assert.notEqual(matcher, null, "Caddy must define one exact Feishu callback matcher");
  assert.deepEqual(matcher[1].trim().split(/\s+/u), [
    "/feishu/events",
    "/feishu/card-actions",
  ]);
  assert.match(caddyfile, /handle @feishu\s*\{\s*reverse_proxy core:3000/su);
  assert.match(caddyfile, /handle\s*\{\s*respond 404\s*\}/su);
  assert.doesNotMatch(caddyfile, /\/feishu\/\*|handle_path/iu);
});

test("proxies only exact public action-review methods and paths", () => {
  assert.match(
    caddyfile,
    /@reviewProposal\s*\{\s*method GET\s*path_regexp review_proposal \^\/review\/action-proposals\/\[\^\/\]\+\$\s*\}/su,
  );
  assert.match(
    caddyfile,
    /@reviewOAuthCallback\s*\{\s*method GET\s*path \/review\/oauth\/callback\s*\}/su,
  );
  assert.match(
    caddyfile,
    /@reviewAttestation\s*\{\s*method POST\s*path_regexp review_attestation \^\/review\/action-proposals\/\[\^\/\]\+\/attest\$\s*\}/su,
  );
  for (const matcher of ["@reviewProposal", "@reviewOAuthCallback", "@reviewAttestation"]) {
    assert.match(caddyfile, new RegExp(`handle ${matcher}\\s*\\{\\s*reverse_proxy core:3000`, "su"));
  }
  assert.doesNotMatch(caddyfile, /path \/review\/\*|handle_path \/review|@review\s+path/iu);
  assert.match(caddyfile, /handle\s*\{\s*respond 404\s*\}/su);
});

test("enforces the action-review boundary in the pinned Caddy runtime", async (t) => {
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const daemon = spawnSync(docker, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (daemon.status !== 0) {
    t.skip("Docker daemon is unavailable for the executable Caddy boundary probe");
    return;
  }

  const name = `iris-caddy-review-${process.pid}-${Date.now()}`;
  const image = compose.services.caddy.image;
  const caddyPath = resolve("deploy/pilot/Caddyfile");
  const run = spawnSync(docker, [
    "run",
    "--rm",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::80",
    "--add-host",
    "core:127.0.0.1",
    "--env",
    "CADDY_EMAIL=review-probe@example.invalid",
    "--env",
    "IRIS_PUBLIC_HOSTNAME=:80",
    "--env",
    "IRIS_INGRESS_HEALTH_TOKEN=review-probe-token",
    "--volume",
    `${caddyPath}:/etc/caddy/Caddyfile:ro`,
    image,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  try {
    const portResult = spawnSync(docker, ["port", name, "80/tcp"], { encoding: "utf8" });
    assert.equal(portResult.status, 0, portResult.stderr || portResult.stdout);
    const port = /:(\d+)\s*$/u.exec(portResult.stdout)?.[1];
    assert.ok(port, `Unable to read Caddy probe port: ${portResult.stdout}`);
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin);

    for (const request of [
      { method: "GET", path: "/review/action-proposals/proposal-1" },
      { method: "GET", path: "/review/oauth/callback" },
      { method: "POST", path: "/review/action-proposals/proposal-1/attest" },
    ]) {
      const response = await fetch(`${origin}${request.path}`, {
        method: request.method,
        redirect: "manual",
      });
      assert.equal(response.status, 502, `${request.method} ${request.path} must reach reverse_proxy`);
      await response.body?.cancel();
    }

    for (const request of [
      { method: "POST", path: "/review/action-proposals/proposal-1" },
      { method: "GET", path: "/review/action-proposals/proposal-1/attest" },
      { method: "GET", path: "/review" },
      { method: "GET", path: "/review/action-proposals/proposal-1/" },
      { method: "GET", path: "/review/action-proposals/proposal-1/extra" },
      { method: "GET", path: "/review/oauth/callback/extra" },
      { method: "GET", path: "/internal/status" },
    ]) {
      const response = await fetch(`${origin}${request.path}`, {
        method: request.method,
        redirect: "manual",
      });
      assert.equal(response.status, 404, `${request.method} ${request.path} must fail closed at Caddy`);
      await response.body?.cancel();
    }
  } finally {
    spawnSync(docker, ["rm", "--force", name], { encoding: "utf8" });
  }
});

test("keeps action review default-off and does not track a review session secret", () => {
  assert.equal(readEnvAssignment(pilotCiEnv, "IRIS_ACTION_REVIEW_ENABLED"), "false");
  assert.equal(readEnvAssignment(pilotCiEnv, "IRIS_REVIEW_PUBLIC_ORIGIN"), "");
  assert.equal(readEnvAssignment(pilotCiEnv, "IRIS_REVIEW_SESSION_SECRET"), "");
  assert.equal(compose.services.core.environment.IRIS_ACTION_REVIEW_ENABLED, "false");
  assert.equal(compose.services.core.environment.IRIS_REVIEW_SESSION_SECRET, "");
  assert.equal(compose.services.core.environment.IRIS_REVIEW_PUBLIC_ORIGIN, "");
  assert.doesNotMatch(pilotCiEnv, /IRIS_REVIEW_SESSION_SECRET=(?!\s*$).+/mu);
});

test("requires exhaustive group isolation and a real proactive-speech status gate", () => {
  const globalEnableIndex = conversationStateAcceptanceRunbook.indexOf("# GLOBAL_ENABLE");
  assert.notEqual(globalEnableIndex, -1, "runbook must mark the global-enable boundary");
  const beforeGlobalEnable = conversationStateAcceptanceRunbook.slice(0, globalEnableIndex);

  for (const marker of [
    "conversation_messages",
    "group_memories",
    "discussion_threads",
    "action_items",
    "$currentBotGroupIds",
    "$databaseGroupIds",
    "$knownGroupIds",
    "$nonPilotGroupIds",
    "foreach ($groupId in $nonPilotGroupIds)",
    "$statusBeforeGlobalEnable",
  ]) {
    assert.match(
      beforeGlobalEnable,
      new RegExp(escapeRegExp(marker), "u"),
      `${marker} must be established before global enable`,
    );
  }
  assert.match(
    beforeGlobalEnable,
    /Assert-ExactDisabledGroupSet -Status \$statusBeforeGlobalEnable -ExpectedGroupIds \$nonPilotGroupIds/u,
  );
  assert.match(
    beforeGlobalEnable,
    /Assert-ProactiveSpeechDisabled -Status \$statusBeforeGlobalEnable/u,
  );

  const afterGlobalEnable = conversationStateAcceptanceRunbook.slice(globalEnableIndex);
  for (const marker of [
    "## Control-Group Negative Test",
    "$controlBefore",
    "ordinary message",
    "mention",
    "$controlAfter",
    "Assert-ControlSnapshotUnchanged",
    "no Feishu reply",
    "uninventoried group",
  ]) {
    assert.match(afterGlobalEnable, new RegExp(escapeRegExp(marker), "ui"));
  }
});

test("derives knowledge-card isolation from the complete live and historical group inventory", () => {
  for (const marker of [
    "$currentBotGroupIds",
    "$databaseGroupIds",
    "$knownGroupIds",
    "$currentNonPilotGroupIds",
    "$nonPilotGroupIds",
    "conversation_messages",
    "group_memories",
    "discussion_threads",
    "action_items",
  ]) {
    assert.match(
      knowledgeCardAcceptanceRunbook,
      new RegExp(escapeRegExp(marker), "u"),
      `${marker} must participate in the knowledge-card group inventory`,
    );
  }
  assert.match(
    knowledgeCardAcceptanceRunbook,
    /\$currentBotGroupIds\s+-notcontains\s+\$PilotGroupId/u,
  );
  assert.match(
    knowledgeCardAcceptanceRunbook,
    /\$currentNonPilotGroupIds\.Count\s+-lt\s+1/u,
  );
  assert.match(
    knowledgeCardAcceptanceRunbook,
    /foreach \(\$groupId in \$knownGroupIds\)/u,
  );
  assert.match(knowledgeCardAcceptanceRunbook, /完整 `\$currentNonPilotGroupIds`/u);
  assert.doesNotMatch(knowledgeCardAcceptanceRunbook, /IRIS_KNOWN_GROUP_ID_[123]/u);
  assert.doesNotMatch(knowledgeCardAcceptanceRunbook, /exactly three|三个已知群/u);
});

test("requires best-effort fail-closed rollback after every global-enable attempt", () => {
  const rollbackStart = conversationStateAcceptanceRunbook.indexOf(
    "function Invoke-FailClosedRollback",
  );
  const rollbackEnd = conversationStateAcceptanceRunbook.indexOf("## Gray Execution Wrapper");
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart, "rollback helper must be executable");
  const rollback = conversationStateAcceptanceRunbook.slice(rollbackStart, rollbackEnd);

  assertMarkersInOrder(rollback, [
    "/internal/runtime-control/global",
    "groups/$pilotGroupId",
    "stop caddy",
    "foreach ($groupId in $nonPilotGroupIds)",
    "Wait-ConversationDrain",
    "IRIS_THREAD_EXTRACTION_GROUP_IDS=",
    "IRIS_ACTION_EXTRACTION_GROUP_IDS=",
    "IRIS_MEMORY_EXTRACTION_ENABLED=false",
    "--force-recreate --wait --wait-timeout 120 core",
    "Assert-FailClosedState",
    "Assert-QueuesNotGrowing",
  ]);
  const rollbackSupport = conversationStateAcceptanceRunbook.slice(
    conversationStateAcceptanceRunbook.indexOf("function Invoke-RollbackStep"),
    rollbackEnd,
  );
  assert.match(rollbackSupport, /catch\s*\{[\s\S]*RollbackErrors/u);

  const wrapper = conversationStateAcceptanceRunbook.slice(rollbackEnd);
  assert.match(wrapper, /\$controllerKeepEnabled\s*=\s*\$false/u);
  assert.match(wrapper, /try\s*\{/u);
  assert.match(wrapper, /finally\s*\{[\s\S]*Invoke-FailClosedRollback/u);
  assert.match(wrapper, /AggregateException/u);
});

test("requires zero conversation-state queues, exact processing lists, and repairs", () => {
  const runbook = conversationStateAcceptanceRunbook;
  const defaultProcessingKeyMatch =
    /const DEFAULT_PROCESSING_KEY = "([^"]+)";/u.exec(documentReindexQueueSource);
  assert.ok(defaultProcessingKeyMatch, "reindex runtime must declare DEFAULT_PROCESSING_KEY");
  const runtimeReindexProcessingKey = defaultProcessingKeyMatch[1];
  assert.equal(runtimeReindexProcessingKey, "iris:reindex:documents:processing");

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
  assert.match(runbook, /LLEN iris:documents:sync:processing/u);
  assert.match(
    runbook,
    new RegExp(`LLEN ${escapeRegExp(runtimeReindexProcessingKey)}`, "u"),
    "runbook must drain the runtime's exact document-reindex processing list",
  );
  assert.match(runbook, /\$documentSyncProcessing\s+-ne\s+0/u);
  assert.match(runbook, /\$documentReindexProcessing\s+-ne\s+0/u);
});

test("keeps Phase 5A knowledge draft facts isolated and fail closed", () => {
  const runbook = readFileSync(
    "docs/runbooks/iris-knowledge-draft-facts-acceptance.md",
    "utf8",
  );
  for (const marker of [
    "Phase 5A",
    "globalEnabled=false",
    "no model call",
    "no answer retrieval",
    "no Feishu send",
    "no confirm/approve/publish route",
    "evidence invalidation redaction",
    "fail-closed rollback",
    "/internal/knowledge-drafts/status",
    "/internal/knowledge-drafts/:id/events",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(marker), "u"), `${marker} gate is required`);
  }
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

async function waitForHttp(origin) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${origin}/review`, { redirect: "manual" });
      await response.body?.cancel();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`Caddy probe did not become ready: ${String(lastError)}`);
}

function assertMarkersInOrder(contents, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const markerIndex = contents.indexOf(marker);
    assert.ok(markerIndex > previousIndex, `${marker} must appear in order`);
    previousIndex = markerIndex;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
