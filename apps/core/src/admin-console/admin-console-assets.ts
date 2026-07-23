export function renderAdminConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Iris Admin Console</title>
  <link rel="stylesheet" href="/admin/console.css">
</head>
<body>
  <main class="admin-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Iris</p>
        <h1>Admin Console</h1>
      </div>
      <div class="connection-state" id="connection-state">Disconnected</div>
    </header>

    <section class="operator-panel" aria-labelledby="operator-heading">
      <div>
        <h2 id="operator-heading">Operator Access</h2>
        <p>Use the existing internal bearer token. The token stays in this browser session and is never rendered back.</p>
      </div>
      <label>
        Operator
        <input id="operator-hint" autocomplete="username" placeholder="name or email">
      </label>
      <label>
        Internal token
        <input id="operator-token" type="password" autocomplete="current-password" placeholder="Internal access token">
      </label>
      <button id="connect-button" type="button">Connect</button>
    </section>

    <section class="status-grid" aria-label="Iris status">
      <article>
        <h2>System</h2>
        <dl id="system-status"></dl>
      </article>
      <article>
        <h2>Runtime</h2>
        <dl id="runtime-status"></dl>
      </article>
      <article>
        <h2>Readiness</h2>
        <dl id="readiness-status"></dl>
      </article>
    </section>

    <section class="control-grid" aria-label="Iris runtime controls">
      <article>
        <h2>Global Control</h2>
        <div class="button-row">
          <button data-global="true" type="button">Enable Iris</button>
          <button data-global="false" class="danger" type="button">Disable Iris</button>
        </div>
      </article>
      <article>
        <h2>Group Control</h2>
        <label>
          Feishu group id
          <input id="group-id" placeholder="oc_xxx">
        </label>
        <div class="button-row">
          <button data-group="true" type="button">Enable Group</button>
          <button data-group="false" class="danger" type="button">Disable Group</button>
        </div>
      </article>
      <article>
        <h2>Capabilities</h2>
        <div id="capability-controls" class="capability-list"></div>
      </article>
    </section>

    <section class="document-source-panel" aria-labelledby="document-sources-heading">
      <div class="panel-heading">
        <div>
          <h2 id="document-sources-heading">Document Sources</h2>
          <p>Inspect Iris-visible sources and adjust answering or knowledge-draft policy.</p>
        </div>
        <button id="document-source-refresh" type="button" class="secondary">Refresh Sources</button>
      </div>
      <div class="source-filters">
        <label>
          Source type
          <select id="document-source-type">
            <option value="">All types</option>
            <option value="group_visible_document">Group documents</option>
            <option value="authorized_wiki">Authorized wiki</option>
            <option value="user_submitted">User submitted</option>
          </select>
        </label>
        <label>
          Source id contains
          <input id="document-source-id-filter" placeholder="document source id">
        </label>
      </div>
      <div class="table-wrap">
        <table id="document-source-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th>Sync</th>
              <th>Permission</th>
              <th>Answering</th>
              <th>Drafts</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="document-source-rows"></tbody>
        </table>
      </div>
      <div id="document-source-empty" class="empty-state">Connect to load document sources.</div>
    </section>

    <section class="event-panel" aria-labelledby="events-heading">
      <h2 id="events-heading">Recent Operator Events</h2>
      <ol id="event-log"></ol>
    </section>
  </main>
  <script src="/admin/console.js"></script>
</body>
</html>`;
}

export function renderAdminConsoleCss(): string {
  return `:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #17202a;
  --muted: #667085;
  --line: #d9dee7;
  --accent: #1967d2;
  --danger: #c0392b;
  --ok: #18794e;
  --warn: #b26a00;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button, input {
  font: inherit;
}

select {
  font: inherit;
}

button {
  min-height: 36px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

button.secondary {
  background: #fff;
  color: var(--accent);
}

button.danger {
  border-color: var(--danger);
  background: var(--danger);
}

button:disabled {
  cursor: not-allowed;
  opacity: .55;
}

input {
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 10px;
  background: #fff;
  color: var(--text);
}

select {
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 10px;
  background: #fff;
  color: var(--text);
}

label {
  display: grid;
  gap: 5px;
  color: var(--muted);
}

h1, h2, p {
  margin: 0;
}

h1 {
  font-size: 24px;
  line-height: 1.1;
}

h2 {
  font-size: 15px;
  margin-bottom: 12px;
}

.admin-shell {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px;
}

.topbar,
.operator-panel,
.status-grid > article,
.control-grid > article,
.document-source-panel,
.event-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 18px 20px;
}

.eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.connection-state {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 6px 10px;
  color: var(--muted);
  white-space: nowrap;
}

.connection-state.ok {
  border-color: rgba(24, 121, 78, .35);
  color: var(--ok);
}

.connection-state.warn {
  border-color: rgba(178, 106, 0, .35);
  color: var(--warn);
}

.operator-panel {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(180px, 240px) minmax(220px, 280px) auto;
  gap: 14px;
  align-items: end;
  margin-top: 16px;
  padding: 16px;
}

.operator-panel p {
  color: var(--muted);
}

.status-grid,
.control-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.status-grid > article,
.control-grid > article,
.event-panel {
  padding: 16px;
}

dl {
  display: grid;
  grid-template-columns: minmax(120px, .8fr) minmax(0, 1.2fr);
  gap: 8px 12px;
  margin: 0;
}

dt {
  color: var(--muted);
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.capability-list {
  display: grid;
  gap: 8px;
}

.capability-list label {
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  color: var(--text);
}

.capability-list input {
  min-height: auto;
  width: 16px;
}

.event-panel {
  margin-top: 16px;
}

.document-source-panel {
  margin-top: 16px;
  padding: 16px;
}

.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel-heading p,
.empty-state {
  color: var(--muted);
}

.source-filters {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(220px, 1fr);
  gap: 12px;
  margin-top: 14px;
}

.table-wrap {
  margin-top: 14px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 860px;
}

th,
td {
  border-bottom: 1px solid var(--line);
  padding: 10px;
  text-align: left;
  vertical-align: top;
}

th {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

td.source-title {
  max-width: 300px;
}

.source-uri {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.policy-toggle {
  display: inline-grid;
  grid-template-columns: 18px auto;
  align-items: center;
  gap: 6px;
  color: var(--text);
}

.policy-toggle input {
  min-height: auto;
  width: 16px;
}

.empty-state {
  margin-top: 10px;
}

#event-log {
  margin: 0;
  padding-left: 20px;
}

#event-log li {
  margin: 6px 0;
  color: var(--muted);
}

@media (max-width: 880px) {
  .operator-panel,
  .status-grid,
  .control-grid,
  .source-filters {
    grid-template-columns: 1fr;
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }
}`;
}

export function renderAdminConsoleScript(): string {
  return `"use strict";

const tokenInput = document.getElementById("operator-token");
const operatorInput = document.getElementById("operator-hint");
const connectButton = document.getElementById("connect-button");
const connectionState = document.getElementById("connection-state");
const systemStatus = document.getElementById("system-status");
const runtimeStatus = document.getElementById("runtime-status");
const readinessStatus = document.getElementById("readiness-status");
const capabilityControls = document.getElementById("capability-controls");
const groupIdInput = document.getElementById("group-id");
const eventLog = document.getElementById("event-log");
const documentSourceRefresh = document.getElementById("document-source-refresh");
const documentSourceType = document.getElementById("document-source-type");
const documentSourceIdFilter = document.getElementById("document-source-id-filter");
const documentSourceRows = document.getElementById("document-source-rows");
const documentSourceEmpty = document.getElementById("document-source-empty");

const capabilityLabels = {
  readGroupContext: "Read group context",
  replyWhenMentioned: "Reply when mentioned",
  readGroupDocuments: "Read group documents",
  retrieveKnowledgeBase: "Retrieve knowledge base",
  proactiveSpeech: "Proactive speech",
  generateKnowledgeDrafts: "Generate knowledge drafts",
  writeKnowledgeBase: "Write knowledge base",
  callExternalTools: "Call external tools",
};

let cachedStatus = undefined;
const documentSourceListBasePath = "/internal/document-sync/sources?includeLatestSnapshot=true";

function readToken() {
  return sessionStorage.getItem("iris_admin_token") || "";
}

function readOperator() {
  return sessionStorage.getItem("iris_admin_operator") || "";
}

function writeSession() {
  const token = tokenInput.value.trim();
  const operator = operatorInput.value.trim();
  if (token.length > 0) sessionStorage.setItem("iris_admin_token", token);
  if (operator.length > 0) sessionStorage.setItem("iris_admin_operator", operator);
}

function headers() {
  const token = readToken();
  const result = { "content-type": "application/json" };
  if (token.length > 0) result.Authorization = "Bearer " + token;
  const operator = readOperator();
  if (operator.length > 0) result["x-iris-operator"] = operator;
  return result;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    body = { ok: false, error: "invalid_json_response" };
  }
  if (!response.ok) {
    const error = new Error(body.error || "request_failed");
    error.status = response.status;
    throw error;
  }
  return body;
}

