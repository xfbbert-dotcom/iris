#!/usr/bin/env bash
set -Eeuo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
known_group_ids="${IRIS_PROACTIVE_FEEDBACK_KNOWN_GROUP_IDS:-}"
request_timeout_ms="${IRIS_PROACTIVE_FEEDBACK_REQUEST_TIMEOUT_MS:-10000}"
compose_timeout_seconds="${IRIS_PROACTIVE_FEEDBACK_COMPOSE_TIMEOUT_SECONDS:-180}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

if [[ "${IRIS_PROACTIVE_FEEDBACK_AUTOCLOSE_CONFIRM:-}" != "ARM_FAIL_CLOSED_AUTOCLOSE" ]]; then
  echo "Set IRIS_PROACTIVE_FEEDBACK_AUTOCLOSE_CONFIRM=ARM_FAIL_CLOSED_AUTOCLOSE." >&2
  exit 64
fi
if [[ -z "$known_group_ids" || "$known_group_ids" == *"<"* || "$known_group_ids" == *">"* ]]; then
  echo "Set IRIS_PROACTIVE_FEEDBACK_KNOWN_GROUP_IDS to the exhaustive group inventory." >&2
  exit 64
fi
if [[ ! "$request_timeout_ms" =~ ^[0-9]+$ ]] ||
  (( request_timeout_ms < 1000 || request_timeout_ms > 30000 )); then
  echo "IRIS_PROACTIVE_FEEDBACK_REQUEST_TIMEOUT_MS must be between 1000 and 30000." >&2
  exit 64
fi
if [[ ! "$compose_timeout_seconds" =~ ^[0-9]+$ ]] ||
  (( compose_timeout_seconds < 60 || compose_timeout_seconds > 600 )); then
  echo "IRIS_PROACTIVE_FEEDBACK_COMPOSE_TIMEOUT_SECONDS must be between 60 and 600." >&2
  exit 64
fi
if [[ ! -r "$env_file" || ! -r "$compose_file" ]]; then
  echo "Pilot environment or Compose file is unavailable." >&2
  exit 66
fi
if (( EUID != 0 )); then
  echo "Run proactive feedback autoclose as root for atomic environment replacement." >&2
  exit 77
fi

stop_caddy_bounded() {
  timeout --kill-after=10s 60s "${compose[@]}" stop caddy >/dev/null
  if systemctl is-active --quiet caddy; then
    timeout --kill-after=10s 60s systemctl stop caddy
  fi
  if "${compose[@]}" ps --status running --services | grep -Fxq caddy; then
    echo "Caddy is still running after the fail-closed stop." >&2
    return 1
  fi
  if systemctl is-active --quiet caddy; then
    echo "The host Caddy service is still running." >&2
    return 1
  fi
}

disable_runtime_and_verify() {
  timeout --kill-after=10s 120s \
    "${compose[@]}" exec -T \
    -e IRIS_PROACTIVE_FEEDBACK_KNOWN_GROUP_IDS="$known_group_ids" \
    -e IRIS_PROACTIVE_FEEDBACK_REQUEST_TIMEOUT_MS="$request_timeout_ms" \
    core node --input-type=module <<'NODE'
const groupIds = readKnownGroupIds(
  requireEnv("IRIS_PROACTIVE_FEEDBACK_KNOWN_GROUP_IDS"),
);
const requestTimeoutMs = readRequestTimeout(
  requireEnv("IRIS_PROACTIVE_FEEDBACK_REQUEST_TIMEOUT_MS"),
);
const token = requireEnv("IRIS_INTERNAL_API_TOKEN");
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-proactive-feedback-autoclose",
};

await mutate("/internal/runtime-control/global", { enabled: false });
for (const groupId of groupIds) {
  await mutate(
    `/internal/runtime-control/groups/${encodeURIComponent(groupId)}`,
    { enabled: false },
  );
}
await mutate("/internal/runtime-control/capabilities", {
  proactiveSpeech: false,
}, "PATCH");

const status = await getJson("/internal/runtime-control/status");
if (status.globalEnabled !== false || status.desiredGlobalEnabled !== false) {
  throw new Error("Global runtime is not fail closed");
}
if (status.capabilities?.proactiveSpeech !== false) {
  throw new Error("proactiveSpeech is not disabled");
}
assertExactDisabledGroupSet(status.disabledGroupIds, groupIds);

