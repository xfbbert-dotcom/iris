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

    <section class="knowledge-draft-panel" aria-labelledby="knowledge-drafts-heading">
      <div class="panel-heading">
        <div>
          <h2 id="knowledge-drafts-heading">Knowledge Drafts</h2>
          <p>Review queue state and route safe revision or rejection decisions.</p>
        </div>
        <button id="knowledge-draft-refresh" type="button" class="secondary">Refresh Drafts</button>
      </div>
      <dl id="knowledge-draft-status" class="compact-status"></dl>
      <div class="source-filters">
        <label>
          Draft status
          <select id="knowledge-draft-status-filter">
            <option value="">Open statuses</option>
            <option value="pending_confirmation">Pending confirmation</option>
            <option value="pending_review">Pending review</option>
            <option value="needs_revision">Needs revision</option>
            <option value="rejected">Rejected</option>
            <option value="published">Published</option>
          </select>
        </label>
        <label>
          Group id
          <input id="knowledge-draft-group-filter" placeholder="oc_xxx">
        </label>
      </div>
      <div class="table-wrap">
        <table id="knowledge-draft-table">
          <thead>
            <tr>
              <th>Draft</th>
              <th>Group</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Version</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="knowledge-draft-rows"></tbody>
        </table>
      </div>
      <div id="knowledge-draft-empty" class="empty-state">Connect to load knowledge drafts.</div>
    </section>

    <section class="publication-queue-panel" aria-labelledby="publication-queue-heading">
      <div class="panel-heading">
        <div>
          <h2 id="publication-queue-heading">Publication Queue</h2>
          <p>Inspect approval and publication execution state without exposing draft body content.</p>
        </div>
        <button id="publication-queue-refresh" type="button" class="secondary">Refresh Queue</button>
      </div>
      <div class="source-filters">
        <label>
          Proposal status
          <select id="publication-queue-status">
            <option value="pending_approval,approved,executing,failed,reconciliation_required">Open publication work</option>
            <option value="pending_approval">Pending approval</option>
            <option value="approved">Approved</option>
            <option value="executing">Executing</option>
            <option value="failed">Failed</option>
            <option value="reconciliation_required">Needs reconciliation</option>
            <option value="succeeded">Succeeded</option>
            <option value="cancelled,expired">Closed without publication</option>
          </select>
        </label>
        <label>
          Draft id
          <input id="publication-queue-subject" placeholder="optional draft id">
        </label>
        <label>
          Limit
          <input id="publication-queue-limit" inputmode="numeric" placeholder="20">
        </label>
      </div>
      <div class="table-wrap">
        <table id="publication-queue-table">
          <thead>
            <tr>
              <th>Proposal</th>
              <th>Draft</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Target</th>
              <th>Version</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="publication-queue-rows"></tbody>
        </table>
      </div>
      <div id="publication-queue-empty" class="empty-state">Connect to load publication proposals.</div>
    </section>

    <section class="proactive-candidate-panel" aria-labelledby="proactive-candidates-heading">
      <div class="panel-heading">
        <div>
          <h2 id="proactive-candidates-heading">Proactive Candidates</h2>
          <p>Scan one group, review pending suggestions, then dismiss or approve delivery.</p>
        </div>
        <div class="button-row">
          <button id="proactive-candidate-scan" type="button">Scan Group</button>
          <button id="proactive-candidate-refresh" type="button" class="secondary">Refresh Candidates</button>
        </div>
      </div>
      <div class="source-filters">
        <label>
          Feishu group id
          <input id="proactive-candidate-group" placeholder="oc_xxx">
        </label>
        <label>
          Limit
          <input id="proactive-candidate-limit" inputmode="numeric" placeholder="20">
        </label>
      </div>
      <div class="table-wrap">
        <table id="proactive-candidate-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Priority</th>
              <th>Entity</th>
              <th>Suggested mode</th>
              <th>Last relevant</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="proactive-candidate-rows"></tbody>
        </table>
      </div>
      <div id="proactive-candidate-empty" class="empty-state">Enter a group id to load proactive candidates.</div>
    </section>

    <section class="audit-summary-panel" aria-labelledby="audit-summary-heading">
      <div class="panel-heading">
        <div>
          <h2 id="audit-summary-heading">Audit Summary</h2>
          <p>Inspect recent security and operator events without exposing raw message bodies.</p>
        </div>
        <button id="audit-summary-refresh" type="button" class="secondary">Refresh Audit</button>
      </div>
      <div class="source-filters">
        <label>
          Event type
          <select id="audit-summary-type">
            <option value="">All audit types</option>
            <option value="permission_guard_denied">Permission denied</option>
            <option value="permission_guard_error">Permission error</option>
            <option value="runtime_control_updated">Runtime control updated</option>
            <option value="group_memory_created">Memory created</option>
            <option value="group_memory_corrected">Memory corrected</option>
            <option value="group_memory_deleted">Memory deleted</option>
            <option value="memory_extraction_failed">Memory extraction failed</option>
          </select>
        </label>
        <label>
          Document id
          <input id="audit-summary-document" placeholder="optional source id">
        </label>
        <label>
          Limit
          <input id="audit-summary-limit" inputmode="numeric" placeholder="20">
        </label>
      </div>
      <dl id="audit-summary-meta" class="compact-status"></dl>
      <div class="table-wrap">
        <table id="audit-summary-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Document</th>
              <th>Events</th>
              <th>Fragments</th>
              <th>Window</th>
            </tr>
          </thead>
          <tbody id="audit-summary-rows"></tbody>
        </table>
      </div>
      <div id="audit-summary-empty" class="empty-state">Connect to load audit summaries.</div>
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
.knowledge-draft-panel,
.publication-queue-panel,
.proactive-candidate-panel,
.audit-summary-panel,
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