function setConnection(message, mode) {
  connectionState.textContent = message;
  connectionState.className = "connection-state" + (mode ? " " + mode : "");
}

function addEvent(message) {
  const item = document.createElement("li");
  item.textContent = new Date().toLocaleTimeString() + " " + message;
  eventLog.prepend(item);
  while (eventLog.children.length > 12) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

function text(value, fallback = "unknown") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function renderDefinitionList(target, entries) {
  target.replaceChildren();
  for (const [label, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = String(value);
    target.append(term, detail);
  }
}

function sourceListPath() {
  const [path, query] = documentSourceListBasePath.split("?");
  const params = new URLSearchParams(query);
  const type = documentSourceType.value;
  if (type.length > 0) params.set("sourceType", type);
  return path + "?" + params.toString();
}

function sourceMatchesFilter(source) {
  const needle = documentSourceIdFilter.value.trim().toLowerCase();
  if (needle.length === 0) return true;
  return text(source.id, "").toLowerCase().includes(needle);
}

function renderPolicyToggle(source, field, labelText) {
  const label = document.createElement("label");
  label.className = "policy-toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = source[field] === true;
  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    try {
      await updateDocumentSourcePolicy(source.id, { [field]: checkbox.checked });
      addEvent(labelText + " updated for " + source.id);
      await refreshDocumentSources();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      addEvent(labelText + " update failed: " + error.message);
      setConnection("Request failed", "warn");
    } finally {
      checkbox.disabled = false;
    }
  });
  const labelCopy = document.createElement("span");
  labelCopy.textContent = labelText;
  label.append(checkbox, labelCopy);
  return label;
}

function renderDocumentSources(sources) {
  documentSourceRows.replaceChildren();
  const visibleSources = (sources || []).filter(sourceMatchesFilter);
  for (const source of visibleSources) {
    const row = document.createElement("tr");

    const sourceCell = document.createElement("td");
    sourceCell.className = "source-title";
    const title = document.createElement("strong");
    title.textContent = text(source.title, source.id);
    const uri = document.createElement("div");
    uri.className = "source-uri";
    uri.textContent = text(source.sourceUri, source.id);
    sourceCell.append(title, uri);

    const typeCell = document.createElement("td");
    typeCell.textContent = text(source.sourceType);

    const syncCell = document.createElement("td");
    syncCell.textContent = text(source.syncHealth?.status, source.syncState || "unknown");
    const snapshotTime = source.latestSnapshot?.observedAt;
    if (snapshotTime) {
      const observed = document.createElement("div");
      observed.className = "source-uri";
      observed.textContent = snapshotTime;
      syncCell.append(observed);
    }

    const permissionCell = document.createElement("td");
    permissionCell.textContent = text(source.permissionState, "not recorded");

    const answeringCell = document.createElement("td");
    answeringCell.append(renderPolicyToggle(source, "answeringEnabled", "Answering"));

    const draftsCell = document.createElement("td");
    draftsCell.append(renderPolicyToggle(source, "knowledgeDraftsEnabled", "Drafts"));

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "source-actions";
    const syncButton = document.createElement("button");
    syncButton.type = "button";
    syncButton.className = "secondary";
    syncButton.textContent = "Sync";
    syncButton.addEventListener("click", async () => {
      syncButton.disabled = true;
      try {
        await enqueueDocumentSource(source.id);
        addEvent("Manual sync queued for " + source.id);
      } catch (error) {
        addEvent("Manual sync failed: " + error.message);
        setConnection("Request failed", "warn");
      } finally {
        syncButton.disabled = false;
      }
    });
    actions.append(syncButton);
    actionsCell.append(actions);

    row.append(sourceCell, typeCell, syncCell, permissionCell, answeringCell, draftsCell, actionsCell);
    documentSourceRows.append(row);
  }
  documentSourceEmpty.textContent = visibleSources.length === 0 ? "No document sources match the current filters." : "";
}

async function refreshDocumentSources() {
  const body = await requestJson(sourceListPath());
  renderDocumentSources(body.sources || []);
}

async function updateDocumentSourcePolicy(sourceId, patch) {
  return requestJson("/internal/document-sync/sources/" + encodeURIComponent(sourceId) + "/policy", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function enqueueDocumentSource(sourceId) {
  return requestJson("/internal/document-sync/sources/" + encodeURIComponent(sourceId) + "/enqueue", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

function renderCapabilityControls(capabilities) {
  capabilityControls.replaceChildren();
  for (const [name, enabled] of Object.entries(capabilities || {})) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = enabled === true;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await requestJson("/internal/runtime-control/capabilities", {
          method: "PATCH",
          body: JSON.stringify({ [name]: checkbox.checked }),
        });
        addEvent((capabilityLabels[name] || name) + " updated");
        await refresh();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        addEvent("Capability update failed: " + error.message);
        setConnection("Request failed", "warn");
      } finally {
        checkbox.disabled = false;
      }
    });
    const text = document.createElement("span");
    text.textContent = capabilityLabels[name] || name;
    label.append(checkbox, text);
    capabilityControls.append(label);
  }
}