console.log(JSON.stringify({
  ok: true,
  globalEnabled: false,
  desiredGlobalEnabled: false,
  proactiveSpeech: false,
  disabledGroupCount: groupIds.length,
}));

async function mutate(path, body, method = "POST") {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const parsed = await safeJson(response);
  if (!response.ok || parsed.ok === false || parsed.durable !== true) {
    throw new Error(`Runtime mutation failed: ${path} ${response.status}`);
  }
}

async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const parsed = await safeJson(response);
  if (!response.ok || parsed.ok === false) {
    throw new Error(`Runtime read failed: ${path} ${response.status}`);
  }
  return parsed;
}

async function safeJson(response) {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false };
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readRequestTimeout(value) {
  if (!/^[0-9]+$/u.test(value)) throw new Error("Request timeout is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 30000) {
    throw new Error("Request timeout is out of range");
  }
  return parsed;
}

function readKnownGroupIds(value) {
  const result = [...new Set(value.split(",").map((groupId) => groupId.trim()))];
  if (
    result.length < 1 ||
    result.length > 100 ||
    result.some((groupId) =>
      groupId.length === 0 ||
      groupId.length > 512 ||
      groupId.includes("<") ||
      groupId.includes(">")
    )
  ) {
    throw new Error("Known group inventory is invalid");
  }
  return result.sort(compareStrings);
}

function assertExactDisabledGroupSet(actualValue, expectedValue) {
  if (!Array.isArray(actualValue) || actualValue.some((groupId) => typeof groupId !== "string")) {
    throw new Error("disabledGroupIds is invalid");
  }
  const actual = [...new Set(actualValue)].sort(compareStrings);
  const expected = [...new Set(expectedValue)].sort(compareStrings);
  if (
    actual.length !== expected.length ||
    actual.some((groupId, index) => groupId !== expected[index])
  ) {
    throw new Error("Disabled group inventory is not exact");
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
NODE
}

write_fail_closed_environment() {
  IRIS_PROACTIVE_FEEDBACK_ENV_FILE="$env_file" python3 - <<'PY'
import os
import pathlib
import tempfile

path = pathlib.Path(os.environ["IRIS_PROACTIVE_FEEDBACK_ENV_FILE"])
updates = {
    "IRIS_KNOWLEDGE_CARD_ENABLED": "false",
    "IRIS_KNOWLEDGE_CARD_GROUP_IDS": "",
    "IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED": "false",
    "IRIS_PROACTIVE_SIGNAL_PLANNER_GROUP_IDS": "",
    "IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED": "false",
    "IRIS_PROACTIVE_SIGNAL_DELIVERY_GROUP_IDS": "",
}
original = path.read_text(encoding="utf-8")
result = []
seen = set()
for line in original.splitlines(keepends=True):
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        newline = "\r\n" if line.endswith("\r\n") else "\n"
        result.append(f"{key}={updates[key]}{newline}")
        seen.add(key)
    else:
        result.append(line)
if result and not result[-1].endswith(("\n", "\r")):
    result[-1] += "\n"
for key, value in updates.items():
    if key not in seen:
        result.append(f"{key}={value}\n")

stat = path.stat()
fd, temporary_name = tempfile.mkstemp(
    prefix=f".{path.name}.",
    suffix=".tmp",
    dir=path.parent,
    text=True,
)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
        handle.writelines(result)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary_name, stat.st_mode)
    os.chown(temporary_name, stat.st_uid, stat.st_gid)
    os.replace(temporary_name, path)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY
}

recreate_core_fail_closed() {
  timeout --kill-after=15s "${compose_timeout_seconds}s" \
    "${compose[@]}" up --detach --wait --wait-timeout 120 \
    --no-deps --force-recreate core >/dev/null
}

trap 'stop_caddy_bounded || true' EXIT

stop_caddy_bounded
first_disable_status=0
disable_runtime_and_verify || first_disable_status=$?
write_fail_closed_environment
recreate_core_fail_closed
disable_runtime_and_verify
stop_caddy_bounded

echo "proactive_feedback_autoclose_complete=true"
if (( first_disable_status != 0 )); then
  echo "initial_runtime_disable_recovered_after_core_recreate=true"
fi