.knowledge-draft-panel {
  margin-top: 16px;
  padding: 16px;
}

.publication-queue-panel {
  margin-top: 16px;
  padding: 16px;
}

.proactive-candidate-panel {
  margin-top: 16px;
  padding: 16px;
}

.audit-summary-panel {
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

.compact-status {
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  margin-top: 12px;
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
const knowledgeDraftRefresh = document.getElementById("knowledge-draft-refresh");
const knowledgeDraftStatus = document.getElementById("knowledge-draft-status");
const knowledgeDraftStatusFilter = document.getElementById("knowledge-draft-status-filter");
const knowledgeDraftGroupFilter = document.getElementById("knowledge-draft-group-filter");
const knowledgeDraftRows = document.getElementById("knowledge-draft-rows");
const knowledgeDraftEmpty = document.getElementById("knowledge-draft-empty");
const publicationQueueRefresh = document.getElementById("publication-queue-refresh");
const publicationQueueStatus = document.getElementById("publication-queue-status");
const publicationQueueSubject = document.getElementById("publication-queue-subject");
const publicationQueueLimit = document.getElementById("publication-queue-limit");
const publicationQueueRows = document.getElementById("publication-queue-rows");
const publicationQueueEmpty = document.getElementById("publication-queue-empty");
const proactiveCandidateScan = document.getElementById("proactive-candidate-scan");
const proactiveCandidateRefresh = document.getElementById("proactive-candidate-refresh");
const proactiveCandidateGroup = document.getElementById("proactive-candidate-group");
const proactiveCandidateLimit = document.getElementById("proactive-candidate-limit");
const proactiveCandidateRows = document.getElementById("proactive-candidate-rows");
const proactiveCandidateEmpty = document.getElementById("proactive-candidate-empty");
const auditSummaryRefresh = document.getElementById("audit-summary-refresh");
const auditSummaryType = document.getElementById("audit-summary-type");
const auditSummaryDocument = document.getElementById("audit-summary-document");
const auditSummaryLimit = document.getElementById("audit-summary-limit");
const auditSummaryMeta = document.getElementById("audit-summary-meta");
const auditSummaryRows = document.getElementById("audit-summary-rows");
const auditSummaryEmpty = document.getElementById("audit-summary-empty");

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
const knowledgeDraftListBasePath = "/internal/knowledge-drafts?limit=20";
const knowledgeDraftRequestRevisionPath = "/request-revision";
const knowledgeDraftRejectPath = "/reject";
const publicationQueueBasePath = "/internal/action-proposals?status=pending_approval,approved,executing,failed,reconciliation_required&limit=20";
const proactiveSignalGroupBasePath = "/internal/proactive-signals/groups/";
const proactiveCandidateListSuffix = "/candidates?limit=20";
const proactiveCandidateScanSuffix = "/scan";
const proactiveCandidateDismissSuffix = "/dismiss";
const proactiveCandidateApproveSuffix = "/approve-delivery";
const auditSummaryBasePath = "/internal/audit/events/summary?limit=20";
const auditSummaryAllowedTypes = new Set([
  "permission_guard_denied",
  "permission_guard_error",
  "runtime_control_updated",
  "group_memory_created",
  "group_memory_corrected",
  "group_memory_deleted",
  "memory_extraction_failed",
]);

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

function knowledgeDraftListPath() {
  const [path, query] = knowledgeDraftListBasePath.split("?");
  const params = new URLSearchParams(query);
  const status = knowledgeDraftStatusFilter.value;
  if (status.length > 0) params.set("status", status);
  const groupId = knowledgeDraftGroupFilter.value.trim();
  if (groupId.length > 0) params.set("groupId", groupId);
  return path + "?" + params.toString();
}

function renderKnowledgeDraftStatus(status) {
  const counts = status.counts || {};
  renderDefinitionList(knowledgeDraftStatus, [
    ["Enabled", status.enabled === true ? "yes" : "no"],
    ["Pending confirmation", counts.pending_confirmation ?? 0],
    ["Pending review", counts.pending_review ?? 0],
    ["Needs revision", counts.needs_revision ?? 0],
    ["Published", counts.published ?? 0],
  ]);
}

function draftTitle(draft) {
  return text(draft.currentRevision?.title, draft.id);
}

function renderKnowledgeDrafts(drafts) {
  knowledgeDraftRows.replaceChildren();
  for (const draft of drafts || []) {
    const row = document.createElement("tr");

    const draftCell = document.createElement("td");
    draftCell.className = "source-title";
    const title = document.createElement("strong");
    title.textContent = draftTitle(draft);
    const id = document.createElement("div");
    id.className = "source-uri";
    id.textContent = text(draft.id);
    draftCell.append(title, id);

    const groupCell = document.createElement("td");
    groupCell.textContent = text(draft.sourceGroupId, "company");

    const statusCell = document.createElement("td");
    statusCell.textContent = text(draft.status);

    const riskCell = document.createElement("td");
    riskCell.textContent = text(draft.currentRevision?.riskLevel, "unknown");

    const versionCell = document.createElement("td");
    versionCell.textContent = text(draft.version, "unknown") + " / r" + text(draft.currentRevisionNumber, "?");

    const updatedCell = document.createElement("td");
    updatedCell.textContent = text(draft.updatedAt);

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "source-actions";
    for (const [action, label, danger] of [
      [knowledgeDraftRequestRevisionPath, "Request revision", false],
      [knowledgeDraftRejectPath, "Reject", true],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = danger ? "danger" : "secondary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await transitionKnowledgeDraft(draft, action);
          addEvent(label + " recorded for " + draft.id);
          await refreshKnowledgeDrafts();
        } catch (error) {
          addEvent(label + " failed: " + error.message);
          setConnection("Request failed", "warn");
        } finally {
          button.disabled = false;
        }
      });
      actions.append(button);
    }
    actionsCell.append(actions);

    row.append(draftCell, groupCell, statusCell, riskCell, versionCell, updatedCell, actionsCell);
    knowledgeDraftRows.append(row);
  }
  knowledgeDraftEmpty.textContent = (drafts || []).length === 0 ? "No knowledge drafts match the current filters." : "";
}