function render(status, readiness, runtime) {
  cachedStatus = { status, readiness, runtime };
  renderDefinitionList(systemStatus, [
    ["Overall", status.status || "unknown"],
    ["Needs attention", status.summary?.requiresOperatorAttention === true ? "yes" : "no"],
    ["Primary attention", status.summary?.primaryAttentionComponent?.name || "none"],
    ["Components", status.summary?.componentCount ?? "unknown"],
  ]);
  renderDefinitionList(runtimeStatus, [
    ["Global enabled", runtime.globalEnabled === true ? "yes" : "no"],
    ["Desired global", runtime.desiredGlobalEnabled === true ? "yes" : "no"],
    ["Activation required", runtime.activationRequired === true ? "yes" : "no"],
    ["Disabled groups", (runtime.disabledGroupIds || []).join(", ") || "none"],
    ["Revision", runtime.revision ?? "unknown"],
  ]);
  renderDefinitionList(readinessStatus, [
    ["Readiness", readiness.status || "unknown"],
    ["OK", readiness.ok === true ? "yes" : "no"],
    ["Checks", Array.isArray(readiness.checks) ? readiness.checks.length : "unknown"],
  ]);
  renderCapabilityControls(runtime.capabilities || {});
}

async function refresh() {
  const [status, readiness, runtime] = await Promise.all([
    requestJson("/internal/status"),
    requestJson("/internal/readiness"),
    requestJson("/internal/runtime-control/status"),
  ]);
  render(status, readiness, runtime);
  await refreshDocumentSources();
  setConnection(status.ok === true ? "Connected" : "Attention needed", status.ok === true ? "ok" : "warn");
}

async function setGlobal(enabled) {
  await requestJson("/internal/runtime-control/global", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  addEvent(enabled ? "Global Iris enabled" : "Global Iris disabled");
  await refresh();
}

async function setGroup(enabled) {
  const groupId = groupIdInput.value.trim();
  if (groupId.length === 0) {
    addEvent("Group id is required");
    return;
  }
  await requestJson("/internal/runtime-control/groups/" + encodeURIComponent(groupId), {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  addEvent((enabled ? "Enabled " : "Disabled ") + groupId);
  await refresh();
}

connectButton.addEventListener("click", async () => {
  writeSession();
  try {
    await refresh();
    addEvent("Connected");
  } catch (error) {
    setConnection("Unauthorized or unavailable", "warn");
    addEvent("Connect failed: " + error.message);
  }
});

documentSourceRefresh.addEventListener("click", async () => {
  documentSourceRefresh.disabled = true;
  try {
    await refreshDocumentSources();
    addEvent("Document sources refreshed");
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("Document source refresh failed: " + error.message);
  } finally {
    documentSourceRefresh.disabled = false;
  }
});

documentSourceType.addEventListener("change", async () => {
  if (readToken().length === 0) return;
  try {
    await refreshDocumentSources();
  } catch (error) {
    addEvent("Document source filter failed: " + error.message);
  }
});

documentSourceIdFilter.addEventListener("input", async () => {
  if (readToken().length === 0) return;
  try {
    await refreshDocumentSources();
  } catch (error) {
    addEvent("Document source filter failed: " + error.message);
  }
});

for (const button of document.querySelectorAll("[data-global]")) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await setGlobal(button.dataset.global === "true");
    } catch (error) {
      setConnection("Request failed", "warn");
      addEvent("Global update failed: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
}

for (const button of document.querySelectorAll("[data-group]")) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await setGroup(button.dataset.group === "true");
    } catch (error) {
      setConnection("Request failed", "warn");
      addEvent("Group update failed: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
}

tokenInput.value = "";
operatorInput.value = readOperator();
if (readToken().length > 0) {
  setConnection("Token saved for this session", "warn");
}
if (cachedStatus === undefined) {
  renderDefinitionList(systemStatus, [["Overall", "connect required"]]);
  renderDefinitionList(runtimeStatus, [["Global enabled", "connect required"]]);
  renderDefinitionList(readinessStatus, [["Readiness", "connect required"]]);
}`;
}
