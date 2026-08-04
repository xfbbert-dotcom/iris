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
const wikiSpaceSyncRunbook = readFileSync(
  "docs/runbooks/iris-wiki-space-sync.md",
  "utf8",
);
const pilotOperationsReadme = readFileSync("deploy/pilot/README.md", "utf8");
const internalRolloutRunbook = readFileSync(
  "docs/operations/internal-rollout-runbook.md",
  "utf8",
);
const engineeringFailureLedger = readFileSync(
  "docs/operations/engineering-failure-ledger.md",
  "utf8",
);
const documentReindexQueueSource = readFileSync(
  "apps/core/src/reindex/redis-document-reindex-queue.ts",
  "utf8",
);
const caddyfile = readFileSync("deploy/pilot/Caddyfile", "utf8");
const pilotCiEnv = readFileSync("deploy/pilot/ci.env", "utf8");
const pilotEnvExample = readFileSync(".env.pilot.example", "utf8");
const localEmbeddingMigrationScript = readFileSync(
  "deploy/pilot/migrate-local-embedding.sh",
  "utf8",
);

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

test("passes the execution-ledger gate into the Core container while disabled by default", () => {
  const name = "IRIS_AGENT_EXECUTION_LEDGER_ENABLED";

  assert.equal(readEnvAssignment(pilotCiEnv, name), "false");
  assert.equal(readEnvAssignment(pilotEnvExample, name), "false");
  assert.equal(compose.services.core.environment[name], "false");
});