async function refreshKnowledgeDrafts() {
  const [status, list] = await Promise.all([
    requestJson("/internal/knowledge-drafts/status"),
    requestJson(knowledgeDraftListPath()),
  ]);
  renderKnowledgeDraftStatus(status);
  renderKnowledgeDrafts(list.drafts || []);
}

async function transitionKnowledgeDraft(draft, action) {
  const reason = window.prompt("Reason for " + action.slice(1).replace("-", " ") + ":", "Needs operator follow-up");
  if (reason === null || reason.trim().length === 0) throw new Error("reason_required");
  return requestJson("/internal/knowledge-drafts/" + encodeURIComponent(draft.id) + action, {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: draft.version,
      operationKey: "admin-console-" + action.slice(1) + "-" + draft.id + "-" + Date.now(),
      actor: readOperator() || "admin_console",
      reason: reason.trim(),
    }),
  });
}

function publicationQueuePath() {
  const [path, query] = publicationQueueBasePath.split("?");
  const params = new URLSearchParams(query);
  params.set("status", publicationQueueStatus.value);
  params.set("limit", boundedNumericInputValue(publicationQueueLimit, "20"));
  const subjectId = publicationQueueSubject.value.trim();
  if (subjectId.length > 0) params.set("subjectId", subjectId);
  return path + "?" + params.toString();
}

