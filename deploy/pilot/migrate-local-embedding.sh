#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

compose=(docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml)
profile_id="openai-compatible:embeddinggemma:300m-qat-q4_0:768"
expected_manifest_sha="101341d65c2ccbf23f16650b79d30b9fca94a45ffa09a9984c600157b81a58df"
expected_ollama_image="ollama/ollama:0.32.0@sha256:57f573b47f1f71ebb445789f279fe3e596a8beab182f7cf486db9205bad87c5a"

operator_evidence_path="${IRIS_OPERATOR_EVIDENCE_PATH:-}"
old_profile_id="${IRIS_OLD_EMBEDDING_PROFILE_ID:-}"
life_engine_chat_id="${IRIS_LIFE_ENGINE_CHAT_ID:-}"
life_engine_source_id="${IRIS_LIFE_ENGINE_SOURCE_ID:-}"
life_engine_marker="${IRIS_LIFE_ENGINE_MARKER:-}"

compose_cmd() {
  "${compose[@]}" "$@"
}

assert_caddy_stopped() {
  local running_services
  if ! running_services="$(compose_cmd ps --status running --services)"; then
    echo "Caddy status could not be queried" >&2
    return 1
  fi
  if grep -Fxq caddy <<<"${running_services}"; then
    echo "Caddy stopped state could not be proven" >&2
    return 1
  fi
}

assert_core_stopped() {
  local running_services
  if ! running_services="$(compose_cmd ps --status running --services)"; then
    echo "Core status could not be queried" >&2
    return 1
  fi
  if grep -Fxq core <<<"${running_services}"; then
    echo "Core stopped state could not be proven" >&2
    return 1
  fi
}