test("keeps model services private with dedicated model egress", () => {
  const aiWorker = compose.services["ai-worker"];
  const embeddingModelInit = compose.services["embedding-model-init"];
  const embeddingModel = compose.services["embedding-model"];
  const embeddingModelVerify = compose.services["embedding-model-verify"];
  const core = compose.services.core;
  const expectedOllamaImage =
    "ollama/ollama:0.32.0@sha256:57f573b47f1f71ebb445789f279fe3e596a8beab182f7cf486db9205bad87c5a";

  assert.match(aiWorker.build.context, /[\\/]workers[\\/]ai$/u);
  assert.equal(aiWorker.ports, undefined);
  assert.deepEqual(aiWorker.networks, { backend: null, "model-egress": null });
  assert.equal(aiWorker.networks.edge, undefined);
  assert.equal(compose.networks.backend.internal, true);
  assert.equal(compose.networks["model-egress"].driver, "bridge");
  assert.notEqual(compose.networks["model-egress"].internal, true);
  for (const [serviceName, service] of Object.entries(compose.services)) {
    if (!new Set(["ai-worker", "embedding-model-init"]).has(serviceName)) {
      assert.equal(
        service.networks?.["model-egress"],
        undefined,
        `${serviceName} must not join model-egress`,
      );
    }
  }

  assert.equal(embeddingModelInit.image, expectedOllamaImage);
  assert.equal(embeddingModel.image, expectedOllamaImage);
  assert.equal(embeddingModelInit.ports, undefined);
  assert.deepEqual(Object.keys(embeddingModelInit.environment).sort(), [
    "IRIS_EMBEDDING_MODEL",
    "IRIS_EMBEDDING_MODEL_MANIFEST_SHA256",
    "OLLAMA_HOST",
  ]);
  assert.equal(embeddingModel.ports, undefined);
  assert.deepEqual(embeddingModel.networks, { backend: null });
  assert.deepEqual(embeddingModelInit.networks, { "model-egress": null });
  assert.equal(embeddingModelVerify.ports, undefined);
  assert.deepEqual(embeddingModelVerify.networks, { backend: null });
  assert.deepEqual(Object.keys(embeddingModelVerify.environment).sort(), [
    "IRIS_EMBEDDING_BASE_URL",
    "IRIS_EMBEDDING_DIMENSIONS",
    "IRIS_EMBEDDING_MODEL",
    "IRIS_EMBEDDING_MODEL_MANIFEST_SHA256",
    "IRIS_EMBEDDING_MODEL_ROOT",
    "IRIS_EMBEDDING_NORM_TOLERANCE",
    "IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS",
  ]);
  assert.equal(
    embeddingModelVerify.environment.IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS,
    core.environment.IRIS_EMBEDDING_TIMEOUT_MS,
  );
  for (const forbiddenEnvironmentName of [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "IRIS_INTERNAL_API_TOKEN",
    "IRIS_MODEL_API_KEY",
    "IRIS_MEMORY_EXTRACTION_MODEL_API_KEY",
  ]) {
    assert.equal(embeddingModelVerify.environment[forbiddenEnvironmentName], undefined);
  }
  assert.deepEqual(embeddingModel.volumes, [
    {
      type: "volume",
      source: "iris_embedding_models",
      target: "/root/.ollama",
      volume: {},
    },
  ]);
  assert.deepEqual(embeddingModelInit.volumes, embeddingModel.volumes);
  assert.deepEqual(embeddingModelVerify.volumes, [
    {
      type: "volume",
      source: "iris_embedding_models",
      target: "/var/lib/iris-ollama",
      read_only: true,
    },
  ]);
  assert.equal(
    embeddingModelVerify.environment.IRIS_EMBEDDING_MODEL_ROOT,
    "/var/lib/iris-ollama/models",
  );
  assert.equal(embeddingModel.deploy.resources.limits.memory, "805306368");
  assert.equal(embeddingModel.deploy.resources.limits.cpus, 1.5);
  assert.equal(embeddingModel.environment.OLLAMA_NUM_PARALLEL, "1");
  assert.equal(embeddingModel.environment.OLLAMA_KEEP_ALIVE, "30m");
  assert.equal(embeddingModel.environment.OLLAMA_MAX_LOADED_MODELS, "1");
  assert.equal(
    embeddingModel.environment.IRIS_EMBEDDING_MODEL_MANIFEST_SHA256,
    "101341d65c2ccbf23f16650b79d30b9fca94a45ffa09a9984c600157b81a58df",
  );
  const runtimeHealthcheck = embeddingModel.healthcheck.test.join(" ").replace(/\$\$/gu, "$");
  assert.match(runtimeHealthcheck, /OLLAMA_HOST=127\.0\.0\.1:11434 ollama list/u);
  assert.match(runtimeHealthcheck, /model_tag=\$\{IRIS_EMBEDDING_MODEL#\*:\}/u);
  assert.match(
    runtimeHealthcheck,
    /manifest="\/root\/\.ollama\/models\/manifests\/registry\.ollama\.ai\/library\/\$\{model_name\}\/\$\{model_tag\}"/u,
  );
  assert.match(
    runtimeHealthcheck,
    /awk -v expected="\$\{IRIS_EMBEDDING_MODEL\}" 'NR > 1 && \$1 == expected/u,
  );
  assert.match(runtimeHealthcheck, /sha256sum -c -/u);
  assert.equal(embeddingModelInit.command.length, 1);
  const initCommand = embeddingModelInit.command[0].replace(/\$\$/gu, "$");
  assert.match(
    initCommand,
    /cleanup\(\) \{\s+if kill -0 "\$server_pid" 2>\/dev\/null; then kill "\$server_pid" \|\| true; fi\s+wait "\$server_pid" 2>\/dev\/null \|\| true\s+\}/u,
  );
  assert.match(initCommand, /for attempt in \$\(seq 1 60\); do/u);
  assert.match(
    initCommand,
    /if \[ "\$ready" != true \]; then cat "\$ollama_log" >&2 \|\| true; exit 1; fi/u,
  );
  assert.match(initCommand, /model_name=\$\{IRIS_EMBEDDING_MODEL%:\*\}/u);
  assert.match(initCommand, /model_tag=\$\{IRIS_EMBEDDING_MODEL#\*:\}/u);
  assert.match(
    initCommand,
    /manifest="\/root\/.ollama\/models\/manifests\/registry\.ollama\.ai\/library\/\$\{model_name\}\/\$\{model_tag\}"/u,
  );
  assert.match(initCommand, /ollama pull "\$IRIS_EMBEDDING_MODEL"/u);
  assert.match(initCommand, /sha256sum -c -/u);
  assert.match(initCommand, /"digest"\[\[:space:\]\]\*:\[\[:space:\]\]\*"sha256:/u);
  assert.match(initCommand, /digest_path=\$\(printf '%s' "\$digest" \| sed 's\/:\/-\/'\)/u);
  assert.match(initCommand, /blob="\/root\/\.ollama\/models\/blobs\/\$\{digest_path\}"/u);
  assert.match(
    initCommand,
    /if verify_model_cache; then[\s\S]*?else[\s\S]*?ollama pull "\$IRIS_EMBEDDING_MODEL"[\s\S]*?verify_model_cache/u,
    "the egress-enabled seed must repair any incomplete cache and reverify it",
  );
  assert.deepEqual(embeddingModelVerify.command, [
    "node",
    "/opt/iris/verify-local-embedding.mjs",
  ]);
  assert.equal(
    embeddingModelVerify.depends_on["embedding-model"].condition,
    "service_healthy",
  );
  assert.equal(embeddingModelVerify.restart, "no");
  assert.deepEqual(embeddingModel.logging, {
    driver: "json-file",
    options: { "max-file": "5", "max-size": "10m" },
  });
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

  assert.equal(core.environment.IRIS_EMBEDDING_BASE_URL, "http://embedding-model:11434/v1");
  assert.equal(core.environment.IRIS_EMBEDDING_MODEL, "embeddinggemma:300m-qat-q4_0");
  assert.equal(core.environment.IRIS_EMBEDDING_DIMENSIONS, "768");
  assert.equal(core.environment.IRIS_EMBEDDING_BATCH_SIZE, "4");
  assert.equal(core.environment.IRIS_EMBEDDING_TIMEOUT_MS, "60000");
  assert.equal(
    readEnvAssignment(pilotCiEnv, "IRIS_EMBEDDING_MODEL"),
    "embeddinggemma:300m-qat-q4_0",
  );
  assert.equal(
    readEnvAssignment(pilotCiEnv, "IRIS_EMBEDDING_MODEL_MANIFEST_SHA256"),
    "101341d65c2ccbf23f16650b79d30b9fca94a45ffa09a9984c600157b81a58df",
  );
  assert.equal(
    readEnvAssignment(pilotEnvExample, "IRIS_EMBEDDING_MODEL"),
    "embeddinggemma:300m-qat-q4_0",
  );
  assert.equal(
    readEnvAssignment(pilotEnvExample, "IRIS_EMBEDDING_MODEL_MANIFEST_SHA256"),
    "101341d65c2ccbf23f16650b79d30b9fca94a45ffa09a9984c600157b81a58df",
  );
  assert.equal(readEnvAssignment(pilotCiEnv, "IRIS_EMBEDDING_BATCH_SIZE"), "4");
  assert.equal(readEnvAssignment(pilotEnvExample, "IRIS_EMBEDDING_BATCH_SIZE"), "4");
  assert.equal(readEnvAssignment(pilotCiEnv, "IRIS_EMBEDDING_TIMEOUT_MS"), "60000");
  assert.equal(readEnvAssignment(pilotEnvExample, "IRIS_EMBEDDING_TIMEOUT_MS"), "60000");
  assert.equal(core.environment.IRIS_AI_WORKER_BASE_URL, "http://ai-worker:8000");
  assert.ok(core.environment.IRIS_AI_WORKER_TOKEN);
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_ENABLED, "false");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_INTERVAL_MS, "1000");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_BATCH_LIMIT, "20");
  assert.equal(core.environment.IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE, "0.85");
  assert.equal(core.depends_on["ai-worker"].condition, "service_started");
  assert.equal(core.depends_on["embedding-model"].condition, "service_healthy");
  assert.equal(
    core.depends_on["embedding-model-verify"].condition,
    "service_completed_successfully",
  );
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

test("keeps wiki space sync default-off with deterministic Compose wiring", () => {
  const expectedValues = {
    IRIS_WIKI_SPACE_SYNC_ENABLED: "false",
    IRIS_WIKI_SPACE_SYNC_INTERVAL_MS: "1000",
    IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS: "21600000",
    IRIS_WIKI_SPACE_SYNC_LEASE_MS: "600000",
    IRIS_WIKI_SPACE_SYNC_MAX_DEPTH: "20",
    IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS: "5",
  };

  for (const [name, expected] of Object.entries(expectedValues)) {
    assert.equal(readEnvAssignment(pilotCiEnv, name), expected, `${name} must match in CI env`);
    assert.equal(
      readEnvAssignment(pilotEnvExample, name),
      expected,
      `${name} must match in pilot example`,
    );
    assert.equal(compose.services.core.environment[name], expected, `${name} must survive interpolation`);
  }
});

test("preserves distinct valid wiki space numeric overrides through Compose interpolation", () => {
  const overrides = {
    IRIS_WIKI_SPACE_SYNC_INTERVAL_MS: "12345",
    IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS: "21600001",
    IRIS_WIKI_SPACE_SYNC_LEASE_MS: "600001",
    IRIS_WIKI_SPACE_SYNC_MAX_DEPTH: "19",
    IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS: "7",
  };
  const overriddenCompose = loadPilotCompose("deploy/pilot/ci.env", overrides);

  for (const [name, expected] of Object.entries(overrides)) {
    assert.equal(
      overriddenCompose.services.core.environment[name],
      expected,
      `${name} override must survive interpolation`,
    );
  }
});

test("requires one enabled wiki rescan followed by queue gates and disable", () => {
  const sections = [
    wikiSpaceSyncRunbook.slice(
      wikiSpaceSyncRunbook.indexOf("## Dead-Letter Diagnosis And Recovery"),
      wikiSpaceSyncRunbook.indexOf("## Permission Revocation Second Check"),
    ),
    wikiSpaceSyncRunbook.slice(
      wikiSpaceSyncRunbook.indexOf("## Permission Revocation Second Check"),
      wikiSpaceSyncRunbook.indexOf("## Rollback"),
    ),
  ];

  for (const section of sections) {
    assertMarkersInOrder(section, [
      "Enable the retained root",
      "-Body '{\"enabled\":true}'",
      "/rescan",
      "Observe the resulting authorization and all event/document/reindex queue/DLQ gates",
      "Disable the root again",
      "-Body '{\"enabled\":false}'",
    ]);
    assert.equal(
      section.match(/\/rescan"/gu)?.length,
      1,
      "each recovery procedure must request exactly one rescan",
    );
  }
});

test("requires rollback to verify wiki sync from a fresh authenticated status", () => {
  const rollback = wikiSpaceSyncRunbook.slice(
    wikiSpaceSyncRunbook.indexOf("## Rollback"),
  );

  assertMarkersInOrder(rollback, [
    "`IRIS_WIKI_SPACE_SYNC_ENABLED=false`",
    "After Core is healthy",
    "$statusAfterRollback = Invoke-RestMethod",
    "/internal/status",
    "$statusAfterRollback.components.documentSync.wikiSpaces",
  ]);
  assert.doesNotMatch(
    rollback,
    /\$status\.components\.documentSync\.wikiSpaces/u,
    "rollback must not inspect the pre-restart status snapshot",
  );
});

test("requires fail-closed local embedding profile migration operations", () => {
  assertMarkersInOrder(pilotOperationsReadme, [
    "## Local Embedding Profile Rollout",
    "before Core can start",
    "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
    "before deleting any old-profile DLQ entry",
    "/internal/reindex/document-profile",
    "Life Engine",
    "Start Caddy only after",
  ]);

  for (const marker of [
    "Life Engine retrieval gate",
  ]) {
    assert.match(pilotOperationsReadme, new RegExp(escapeRegExp(marker), "u"));
  }
  assert.match(pilotOperationsReadme, /full stored\s+model-manifest SHA256/u);
  assert.match(pilotOperationsReadme, /old-profile\s+DLQ evidence\s+before deleting/u);
  assert.match(pilotOperationsReadme, /preserve the\s+prior-profile fragments/iu);
  assert.match(pilotOperationsReadme, /zero queue and DLQ counts/u);
  assert.match(pilotOperationsReadme, /live Feishu\s+permission guard/u);
  assert.match(pilotOperationsReadme, /Feishu-native related-knowledge UI\s+is not Iris evidence/u);

  assertMarkersInOrder(internalRolloutRunbook, [
    "## Local Embedding Profile Migration",
    "embedding-model-init",
    "Old-Profile DLQ Evidence",
    "Bounded Full Reindex",
    "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
    "Coverage And Private Retrieval",
    "Life Engine",
    "Start Caddy only after",
  ]);

  assert.match(internalRolloutRunbook, /full stored\s+model-manifest SHA256/u);
  assert.match(internalRolloutRunbook, /before\s+Core can start/u);
  assert.match(internalRolloutRunbook, /preserve the\s+prior-profile fragments/iu);
  assert.match(internalRolloutRunbook, /zero queue and DLQ counts/u);
  assert.match(internalRolloutRunbook, /live Feishu permission guard/u);

  assert.match(
    wikiSpaceSyncRunbook,
    /Feishu-native related-knowledge UI\s+is not Iris evidence/u,
  );
  assert.match(
    engineeringFailureLedger,
    /Gemini.*embed_content_free_tier_requests/u,
  );
  assert.match(
    engineeringFailureLedger,
    /old-profile\s+DLQ evidence/u,
  );
});

test("makes local embedding migration commands evidence-first and fail closed", () => {
  const migration = internalRolloutRunbook.slice(
    internalRolloutRunbook.indexOf("## Local Embedding Profile Migration"),
    internalRolloutRunbook.indexOf("### Controlled Daily Pilot Profile"),
  );
  const oldProfileDlqStart = migration.indexOf("### Old-Profile DLQ Evidence");
  const bootstrap = migration.slice(0, oldProfileDlqStart);

  assert.match(
    localEmbeddingMigrationScript,
    /assert_completed_service "embedding-model-init"/u,
    "completed seed inspection must include the stopped one-shot service",
  );
  assert.match(
    migration,
    /IRIS_EMBEDDING_MODEL_MANIFEST_SHA256=101341d65c2ccbf23f16650b79d30b9fca94a45ffa09a9984c600157b81a58df/u,
  );

  assert.match(
    migration,
    /deploy\/pilot\/migrate-local-embedding\.sh/u,
    "the runbook must invoke one executable VPS migration entrypoint",
  );
  assert.doesNotMatch(
    migration,
    /```powershell|\bInvoke-RestMethod\b|\$irisHeaders|\bdocker @compose\b/u,
    "the Ubuntu migration path must not fall back to an undefined PowerShell context",
  );
  assert.match(localEmbeddingMigrationScript, /^#!\/usr\/bin\/env bash\r?$/mu);
  assert.match(localEmbeddingMigrationScript, /set -Eeuo pipefail/u);
  assert.match(localEmbeddingMigrationScript, /process\.env\.IRIS_INTERNAL_API_TOKEN/u);
  assert.doesNotMatch(
    localEmbeddingMigrationScript,
    /\$env:IRIS_INTERNAL_API_TOKEN|\$IRIS_INTERNAL_API_TOKEN|\$\{IRIS_INTERNAL_API_TOKEN/u,
    "the VPS host shell must never read or interpolate the internal bearer token",
  );

  assert.match(localEmbeddingMigrationScript, /function safeFailureClassification/u);
  assert.match(localEmbeddingMigrationScript, /\/internal\/reindex\/dead-letters\?limit=100/u);
  assert.match(localEmbeddingMigrationScript, /failureClassification/u);
  assert.match(localEmbeddingMigrationScript, /tail -n 1/u);
  assert.doesNotMatch(
    localEmbeddingMigrationScript,
    /old Gemini profile ID/u,
    "the migration must accept the exact prior local or hosted embedding profile",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /if \[\[ "\$\{old_profile_id\}" == "\$\{profile_id\}" \]\]; then[\s\S]*?return 1/u,
    "the old profile must differ from the target profile",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /case "current-profile":[\s\S]*?activeEmbeddingProfileId[\s\S]*?process\.stdout\.write/u,
    "the migration must read the actual active profile before replacing Core",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /active_profile_before_migration="\$\(core_operation current-profile\)"[\s\S]*?if \[\[ "\$\{active_profile_before_migration\}" != "\$\{old_profile_id\}" \]\]; then[\s\S]*?return 1/u,
    "the operator-supplied old profile must match the active pre-migration profile",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /core_operation delete-dlq "\$\{dead_letter_id\}" <\/dev\/null/u,
    "deleting one DLQ entry must not consume the remaining evidence loop input",
  );
  assert.doesNotMatch(localEmbeddingMigrationScript, /reviewedOldProfileDlqId/u);

  assert.match(
    localEmbeddingMigrationScript,
    /\/internal\/status[\s\S]*?\/internal\/events\/status[\s\S]*?\/internal\/reindex\/status[\s\S]*?LLEN iris:events:raw:processing[\s\S]*?LLEN iris:documents:sync:processing[\s\S]*?LLEN iris:reindex:documents:processing[\s\S]*?ZCARD iris:memory:extraction:ready:index[\s\S]*?ZCARD iris:memory:extraction:processing[\s\S]*?ZCARD iris:memory:extraction:delayed[\s\S]*?SCARD iris:memory:extraction:dlq:ids/u,
    "each reindex gate must inspect event, document, reindex, memory, and processing state",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /async function request\(method, path, body, \{ requirePayloadOk = true \} = \{\}\)[\s\S]*?if \(!response\.ok \|\| \(requirePayloadOk && payload\?\.ok !== true\)\)/u,
    "HTTP success and endpoint-level health must be separable for aggregate status reads",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /request\("GET", "\/internal\/status", undefined, \{ requirePayloadOk: false \}\)/u,
    "queue gates must inspect relevant components even when unrelated aggregate components are degraded",
  );
  assert.doesNotMatch(
    localEmbeddingMigrationScript,
    /LLEN iris:memory:extraction:processing/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /for reindex_batch in \$\(seq 1 1000\)[\s\S]*?core_operation plan-reindex[\s\S]*?wait_queue_gate[\s\S]*?enqueued_count/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /wait_queue_gate\(\)[\s\S]*?if ! dead_letter_gate "\$\{counts\[@\]\}"; then[\s\S]*?return 1[\s\S]*?sleep 2/u,
    "a newly created DLQ must abort immediately instead of waiting for the zero gate timeout",
  );
  assert.match(localEmbeddingMigrationScript, /\/internal\/reindex\/document-profile/u);
  assert.match(localEmbeddingMigrationScript, /authorized_wiki_document/u);
  assert.match(
    localEmbeddingMigrationScript,
    /with latest_successful_snapshots as \([\s\S]*?where s\.fetch_status = 'succeeded'[\s\S]*?order by s\.document_source_id asc, s\.fetched_at desc, s\.id asc[\s\S]*?\)\s*select count\(\*\)\s*from latest_successful_snapshots s\s*join document_sources ds/u,
    "coverage must select each source's latest successful snapshot before eligibility filtering",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /select distinct on \(s\.document_source_id\) s\.id,\s*s\.document_source_id,\s*s\.body_text/u,
    "coverage must project every snapshot column used by the outer authorization and body gates",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /ds\.can_use_for_answering = true[\s\S]*?ds\.permission_state in \('unknown', 'readable'\)[\s\S]*?s\.body_text is not null[\s\S]*?s\.body_text !~ '\^\[\[:space:\]\]\*\$'/u,
    "coverage must exclude disabled, denied, stale, and empty sources",
  );
  assert.match(localEmbeddingMigrationScript, /document_fragment_embeddings_768/u);
  assert.match(localEmbeddingMigrationScript, /not exists/u);
  assert.match(
    localEmbeddingMigrationScript,
    /Latest successful authorized-wiki missing EmbeddingGemma-profile fragment count is not zero/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /\/internal\/answer-drafts[\s\S]*?allowedFragments/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /request\("POST", "\/internal\/answer-drafts", \{[\s\S]*?\}, \{ requirePayloadOk: false \}\)/u,
    "answer acceptance must use the answer-draft success contract, which has no top-level ok field",
  );
  assert.match(localEmbeddingMigrationScript, /IRIS_LIFE_ENGINE_MARKER/u);
  assert.match(
    localEmbeddingMigrationScript,
    /fail_closed_cleanup\(\)[\s\S]*?disable_runtime[\s\S]*?compose_cmd stop caddy[\s\S]*?assert_caddy_stopped[\s\S]*?compose_cmd stop core[\s\S]*?assert_core_stopped/u,
    "every migration exit must re-disable runtime and prove ingress stopped",
  );

  assert.doesNotMatch(bootstrap, /```powershell|\bpwsh\b|\bPowerShell\b/u);
  assert.match(
    localEmbeddingMigrationScript,
    /function requireInternalToken\(\)[\s\S]*?single visible ASCII token/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /assert_caddy_stopped\(\)[\s\S]*?if ! running_services="\$\(compose_cmd ps --status running --services\)"; then[\s\S]*?return 1/u,
    "a failed service-status query must not prove that Caddy is stopped",
  );
  assert.match(
    localEmbeddingMigrationScript,
    /compose_cmd config --format json \|[\s\S]*?compose_cmd run --rm --no-deps -T --entrypoint node core/u,
    "rendered configuration must be validated inside Core without exposing its token",
  );
  assertMarkersInOrder(localEmbeddingMigrationScript, [
    "trap fail_closed_cleanup EXIT",
    'runtime_before_migration="$(core_operation runtime-status)"',
    'active_profile_before_migration="$(core_operation current-profile)"',
    'if [[ "${active_profile_before_migration}" != "${old_profile_id}" ]]',
    "disable_runtime",
    "compose_cmd stop caddy",
    "assert_caddy_stopped",
    'record_backup_evidence "${previous_global_enabled}"',
    "validate_rendered_config",
    "compose_cmd up --detach --wait --wait-timeout 600 --force-recreate",
    'assert_completed_service "embedding-model-init"',
    'assert_completed_service "embedding-model-verify"',
    "assert_active_profile",
  ]);
  assert.match(
    localEmbeddingMigrationScript,
    /IRIS_EMBEDDING_BASE_URL[\s\S]*?http:\/\/embedding-model:11434\/v1[\s\S]*?IRIS_EMBEDDING_MODEL[\s\S]*?embeddinggemma:300m-qat-q4_0[\s\S]*?IRIS_EMBEDDING_DIMENSIONS[\s\S]*?768[\s\S]*?IRIS_EMBEDDING_BATCH_SIZE[\s\S]*?4[\s\S]*?IRIS_EMBEDDING_TIMEOUT_MS[\s\S]*?60000/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /verifier\.environment\.IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS !== "60000"/u,
  );
  assert.match(
    localEmbeddingMigrationScript,
    /compose_cmd up[\s\S]*?--force-recreate[\s\S]*?migrate[\s\S]*?embedding-model-verify[\s\S]*?core/u,
  );
  for (const redisMemoryGate of [
    "ZCARD iris:memory:extraction:ready:index",
    "ZCARD iris:memory:extraction:processing",
    "ZCARD iris:memory:extraction:delayed",
    "SCARD iris:memory:extraction:dlq:ids",
  ]) {
    assert.match(wikiSpaceSyncRunbook, new RegExp(escapeRegExp(redisMemoryGate), "u"));
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

test("proxies only the static admin console shell and assets", () => {
  assert.match(
    caddyfile,
    /@adminConsole\s*\{\s*method GET\s*path \/admin \/admin\/console\.css \/admin\/console\.js\s*\}/su,
  );
  assert.match(caddyfile, /handle @adminConsole\s*\{\s*reverse_proxy core:3000/su);
  assert.doesNotMatch(caddyfile, /path \/admin\/\*|handle_path \/admin|@admin\s+path/iu);
  assert.doesNotMatch(caddyfile, /path \/internal|@internal|handle_path \/internal/iu);
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
      { method: "GET", path: "/admin" },
      { method: "GET", path: "/admin/console.css" },
      { method: "GET", path: "/admin/console.js" },
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
      { method: "POST", path: "/review/oauth/callback" },
      { method: "GET", path: "/review" },
      { method: "GET", path: "/review/action-proposals/proposal-1/" },
      { method: "GET", path: "/review/action-proposals/proposal-1/extra" },
      { method: "GET", path: "/review/oauth/callback/extra" },
      { method: "POST", path: "/admin" },
      { method: "GET", path: "/admin/" },
      { method: "GET", path: "/admin/extra" },
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
    core.environment.IRIS_AI_WORKER_TOKEN,
    aiWorker.environment.IRIS_AI_WORKER_TOKEN,
    aiWorker.environment.IRIS_MODEL_API_KEY,
  ]) {
    assert.match(value, /^replace-with-/u);
  }
  assert.equal(core.environment.IRIS_EMBEDDING_API_KEY, "ollama");
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

function loadPilotCompose(envFile = "deploy/pilot/ci.env", overrides = {}) {
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
    { encoding: "utf8", env: { ...process.env, ...overrides } },
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
    const markerIndex = contents.indexOf(marker, previousIndex + 1);
    assert.ok(markerIndex > previousIndex, `${marker} must appear in order`);
    previousIndex = markerIndex;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