function canGovernPublicationProposal(proposal) {
  return proposal.status === "pending_approval" || proposal.status === "approved";
}

function renderPublicationQueue(proposals) {
  publicationQueueRows.replaceChildren();
  for (const proposal of proposals || []) {
    const row = document.createElement("tr");

    const proposalCell = document.createElement("td");
    proposalCell.className = "source-title";
    const proposalId = document.createElement("strong");
    proposalId.textContent = text(proposal.id);
    const operation = document.createElement("div");
    operation.className = "source-uri";
    operation.textContent = text(proposal.actionType);
    proposalCell.append(proposalId, operation);

    const subjectCell = document.createElement("td");
    subjectCell.textContent =
      text(proposal.subjectId) + " r" + text(proposal.subjectRevision, "?");

    const statusCell = document.createElement("td");
    statusCell.textContent = text(proposal.status);

    const riskCell = document.createElement("td");
    riskCell.textContent = text(proposal.riskLevel);

    const targetCell = document.createElement("td");
    targetCell.textContent =
      text(proposal.targetPolicyId) + " v" + text(proposal.targetPolicyVersion, "?");

    const versionCell = document.createElement("td");
    versionCell.textContent =
      "p" + text(proposal.version, "?") + " / d" + text(proposal.subjectVersion, "?");

    const updatedCell = document.createElement("td");
    updatedCell.textContent = text(proposal.updatedAt);

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "source-actions";
    for (const [action, label, danger] of [
      [knowledgeDraftRequestRevisionPath, "Request revision", false],
      [knowledgeDraftRejectPath, "Reject", true],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = danger ? "danger" : "secondary";
      button.textContent = label;
      button.disabled = !canGovernPublicationProposal(proposal);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await transitionPublicationProposal(proposal, action);
          addEvent(label + " recorded for proposal " + proposal.id);
          await refreshPublicationQueue();
        } catch (error) {
          addEvent(label + " failed: " + error.message);
          setConnection("Request failed", "warn");
        } finally {
          button.disabled = !canGovernPublicationProposal(proposal);
        }
      });
      actions.append(button);
    }
    actionsCell.append(actions);

    row.append(proposalCell, subjectCell, statusCell, riskCell, targetCell, versionCell, updatedCell, actionsCell);
    publicationQueueRows.append(row);
  }
  publicationQueueEmpty.textContent = (proposals || []).length === 0 ? "No publication proposals match the current filters." : "";
}

async function refreshPublicationQueue() {
  const body = await requestJson(publicationQueuePath());
  renderPublicationQueue(body.proposals || []);
}

async function transitionPublicationProposal(proposal, action) {
  const reason = window.prompt("Reason for " + action.slice(1).replace("-", " ") + ":", "Needs operator follow-up");
  if (reason === null || reason.trim().length === 0) throw new Error("reason_required");
  return requestJson("/internal/action-proposals/" + encodeURIComponent(proposal.id) + action, {
    method: "POST",
    body: JSON.stringify({
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      reason: reason.trim(),
      operationKey: "admin-console-proposal-" + action.slice(1) + "-" + proposal.id + "-" + Date.now(),
    }),
  });
}

function readProactiveGroupId() {
  const groupId = proactiveCandidateGroup.value.trim();
  if (groupId.length === 0) {
    addEvent("Proactive group id is required");
    return undefined;
  }
  return groupId;
}

function proactiveCandidateLimitValue() {
  const raw = proactiveCandidateLimit.value.trim();
  if (raw.length === 0) return "20";
  return /^\\d+$/u.test(raw) ? raw : "20";
}

function proactiveCandidatePath(groupId, suffix) {
  return proactiveSignalGroupBasePath + encodeURIComponent(groupId) + suffix;
}

function proactiveCandidateListPath(groupId) {
  const limit = proactiveCandidateLimitValue();
  if (limit === "20") return proactiveCandidatePath(groupId, proactiveCandidateListSuffix);
  return proactiveCandidatePath(groupId, "/candidates?limit=" + encodeURIComponent(limit));
}