core_operation() {
  local operation="$1"
  shift
  compose_cmd exec -T core node --input-type=module --eval '
    const [operation, ...args] = process.argv.slice(1);

    function requireInternalToken() {
      const token = process.env.IRIS_INTERNAL_API_TOKEN ?? "";
      if (!/^[\x21-\x2B\x2D-\x7E]+$/.test(token)) {
        throw new Error("IRIS_INTERNAL_API_TOKEN must be one single visible ASCII token without comma or whitespace");
      }
      return token;
    }

    async function request(method, path, body, { requirePayloadOk = true } = {}) {
      const response = await fetch(`http://127.0.0.1:3000${path}`, {
        method,
        headers: {
          authorization: `Bearer ${requireInternalToken()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`${method} ${path} returned invalid JSON`);
      }
      if (!response.ok || (requirePayloadOk && payload?.ok !== true)) {
        throw new Error(`${method} ${path} failed with HTTP ${response.status}`);
      }
      return payload;
    }

    function requireBoolean(value, label) {
      if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
      return value;
    }

    function requireCount(value, label) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
      }
      return value;
    }

    function safeFailureClassification(errorMessage) {
      if (typeof errorMessage !== "string" || errorMessage.trim().length === 0) return undefined;
      if (/permission|forbidden|unauthorized|denied/iu.test(errorMessage)) return "permission";
      if (/timeout|timed out|deadline/iu.test(errorMessage)) return "timeout";
      if (/rate limit|quota|429/iu.test(errorMessage)) return "quota";
      if (/model|embedding|provider|ollama/iu.test(errorMessage)) return "embedding_provider";
      if (/invalid|malformed|configuration|profile/iu.test(errorMessage)) return "configuration";
      return "other";
    }

    switch (operation) {
      case "runtime-status": {
        const payload = await request("GET", "/internal/runtime-control/status");
        const globalEnabled = requireBoolean(payload.globalEnabled, "globalEnabled");
        const desiredGlobalEnabled = requireBoolean(
          payload.desiredGlobalEnabled,
          "desiredGlobalEnabled",
        );
        process.stdout.write(`${globalEnabled}\t${desiredGlobalEnabled}\n`);
        break;
      }
      case "runtime-disable": {
        const payload = await request(
          "POST",
          "/internal/runtime-control/global",
          { enabled: false },
        );
        if (
          payload.globalEnabled !== false
          || payload.desiredGlobalEnabled !== false
          || payload.durable !== true
        ) {
          throw new Error("Global runtime was not durably disabled");
        }
        break;
      }
      case "runtime-enable": {
        const payload = await request(
          "POST",
          "/internal/runtime-control/global",
          { enabled: true },
        );
        if (payload.globalEnabled !== true || payload.durable !== true) {
          throw new Error("Global runtime was not durably enabled for private acceptance");
        }
        break;
      }
      case "active-profile": {
        const [expectedProfileId] = args;
        const payload = await request("GET", "/internal/reindex/status");
        if (
          payload.enabled !== true
          || payload.running !== true
          || payload.activeEmbeddingProfileId !== expectedProfileId
        ) {
          throw new Error(`Active embedding profile is not exactly ${expectedProfileId}`);
        }
        break;
      }
      case "current-profile": {
        const payload = await request("GET", "/internal/reindex/status");
        const activeEmbeddingProfileId = payload.activeEmbeddingProfileId;
        if (
          typeof activeEmbeddingProfileId !== "string"
          || !/^[A-Za-z0-9:._-]+$/u.test(activeEmbeddingProfileId)
        ) {
          throw new Error("Current active embedding profile is unsafe or unavailable");
        }
        process.stdout.write(`${activeEmbeddingProfileId}\n`);
        break;
      }
      case "list-old-dlq": {
        const [oldProfileId] = args;
        const payload = await request("GET", "/internal/reindex/dead-letters?limit=100");
        if (!Array.isArray(payload.deadLetters)) throw new Error("Reindex DLQ list is malformed");
        for (const deadLetter of payload.deadLetters) {
          if (deadLetter?.job?.embeddingProfileId !== oldProfileId) continue;
          const requiredStrings = [
            deadLetter.id,
            deadLetter.job.embeddingProfileId,
            deadLetter.job.documentSnapshotId,
            deadLetter.job.enqueuedAt,
            deadLetter.failedAt,
          ];
          if (
            requiredStrings.some(
              (value) => typeof value !== "string" || value.trim().length === 0,
            )
          ) {
            throw new Error("Old-profile DLQ entry is missing required evidence fields");
          }
          const attempts = requireCount(deadLetter.job.attempts, "deadLetter.job.attempts");
          const failureClassification = safeFailureClassification(deadLetter.errorMessage);
          if (failureClassification === undefined) {
            throw new Error("Old-profile DLQ failure classification is unavailable");
          }
          const evidence = {
            schemaVersion: 1,
            recordedAt: new Date().toISOString(),
            deadLetterId: deadLetter.id,
            embeddingProfileId: deadLetter.job.embeddingProfileId,
            documentSnapshotId: deadLetter.job.documentSnapshotId,
            enqueuedAt: deadLetter.job.enqueuedAt,
            attempts,
            failedAt: deadLetter.failedAt,
            failureClassification,
          };
          process.stdout.write(`${deadLetter.id}\t${JSON.stringify(evidence)}\n`);
        }
        break;
      }
      case "delete-dlq": {
        const [deadLetterId] = args;
        if (!/^[A-Za-z0-9:._-]+$/u.test(deadLetterId ?? "")) {
          throw new Error("Dead-letter ID is unsafe");
        }
        const payload = await request(
          "DELETE",
          `/internal/reindex/dead-letters/${encodeURIComponent(deadLetterId)}`,
        );
        if (payload.status !== "deleted") throw new Error("Old-profile DLQ delete was not confirmed");
        break;
      }
      case "queue-status": {
        const [expectedProfileId] = args;
        const [status, events, reindex] = await Promise.all([
          request("GET", "/internal/status", undefined, { requirePayloadOk: false }),
          request("GET", "/internal/events/status"),
          request("GET", "/internal/reindex/status"),
        ]);
        const documentSync = status.components?.documentSync;
        if (
          events.enabled !== true
          || events.running !== true
          || documentSync?.ok !== true
          || documentSync.enabled !== true
          || documentSync.running !== true
          || reindex.enabled !== true
          || reindex.running !== true
          || reindex.activeEmbeddingProfileId !== expectedProfileId
        ) {
          throw new Error("Event, document-sync, or reindex runtime is not healthy");
        }
        const counts = [
          requireCount(events.pendingEventCount, "events.pendingEventCount"),
          requireCount(events.deadLetterEventCount, "events.deadLetterEventCount"),
          requireCount(documentSync.pendingJobCount, "documentSync.pendingJobCount"),
          requireCount(documentSync.deadLetterJobCount, "documentSync.deadLetterJobCount"),
          requireCount(reindex.pendingJobCount, "reindex.pendingJobCount"),
          requireCount(reindex.deadLetterJobCount, "reindex.deadLetterJobCount"),
        ];
        process.stdout.write(`${counts.join("\t")}\n`);
        break;
      }
      case "plan-reindex": {
        const [embeddingProfileId] = args;
        const payload = await request(
          "POST",
          "/internal/reindex/document-profile",
          { embeddingProfileId, limit: 100 },
        );
        process.stdout.write(
          `${requireCount(payload.enqueuedCount, "enqueuedCount")}\n`,
        );
        break;
      }
      case "life-engine-answer": {
        const [chatId, sourceId, marker] = args;
        const payload = await request("POST", "/internal/answer-drafts", {
          question: "Return the approved Life Engine marker only.",
          chatId,
          liveChatMessages: [],
        }, { requirePayloadOk: false });
        if (typeof payload.answerText !== "string" || !payload.answerText.includes(marker)) {
          throw new Error("Life Engine marker was not retrieved");
        }
        if (
          !Number.isSafeInteger(payload.retrievedFragmentCount)
          || payload.retrievedFragmentCount < 1
          || !Array.isArray(payload.allowedFragments)
          || !payload.allowedFragments.some(
            (fragment) => fragment?.documentSourceId === sourceId,
          )
        ) {
          throw new Error("Live Feishu permission guard did not allow the expected source");
        }
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            markerMatched: true,
            sourceAllowed: true,
            retrievedFragmentCount: payload.retrievedFragmentCount,
          })}\n`,
        );
        break;
      }
      default:
        throw new Error(`Unsupported migration operation: ${operation}`);
    }
  ' "${operation}" "$@"
}

disable_runtime() {
  core_operation runtime-disable
}

assert_active_profile() {
  core_operation active-profile "$1"
}

validate_rendered_config() {
  compose_cmd config --format json |
    compose_cmd run --rm --no-deps -T --entrypoint node core \
      --input-type=module --eval '
        let raw = "";
        for await (const chunk of process.stdin) raw += chunk;
        const rendered = JSON.parse(raw);
        const core = rendered.services.core.environment;
        const verifier = rendered.services["embedding-model-verify"];
        const seed = rendered.services["embedding-model-init"];
        const model = rendered.services["embedding-model"];
        const [expectedManifestSha, expectedOllamaImage] = process.argv.slice(1);
        const expectedCore = {
          IRIS_EMBEDDING_PROVIDER: "openai-compatible",
          IRIS_EMBEDDING_BASE_URL: "http://embedding-model:11434/v1",
          IRIS_EMBEDDING_API_KEY: "ollama",
          IRIS_EMBEDDING_MODEL: "embeddinggemma:300m-qat-q4_0",
          IRIS_EMBEDDING_DIMENSIONS: "768",
          IRIS_EMBEDDING_BATCH_SIZE: "4",
          IRIS_EMBEDDING_TIMEOUT_MS: "60000",
        };
        for (const [key, value] of Object.entries(expectedCore)) {
          if (core[key] !== value) {
            throw new Error("Rendered Core embedding configuration is not approved");
          }
        }
        const cacheMount = verifier.volumes.find(
          (volume) =>
            volume.type === "volume"
            && volume.source === "iris_embedding_models"
            && volume.target === "/var/lib/iris-ollama"
            && volume.read_only === true,
        );
        if (
          seed.environment.IRIS_EMBEDDING_MODEL_MANIFEST_SHA256 !== expectedManifestSha
          || verifier.environment.IRIS_EMBEDDING_MODEL_MANIFEST_SHA256 !== expectedManifestSha
          || verifier.environment.IRIS_EMBEDDING_BASE_URL !== "http://embedding-model:11434/v1"
          || verifier.environment.IRIS_EMBEDDING_MODEL !== "embeddinggemma:300m-qat-q4_0"
          || verifier.environment.IRIS_EMBEDDING_DIMENSIONS !== "768"
          || verifier.environment.IRIS_EMBEDDING_MODEL_ROOT !== "/var/lib/iris-ollama/models"
          || verifier.environment.IRIS_EMBEDDING_NORM_TOLERANCE !== "0.001"
          || verifier.environment.IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS !== "60000"
          || seed.image !== expectedOllamaImage
          || model.image !== expectedOllamaImage
          || !cacheMount
        ) {
          throw new Error("Rendered model image, cache mount, or manifest is not approved");
        }
      ' "${expected_manifest_sha}" "${expected_ollama_image}"
}

assert_completed_service() {
  local service="$1"
  local ids
  mapfile -t ids < <(compose_cmd ps --all --quiet "${service}")
  if (( ${#ids[@]} != 1 )); then
    echo "${service} does not have exactly one container" >&2
    return 1
  fi
  if [[ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "${ids[0]}")" != "exited 0" ]]; then
    echo "${service} did not exit successfully" >&2
    return 1
  fi
}

fail_closed_cleanup() {
  local original_status=$?
  local disable_proven=false
  local caddy_stop_status=0
  local caddy_stopped_status=0
  local core_stopped_status=0
  trap - EXIT
  set +e

  for attempt in 1 2 3; do
    if disable_runtime; then
      disable_proven=true
      break
    fi
    sleep 2
  done
  compose_cmd stop caddy
  caddy_stop_status=$?
  assert_caddy_stopped
  caddy_stopped_status=$?
  if [[ "${disable_proven}" != true ]]; then
    compose_cmd stop core
    core_stopped_status=$?
    if ! assert_core_stopped; then
      core_stopped_status=1
    fi
  fi

  if (( caddy_stop_status != 0 || caddy_stopped_status != 0 || core_stopped_status != 0 )); then
    echo "FAIL-CLOSED RECOVERY INCOMPLETE: inspect Core and Caddy before proceeding" >&2
    exit 1
  fi
  if [[ "${disable_proven}" != true ]]; then
    echo "Fail-closed cleanup stopped Core because durable disable was not proven" >&2
    exit 1
  fi
  exit "${original_status}"
}
trap fail_closed_cleanup EXIT

require_inputs() {
  if [[ -z "${operator_evidence_path}" || "${operator_evidence_path}" != /* ]]; then
    echo "IRIS_OPERATOR_EVIDENCE_PATH must be an absolute operator-controlled file" >&2
    return 1
  fi
  if [[ ! "${old_profile_id}" =~ ^[A-Za-z0-9:._-]+$ ]]; then
    echo "IRIS_OLD_EMBEDDING_PROFILE_ID must be an exact safe prior profile ID" >&2
    return 1
  fi
  if [[ "${old_profile_id}" == "${profile_id}" ]]; then
    echo "IRIS_OLD_EMBEDDING_PROFILE_ID must differ from the target profile ID" >&2
    return 1
  fi
  for value in "${life_engine_chat_id}" "${life_engine_source_id}" "${life_engine_marker}"; do
    if [[ -z "${value}" || "${value}" == *$'\n'* || "${value}" == *$'\t'* ]]; then
      echo "Life Engine acceptance inputs must be non-empty single-line values" >&2
      return 1
    fi
  done
  install -d -m 700 -- "$(dirname -- "${operator_evidence_path}")"
}

record_backup_evidence() {
  local previous_global_enabled="$1"
  local previous_desired_global_enabled="$2"
  local backup_path
  local evidence_record

  backup_path="$(/usr/local/sbin/iris-backup | tail -n 1)"
  if [[ ! "${backup_path}" =~ ^/[A-Za-z0-9._/-]+$ || ! -f "${backup_path}" ]]; then
    echo "Encrypted paired Postgres/Redis backup was not created" >&2
    return 1
  fi
  evidence_record="$(printf \
    '{"schemaVersion":1,"recordedAt":"%s","event":"local_embedding_migration_backup","backupPath":"%s","previousGlobalEnabled":%s,"previousDesiredGlobalEnabled":%s}' \
    "$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)" \
    "${backup_path}" \
    "${previous_global_enabled}" \
    "${previous_desired_global_enabled}")"
  printf '%s\n' "${evidence_record}" >>"${operator_evidence_path}"
  if [[ "$(tail -n 1 -- "${operator_evidence_path}")" != "${evidence_record}" ]]; then
    echo "Migration backup path evidence write verification failed" >&2
    return 1
  fi
}

record_and_delete_old_dlq() {
  local dlq_output
  local dead_letter_id
  local evidence_record

  dlq_output="$(core_operation list-old-dlq "${old_profile_id}")"
  if [[ -z "${dlq_output}" ]]; then
    return
  fi
  while IFS=$'\t' read -r dead_letter_id evidence_record; do
    if [[ ! "${dead_letter_id}" =~ ^[A-Za-z0-9:._-]+$ || -z "${evidence_record}" ]]; then
      echo "Old-profile DLQ evidence output is malformed" >&2
      return 1
    fi
    printf '%s\n' "${evidence_record}" >>"${operator_evidence_path}"
    if [[ "$(tail -n 1 -- "${operator_evidence_path}")" != "${evidence_record}" ]]; then
      echo "Old-profile DLQ evidence write verification failed" >&2
      return 1
    fi
    core_operation delete-dlq "${dead_letter_id}" </dev/null
  done <<<"${dlq_output}"
}

redis_count() {
  local command="$1"
  local key="$2"
  local value
  value="$(compose_cmd exec -T redis redis-cli "${command}" "${key}")"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "Redis ${command} ${key} did not return a non-negative integer" >&2
    return 1
  fi
  printf '%s\n' "${value}"
}

queue_counts() {
  local api_counts
  local -a counts
  api_counts="$(core_operation queue-status "${profile_id}")"
  IFS=$'\t' read -r -a counts <<<"${api_counts}"
  counts+=(
    "$(redis_count LLEN iris:events:raw:processing)"
    "$(redis_count LLEN iris:documents:sync:processing)"
    "$(redis_count LLEN iris:reindex:documents:processing)"
    "$(redis_count ZCARD iris:memory:extraction:ready:index)"
    "$(redis_count ZCARD iris:memory:extraction:processing)"
    "$(redis_count ZCARD iris:memory:extraction:delayed)"
    "$(redis_count SCARD iris:memory:extraction:dlq:ids)"
  )
  if (( ${#counts[@]} != 13 )); then
    echo "Queue gate did not return all 13 counters" >&2
    return 1
  fi
  for count in "${counts[@]}"; do
    if [[ ! "${count}" =~ ^[0-9]+$ ]]; then
      echo "Queue gate returned a malformed counter" >&2
      return 1
    fi
  done
  local IFS=$'\t'
  printf '%s\n' "${counts[*]}"
}

dead_letter_gate() {
  local -a counts=("$@")
  local index
  for index in 1 3 5 12; do
    if [[ "${counts[${index}]}" != 0 ]]; then
      echo "Event/document/reindex/memory DLQ gate failed" >&2
      return 1
    fi
  done
}

all_zero_gate() {
  local count
  for count in "$@"; do
    if [[ "${count}" != 0 ]]; then
      return 1
    fi
  done
}

queue_gate() {
  local counts_output
  local -a counts
  counts_output="$(queue_counts)"
  IFS=$'\t' read -r -a counts <<<"${counts_output}"
  dead_letter_gate "${counts[@]}"
  if ! all_zero_gate "${counts[@]}"; then
    echo "Event/document/reindex/memory queue or DLQ zero gate failed" >&2
    return 1
  fi
}

wait_queue_gate() {
  local deadline=$((SECONDS + 1800))
  local counts_output
  local -a counts
  while (( SECONDS < deadline )); do
    if ! counts_output="$(queue_counts)"; then
      sleep 2
      continue
    fi
    IFS=$'\t' read -r -a counts <<<"${counts_output}"
    if ! dead_letter_gate "${counts[@]}"; then
      return 1
    fi
    if all_zero_gate "${counts[@]}"; then
      return
    fi
    sleep 2
  done
  echo "Queue and DLQ zero gate did not pass within 30 minutes" >&2
  return 1
}

run_bounded_reindex() {
  local enqueued_count
  local complete=false
  for reindex_batch in $(seq 1 1000); do
    enqueued_count="$(core_operation plan-reindex "${profile_id}")"
    wait_queue_gate
    if [[ "${enqueued_count}" == 0 ]]; then
      complete=true
      break
    fi
  done
  if [[ "${complete}" != true ]]; then
    echo "Profile reindex planning did not reach an empty plan" >&2
    return 1
  fi
  queue_gate
}

assert_fragment_coverage() {
  local missing_count
  local coverage_sql
  coverage_sql="
with latest_successful_snapshots as (
  select distinct on (s.document_source_id) s.id, s.document_source_id, s.body_text
  from document_snapshots s
  where s.fetch_status = 'succeeded'
  order by s.document_source_id asc, s.fetched_at desc, s.id asc
)
select count(*)
from latest_successful_snapshots s
join document_sources ds on ds.id = s.document_source_id
where ds.source_type = 'authorized_wiki_document'
  and ds.can_use_for_answering = true
  and ds.permission_state in ('unknown', 'readable')
  and s.body_text is not null
  and s.body_text !~ '^[[:space:]]*$'
  and not exists (
  select 1
  from document_fragments f
  join document_fragment_embeddings_768 e on e.document_fragment_id = f.id
  where f.document_snapshot_id = s.id
    and f.embedding_profile_id = '${profile_id}'
    and e.embedding_profile_id = '${profile_id}'
);
"
  missing_count="$(
    printf '%s\n' "${coverage_sql}" |
      compose_cmd exec -T postgres sh -ec \
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
  )"
  if [[ ! "${missing_count}" =~ ^[0-9]+$ || "${missing_count}" != 0 ]]; then
    echo "Latest successful authorized-wiki missing EmbeddingGemma-profile fragment count is not zero" >&2
    return 1
  fi
}

run_private_life_engine_acceptance() {
  core_operation runtime-enable
  core_operation life-engine-answer \
    "${life_engine_chat_id}" \
    "${life_engine_source_id}" \
    "${life_engine_marker}"
  disable_runtime
  wait_queue_gate
}

main() {
  local runtime_before_migration
  local active_profile_before_migration
  local previous_global_enabled
  local previous_desired_global_enabled

  require_inputs
  runtime_before_migration="$(core_operation runtime-status)"
  IFS=$'\t' read -r previous_global_enabled previous_desired_global_enabled \
    <<<"${runtime_before_migration}"
  if [[ ! "${previous_global_enabled}" =~ ^(true|false)$ || ! "${previous_desired_global_enabled}" =~ ^(true|false)$ ]]; then
    echo "Current global runtime state is malformed" >&2
    return 1
  fi
  active_profile_before_migration="$(core_operation current-profile)"
  if [[ "${active_profile_before_migration}" != "${old_profile_id}" ]]; then
    echo "IRIS_OLD_EMBEDDING_PROFILE_ID does not match the active pre-migration profile" >&2
    return 1
  fi

  disable_runtime
  compose_cmd stop caddy
  assert_caddy_stopped
  record_backup_evidence "${previous_global_enabled}" "${previous_desired_global_enabled}"
  validate_rendered_config

  compose_cmd up --detach --wait --wait-timeout 600 --force-recreate \
    migrate embedding-model-init embedding-model embedding-model-verify core
  assert_completed_service "embedding-model-init"
  assert_completed_service "embedding-model-verify"
  assert_caddy_stopped
  assert_active_profile "${profile_id}"

  record_and_delete_old_dlq
  wait_queue_gate
  run_bounded_reindex
  assert_fragment_coverage
  run_private_life_engine_acceptance
  queue_gate
  assert_caddy_stopped
  printf '%s\n' '{"ok":true,"event":"local_embedding_migration_acceptance_passed"}'
}

main "$@"