function renderProactiveCandidates(candidates) {
  proactiveCandidateRows.replaceChildren();
  for (const candidate of candidates || []) {
    const row = document.createElement("tr");

    const candidateCell = document.createElement("td");
    candidateCell.className = "source-title";
    const kind = document.createElement("strong");
    kind.textContent = text(candidate.kind);
    const key = document.createElement("div");
    key.className = "source-uri";
    key.textContent = text(candidate.idempotencyKey);
    candidateCell.append(kind, key);

    const priorityCell = document.createElement("td");
    priorityCell.textContent = text(candidate.priority);

    const entityCell = document.createElement("td");
    entityCell.textContent = text(candidate.entityType) + " " + text(candidate.entityId) + " v" + text(candidate.entityVersion, "?");

    const modeCell = document.createElement("td");
    modeCell.textContent = text(candidate.suggestedMode);

    const lastRelevantCell = document.createElement("td");
    lastRelevantCell.textContent = text(candidate.lastRelevantAt);

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "source-actions";
    for (const [suffix, label, danger] of [
      [proactiveCandidateDismissSuffix, "Dismiss", true],
      [proactiveCandidateApproveSuffix, "Approve delivery", false],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = danger ? "danger" : "secondary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await transitionProactiveCandidate(candidate, suffix);
          addEvent(label + " recorded for " + candidate.idempotencyKey);
          await refreshProactiveCandidates();
        } catch (error) {
          addEvent(label + " failed: " + error.message);
          setConnection("Request failed", "warn");
        } finally {
          button.disabled = false;
        }
      });
      actions.append(button);
    }
    actionsCell.append(actions);

    row.append(candidateCell, priorityCell, entityCell, modeCell, lastRelevantCell, actionsCell);
    proactiveCandidateRows.append(row);
  }
  proactiveCandidateEmpty.textContent = (candidates || []).length === 0 ? "No pending proactive candidates for this group." : "";
}

async function refreshProactiveCandidates() {
  const groupId = readProactiveGroupId();
  if (groupId === undefined) return;
  const body = await requestJson(proactiveCandidateListPath(groupId));
  renderProactiveCandidates(body.candidates || []);
}

async function scanProactiveCandidates() {
  const groupId = readProactiveGroupId();
  if (groupId === undefined) return;
  await requestJson(proactiveCandidatePath(groupId, proactiveCandidateScanSuffix), {
    method: "POST",
    body: JSON.stringify({ limit: Number(proactiveCandidateLimitValue()) }),
  });
  addEvent("Proactive scan completed for " + groupId);
  await refreshProactiveCandidates();
}

async function transitionProactiveCandidate(candidate, suffix) {
  const groupId = readProactiveGroupId();
  if (groupId === undefined) throw new Error("group_required");
  return requestJson(
    proactiveSignalGroupBasePath +
      encodeURIComponent(groupId) +
      "/candidates/" +
      encodeURIComponent(candidate.idempotencyKey) +
      suffix,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

function boundedNumericInputValue(input, fallback) {
  const raw = input.value.trim();
  if (raw.length === 0) return fallback;
  return /^\\d+$/u.test(raw) ? raw : fallback;
}

function auditSummaryPath() {
  const [path, query] = auditSummaryBasePath.split("?");
  const params = new URLSearchParams(query);
  params.set("limit", boundedNumericInputValue(auditSummaryLimit, "20"));
  const type = auditSummaryType.value;
  if (type.length > 0 && auditSummaryAllowedTypes.has(type)) params.set("type", type);
  const documentId = auditSummaryDocument.value.trim();
  if (documentId.length > 0) params.set("documentId", documentId);
  return path + "?" + params.toString();
}

function renderAuditSummaryMeta(meta) {
  renderDefinitionList(auditSummaryMeta, [
    ["Retained", meta?.retainedEventCount ?? 0],
    ["Dropped", meta?.droppedEventCount ?? 0],
    ["Inspected", meta?.inspectedEventCount ?? 0],
    ["Matching", meta?.matchingEventCount ?? 0],
    ["Limit", meta?.limit ?? "unknown"],
  ]);
}

function renderAuditSummaries(summaries) {
  auditSummaryRows.replaceChildren();
  for (const summary of summaries || []) {
    const row = document.createElement("tr");

    const typeCell = document.createElement("td");
    typeCell.textContent = text(summary.type);

    const documentCell = document.createElement("td");
    documentCell.textContent = text(summary.documentId, "none");

    const eventCountCell = document.createElement("td");
    eventCountCell.textContent = text(summary.eventCount, "0");

    const fragmentCell = document.createElement("td");
    fragmentCell.textContent = text(summary.affectedFragmentCount, "0");

    const windowCell = document.createElement("td");
    windowCell.textContent =
      text(summary.firstRecordedAt, "unknown") + " -> " + text(summary.latestRecordedAt, "unknown");

    row.append(typeCell, documentCell, eventCountCell, fragmentCell, windowCell);
    auditSummaryRows.append(row);
  }
  auditSummaryEmpty.textContent = (summaries || []).length === 0 ? "No audit summaries match the current filters." : "";
}

async function refreshAuditSummaries() {
  const body = await requestJson(auditSummaryPath());
  renderAuditSummaryMeta(body.meta || {});
  renderAuditSummaries(body.summaries || []);
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
  await refreshKnowledgeDrafts();
  await refreshPublicationQueue();
  await refreshAuditSummaries();
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

knowledgeDraftRefresh.addEventListener("click", async () => {
  knowledgeDraftRefresh.disabled = true;
  try {
    await refreshKnowledgeDrafts();
    addEvent("Knowledge drafts refreshed");
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("Knowledge draft refresh failed: " + error.message);
  } finally {
    knowledgeDraftRefresh.disabled = false;
  }
});

knowledgeDraftStatusFilter.addEventListener("change", async () => {
  if (readToken().length === 0) return;
  try {
    await refreshKnowledgeDrafts();
  } catch (error) {
    addEvent("Knowledge draft filter failed: " + error.message);
  }
});

knowledgeDraftGroupFilter.addEventListener("input", async () => {
  if (readToken().length === 0) return;
  try {
    await refreshKnowledgeDrafts();
  } catch (error) {
    addEvent("Knowledge draft filter failed: " + error.message);
  }
});

publicationQueueRefresh.addEventListener("click", async () => {
  publicationQueueRefresh.disabled = true;
  try {
    await refreshPublicationQueue();
    addEvent("Publication queue refreshed");
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("Publication queue refresh failed: " + error.message);
  } finally {
    publicationQueueRefresh.disabled = false;
  }
});

publicationQueueStatus.addEventListener("change", async () => {
  if (readToken().length === 0) return;
  try {
    await refreshPublicationQueue();
  } catch (error) {
    addEvent("Publication queue filter failed: " + error.message);
  }
});

for (const input of [publicationQueueSubject, publicationQueueLimit]) {
  input.addEventListener("input", async () => {
    if (readToken().length === 0) return;
    try {
      await refreshPublicationQueue();
    } catch (error) {
      addEvent("Publication queue filter failed: " + error.message);
    }
  });
}

proactiveCandidateScan.addEventListener("click", async () => {
  proactiveCandidateScan.disabled = true;
  try {
    await scanProactiveCandidates();
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("Proactive scan failed: " + error.message);
  } finally {
    proactiveCandidateScan.disabled = false;
  }
});

proactiveCandidateRefresh.addEventListener("click", async () => {
  proactiveCandidateRefresh.disabled = true;
  try {
    await refreshProactiveCandidates();
    addEvent("Proactive candidates refreshed");
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("Proactive candidate refresh failed: " + error.message);
  } finally {
    proactiveCandidateRefresh.disabled = false;
  }
});

auditSummaryRefresh.addEventListener("click", async () => {
  auditSummaryRefresh.disabled = true;
  try {
    await refreshAuditSummaries();
    addEvent("Audit summaries refreshed");
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("Audit summary refresh failed: " + error.message);
  } finally {
    auditSummaryRefresh.disabled = false;
  }
});

auditSummaryType.addEventListener("change", async () => {
  if (readToken().length === 0) return;
  try {
    await refreshAuditSummaries();
  } catch (error) {
    addEvent("Audit summary filter failed: " + error.message);
  }
});

for (const input of [auditSummaryDocument, auditSummaryLimit]) {
  input.addEventListener("input", async () => {
    if (readToken().length === 0) return;
    try {
      await refreshAuditSummaries();
    } catch (error) {
      addEvent("Audit summary filter failed: " + error.message);
    }
  });
}

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
