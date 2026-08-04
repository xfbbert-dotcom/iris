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

    <section class="mvp-gate-panel" aria-labelledby="mvp-gate-heading">
      <div class="panel-heading">
        <div>
          <h2 id="mvp-gate-heading">Internal MVP Gate</h2>
          <p>Track the first 20-30 person rollout loops without treating one green module as complete Iris.</p>
        </div>
      </div>
      <dl id="mvp-gate-summary" class="compact-status"></dl>
      <div class="table-wrap">
        <table id="mvp-gate-table">
          <thead>
            <tr>
              <th>Loop</th>
              <th>Status</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody id="mvp-gate-rows"></tbody>
        </table>
      </div>
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
            <option value="authorized_wiki_document">Authorized wiki</option>
            <option value="user_submitted_document">User submitted</option>
          </select>
        </label>
        <label>
          Source id contains
          <input id="document-source-id-filter" placeholder="document source id">
        </label>
      </div>
      <form id="user-document-form" class="manual-source-form">
        <label>
          User document URL
          <input id="user-document-source-uri" placeholder="https://docs.feishu.cn/docx/...">
        </label>
        <label>
          Title
          <input id="user-document-title" placeholder="optional display title">
        </label>
        <label>
          Submitted by
          <input id="user-document-submitter" placeholder="Feishu user id or operator">
        </label>
        <button id="user-document-submit" type="submit" class="secondary">Submit Document</button>
      </form>
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

    <section class="wiki-space-panel" aria-labelledby="wiki-spaces-heading">
      <div class="panel-heading">
        <div>
          <h2 id="wiki-spaces-heading">Wiki Spaces</h2>
          <p>Register any page from an authorized Feishu knowledge space and monitor full-space scan state.</p>
        </div>
        <button id="wiki-space-refresh" type="button" class="secondary icon-button" title="Refresh wiki spaces" aria-label="Refresh wiki spaces">&#8635;</button>
      </div>
      <form id="wiki-space-form" class="wiki-space-form">
        <label>
          Any page URL in the knowledge space
          <input id="wiki-space-root-source-uri" type="url" placeholder="https://tenant.feishu.cn/wiki/...">
        </label>
        <button id="wiki-space-submit" type="submit" class="secondary">Register Wiki Space</button>
      </form>
      <div id="wiki-space-loading" class="loading-state" aria-live="polite"></div>
      <div id="wiki-space-error" class="error-state" role="alert"></div>
      <div class="table-wrap">
        <table id="wiki-space-table" class="wiki-space-table">
          <thead>
            <tr>
              <th>Wiki space</th>
              <th>State</th>
              <th>Documents</th>
              <th>Next scan</th>
              <th>Enabled</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="wiki-space-rows"></tbody>
        </table>
      </div>
      <div id="wiki-space-empty" class="empty-state">Connect to load wiki spaces.</div>
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
      <dl id="proactive-feedback-summary" class="proactive-feedback-summary"></dl>
      <div class="table-wrap">
        <table id="proactive-candidate-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Priority</th>
              <th>Work item</th>
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
  .mvp-gate-panel,
  .document-source-panel,
  .wiki-space-panel,
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

.wiki-space-panel {
  margin-top: 16px;
  padding: 16px;
}

.mvp-gate-panel {
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

.manual-source-form {
  display: grid;
  grid-template-columns: minmax(280px, 2fr) minmax(180px, 1fr) minmax(180px, 1fr) auto;
  gap: 12px;
  align-items: end;
  margin-top: 14px;
}

.manual-source-form button {
  min-height: 42px;
}

.wiki-space-form {
  display: grid;
  grid-template-columns: minmax(280px, 2fr) auto;
  gap: 12px;
  align-items: end;
  margin-top: 14px;
}

.wiki-space-form button {
  min-height: 42px;
}

.icon-button {
  width: 36px;
  min-width: 36px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
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

.gate-badge {
  display: inline-block;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 12px;
  font-weight: 700;
}

.gate-badge.passed {
  border-color: rgba(24, 121, 78, .35);
  color: var(--ok);
}

.gate-badge.pending,
.gate-badge.safe-off {
  border-color: rgba(178, 106, 0, .35);
  color: var(--warn);
}

.gate-badge.blocked {
  border-color: rgba(192, 57, 43, .35);
  color: var(--danger);
}

td.source-title {
  max-width: 300px;
}

.wiki-space-table {
  min-width: 760px;
  table-layout: fixed;
}

.wiki-space-table th:nth-child(1),
.wiki-space-table td:nth-child(1) {
  width: 30%;
}

.wiki-space-table th:nth-child(2),
.wiki-space-table td:nth-child(2) {
  width: 16%;
}

.wiki-space-table th:nth-child(3),
.wiki-space-table td:nth-child(3) {
  width: 16%;
}

.wiki-space-table th:nth-child(4),
.wiki-space-table td:nth-child(4) {
  width: 18%;
}

.wiki-space-table th:nth-child(5),
.wiki-space-table td:nth-child(5) {
  width: 10%;
}

.wiki-space-table th:nth-child(6),
.wiki-space-table td:nth-child(6) {
  width: 10%;
}

.wiki-space-primary,
.wiki-space-secondary {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-space-secondary {
  color: var(--muted);
  font-size: 12px;
}

.wiki-space-actions {
  display: flex;
  gap: 8px;
}

.wiki-space-toggle {
  display: inline-grid;
  grid-template-columns: 16px auto;
  align-items: center;
  gap: 6px;
  color: var(--text);
}

.wiki-space-toggle input {
  min-height: auto;
  width: 16px;
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

.loading-state,
.error-state {
  margin-top: 10px;
}

.error-state {
  color: var(--danger);
}

.compact-status {
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  margin-top: 12px;
}

.proactive-feedback-summary {
  grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr));
  gap: 8px;
  margin-top: 12px;
}

.proactive-feedback-metric {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.proactive-feedback-summary.unavailable {
  color: var(--muted);
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
  .source-filters,
  .manual-source-form,
  .wiki-space-form {
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
const mvpGateSummary = document.getElementById("mvp-gate-summary");
const mvpGateRows = document.getElementById("mvp-gate-rows");
const capabilityControls = document.getElementById("capability-controls");
const groupIdInput = document.getElementById("group-id");
const eventLog = document.getElementById("event-log");
const documentSourceRefresh = document.getElementById("document-source-refresh");
const documentSourceType = document.getElementById("document-source-type");
const documentSourceIdFilter = document.getElementById("document-source-id-filter");
const userDocumentForm = document.getElementById("user-document-form");
const userDocumentSourceUri = document.getElementById("user-document-source-uri");
const userDocumentTitle = document.getElementById("user-document-title");
const userDocumentSubmitter = document.getElementById("user-document-submitter");
const userDocumentSubmit = document.getElementById("user-document-submit");
const documentSourceRows = document.getElementById("document-source-rows");
const documentSourceEmpty = document.getElementById("document-source-empty");
const wikiSpaceRefresh = document.getElementById("wiki-space-refresh");
const wikiSpaceForm = document.getElementById("wiki-space-form");
const wikiSpaceRootSourceUri = document.getElementById("wiki-space-root-source-uri");
const wikiSpaceSubmit = document.getElementById("wiki-space-submit");
const wikiSpaceRows = document.getElementById("wiki-space-rows");
const wikiSpaceLoading = document.getElementById("wiki-space-loading");
const wikiSpaceError = document.getElementById("wiki-space-error");
const wikiSpaceEmpty = document.getElementById("wiki-space-empty");
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
const proactiveFeedbackSummary = document.getElementById("proactive-feedback-summary");
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
let proactiveCandidateRefreshGeneration = 0;
let wikiSpaceRefreshGeneration = 0;
let wikiSpaceOperationGeneration = 0;
let wikiSpaceMutationCount = 0;
let wikiSpaceMutationsIdle = Promise.resolve();
let resolveWikiSpaceMutationsIdle;
const documentSourceListBasePath = "/internal/document-sync/sources?includeLatestSnapshot=true";
const userSubmittedDocumentPath = "/internal/document-sync/user-submitted-documents";
const wikiSpaceListPath = "/internal/document-sync/wiki-spaces?limit=20";
const wikiSpaceBasePath = "/internal/document-sync/wiki-spaces";
const knowledgeDraftListBasePath = "/internal/knowledge-drafts?limit=20";
const knowledgeDraftRequestRevisionPath = "/request-revision";
const knowledgeDraftRejectPath = "/reject";
const publicationQueueBasePath = "/internal/action-proposals?status=pending_approval,approved,executing,failed,reconciliation_required&limit=20";
const proactiveSignalGroupBasePath = "/internal/proactive-signals/groups/";
const proactiveCandidateListSuffix = "/candidates?limit=20";
const proactiveFeedbackSummarySuffix = "/feedback-summary";
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

async function registerUserSubmittedDocument() {
  const sourceUri = userDocumentSourceUri.value.trim();
  const title = userDocumentTitle.value.trim();
  const submittedByUserId = userDocumentSubmitter.value.trim() || readOperator();
  if (sourceUri.length === 0) throw new Error("source_uri_required");
  if (submittedByUserId.length === 0) throw new Error("submitted_by_required");
  return requestJson(userSubmittedDocumentPath, {
    method: "POST",
    body: JSON.stringify({
      sourceUri,
      submittedByUserId,
      ...(title.length === 0 ? {} : { title }),
    }),
  });
}

function wikiSpacePath(id, suffix = "") {
  return wikiSpaceBasePath + "/" + encodeURIComponent(id) + suffix;
}

function isCurrentWikiSpaceOperation(generation) {
  return generation === wikiSpaceOperationGeneration;
}

function clearWikiSpaceError(generation = wikiSpaceOperationGeneration) {
  if (!isCurrentWikiSpaceOperation(generation)) return;
  wikiSpaceError.textContent = "";
}

function showWikiSpaceError(prefix, error, generation = wikiSpaceOperationGeneration) {
  if (!isCurrentWikiSpaceOperation(generation)) return;
  wikiSpaceError.textContent = prefix + ": " + error.message;
}

function beginWikiSpaceOperation() {
  const generation = ++wikiSpaceOperationGeneration;
  clearWikiSpaceError(generation);
  return generation;
}

function beginWikiSpaceMutation() {
  if (wikiSpaceMutationCount === 0) {
    wikiSpaceMutationsIdle = new Promise((resolve) => {
      resolveWikiSpaceMutationsIdle = resolve;
    });
  }
  wikiSpaceMutationCount += 1;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    wikiSpaceMutationCount -= 1;
    if (wikiSpaceMutationCount === 0) {
      resolveWikiSpaceMutationsIdle();
      resolveWikiSpaceMutationsIdle = undefined;
    }
  };
}

async function waitForWikiSpaceMutations() {
  while (wikiSpaceMutationCount > 0) {
    await wikiSpaceMutationsIdle;
  }
}

function setWikiSpaceConnection(message, mode, generation) {
  if (!isCurrentWikiSpaceOperation(generation)) return;
  setConnection(message, mode);
}

async function refreshWikiSpacesAfterAction(action, operationGeneration) {
  try {
    await refreshWikiSpaces(operationGeneration);
  } catch (error) {
    showWikiSpaceError("Unable to refresh wiki spaces after " + action, error, operationGeneration);
    addEvent("Wiki space refresh after " + action + " failed: " + error.message);
    setWikiSpaceConnection("Refresh warning", "warn", operationGeneration);
  }
}

function renderWikiSpaceEnabledToggle(wikiSpace) {
  const label = document.createElement("label");
  label.className = "wiki-space-toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = wikiSpace.enabled === true;
  checkbox.addEventListener("change", async () => {
    const operationGeneration = beginWikiSpaceOperation();
    const completeMutation = beginWikiSpaceMutation();
    checkbox.disabled = true;
    try {
      try {
        await requestJson(wikiSpacePath(wikiSpace.id), {
          method: "PATCH",
          body: JSON.stringify({ enabled: checkbox.checked }),
        });
      } catch (error) {
        checkbox.checked = wikiSpace.enabled === true;
        showWikiSpaceError("Unable to update wiki space enabled state", error, operationGeneration);
        addEvent("Wiki space enabled update failed: " + error.message);
        setWikiSpaceConnection("Request failed", "warn", operationGeneration);
        return;
      } finally {
        completeMutation();
      }
      addEvent("Wiki space " + (checkbox.checked ? "enabled: " : "disabled: ") + text(wikiSpace.id));
      await refreshWikiSpacesAfterAction("enabled update", operationGeneration);
    } finally {
      checkbox.disabled = false;
    }
  });
  const labelCopy = document.createElement("span");
  labelCopy.textContent = "Enabled";
  label.append(checkbox, labelCopy);
  return label;
}

function renderWikiSpaces(wikiSpaces) {
  const visibleSpaces = Array.isArray(wikiSpaces) ? wikiSpaces : [];
  wikiSpaceRows.replaceChildren();
  for (const wikiSpace of visibleSpaces) {
    const row = document.createElement("tr");

    const spaceCell = document.createElement("td");
    const title = document.createElement("strong");
    title.className = "wiki-space-primary";
    title.textContent = text(wikiSpace.title, wikiSpace.id);
    const rootSourceUri = document.createElement("div");
    rootSourceUri.className = "wiki-space-secondary";
    rootSourceUri.textContent = text(wikiSpace.rootSourceUri, wikiSpace.id);
    spaceCell.append(title, rootSourceUri);

    const stateCell = document.createElement("td");
    stateCell.textContent = text(wikiSpace.scanState);
    if (wikiSpace.lastErrorClassification) {
      const error = document.createElement("div");
      error.className = "wiki-space-secondary";
      error.textContent = text(wikiSpace.lastErrorClassification);
      stateCell.append(error);
    }

    const documentsCell = document.createElement("td");
    documentsCell.textContent =
      text(wikiSpace.registeredDocumentCount, "0") + " registered / " + text(wikiSpace.discoveredNodeCount, "0") + " found";

    const nextScanCell = document.createElement("td");
    nextScanCell.textContent = text(wikiSpace.nextScanAt, "not scheduled");

    const enabledCell = document.createElement("td");
    enabledCell.append(renderWikiSpaceEnabledToggle(wikiSpace));

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "wiki-space-actions";
    const rescanButton = document.createElement("button");
    rescanButton.type = "button";
    rescanButton.className = "secondary icon-button";
    rescanButton.title = "Rescan wiki space";
    rescanButton.setAttribute("aria-label", "Rescan wiki space");
    rescanButton.textContent = "\\u21bb";
    rescanButton.addEventListener("click", async () => {
      const operationGeneration = beginWikiSpaceOperation();
      const completeMutation = beginWikiSpaceMutation();
      rescanButton.disabled = true;
      try {
        try {
          await requestJson(wikiSpacePath(wikiSpace.id, "/rescan"), {
            method: "POST",
            body: JSON.stringify({}),
          });
        } catch (error) {
          showWikiSpaceError("Unable to rescan wiki space", error, operationGeneration);
          addEvent("Wiki space rescan failed: " + error.message);
          setWikiSpaceConnection("Request failed", "warn", operationGeneration);
          return;
        } finally {
          completeMutation();
        }
        addEvent("Wiki space rescan requested: " + text(wikiSpace.id));
        await refreshWikiSpacesAfterAction("rescan", operationGeneration);
      } finally {
        rescanButton.disabled = false;
      }
    });
    actions.append(rescanButton);
    actionsCell.append(actions);

    row.append(spaceCell, stateCell, documentsCell, nextScanCell, enabledCell, actionsCell);
    wikiSpaceRows.append(row);
  }
  wikiSpaceEmpty.textContent = visibleSpaces.length === 0 ? "No wiki spaces registered." : "";
}

async function refreshWikiSpaces(operationGeneration = wikiSpaceOperationGeneration) {
  if (wikiSpaceMutationCount > 0) {
    await waitForWikiSpaceMutations();
  }
  const generation = ++wikiSpaceRefreshGeneration;
  wikiSpaceLoading.textContent = "Loading wiki spaces...";
  clearWikiSpaceError(operationGeneration);
  try {
    const body = await requestJson(wikiSpaceListPath);
    if (generation !== wikiSpaceRefreshGeneration || !isCurrentWikiSpaceOperation(operationGeneration)) return;
    renderWikiSpaces(body.wikiSpaces);
  } catch (error) {
    if (generation !== wikiSpaceRefreshGeneration) return;
    showWikiSpaceError("Unable to load wiki spaces", error, operationGeneration);
    throw error;
  } finally {
    if (generation === wikiSpaceRefreshGeneration) wikiSpaceLoading.textContent = "";
  }
}

async function registerWikiSpace() {
  const rootSourceUri = wikiSpaceRootSourceUri.value.trim();
  if (rootSourceUri.length === 0) throw new Error("root_source_uri_required");
  return requestJson(wikiSpaceBasePath, {
    method: "POST",
    body: JSON.stringify({ rootSourceUri }),
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

function renderProactiveFeedbackSummary(summary) {
  const helpfulRate = typeof summary?.helpfulRate === "number"
    ? (summary.helpfulRate * 100).toFixed(1) + "%"
    : "--";
  proactiveFeedbackSummary.className = "proactive-feedback-summary" + (summary === undefined ? " unavailable" : "");
  proactiveFeedbackSummary.replaceChildren();
  for (const [label, value] of [
    ["Total feedback", summary?.totalCount ?? "--"],
    ["Helpful", summary?.helpfulCount ?? "--"],
    ["Irrelevant", summary?.irrelevantCount ?? "--"],
    ["Helpful rate", helpfulRate],
    ["Active suppressions", summary?.activeSuppressionCount ?? "--"],
    ["Last feedback", summary?.lastFeedbackAt ?? "--"],
  ]) {
    const metric = document.createElement("div");
    metric.className = "proactive-feedback-metric";
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = String(value);
    metric.append(term, detail);
    proactiveFeedbackSummary.append(metric);
  }
}

function isCurrentProactiveCandidateRefresh(groupId, generation) {
  return generation === proactiveCandidateRefreshGeneration && proactiveCandidateGroup.value.trim() === groupId;
}

async function refreshProactiveFeedbackSummary(groupId, generation) {
  try {
    const body = await requestJson(proactiveCandidatePath(groupId, proactiveFeedbackSummarySuffix));
    if (!isCurrentProactiveCandidateRefresh(groupId, generation)) return;
    renderProactiveFeedbackSummary(body);
  } catch (error) {
    if (!isCurrentProactiveCandidateRefresh(groupId, generation)) return;
    renderProactiveFeedbackSummary(undefined);
    setConnection("Refresh warning", "warn");
    addEvent("Proactive feedback summary unavailable: " + error.message);
  }
}

function renderProactiveCandidates(candidates) {
  proactiveCandidateRows.replaceChildren();
  for (const candidate of candidates || []) {
    const row = document.createElement("tr");

    const candidateCell = document.createElement("td");
    candidateCell.className = "source-title";
    const kind = document.createElement("strong");
    kind.textContent = text(candidate.kind);
    candidateCell.append(kind);

    const priorityCell = document.createElement("td");
    priorityCell.textContent = text(candidate.priority);

    const entityCell = document.createElement("td");
    const ready = candidate.approvalState === "ready" && typeof candidate.subjectLabel === "string" && candidate.subjectLabel.trim().length > 0;
    const candidateLabel = ready
      ? (candidate.entityType === "thread" ? "Discussion: " : "Action: ") + text(candidate.subjectLabel)
      : "Stale (the work item changed, closed, or is no longer visible)";
    entityCell.textContent = candidateLabel;

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
      const staleApproval = suffix === proactiveCandidateApproveSuffix && !ready;
      button.type = "button";
      button.className = danger ? "danger" : "secondary";
      button.textContent = label;
      button.disabled = staleApproval;
      if (staleApproval) {
        button.title = "This stale candidate cannot be approved.";
        button.setAttribute("aria-disabled", "true");
      } else {
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await transitionProactiveCandidate(candidate, suffix);
            addEvent(label + " recorded for " + candidateLabel);
            await refreshProactiveCandidates();
          } catch (error) {
            addEvent(label + " failed: " + error.message);
            setConnection("Request failed", "warn");
          } finally {
            button.disabled = false;
          }
        });
      }
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
  const generation = ++proactiveCandidateRefreshGeneration;
  const candidateRefresh = requestJson(proactiveCandidateListPath(groupId));
  const summaryRefresh = refreshProactiveFeedbackSummary(groupId, generation);
  let candidateBody;
  try {
    candidateBody = await candidateRefresh;
  } catch (error) {
    if (!isCurrentProactiveCandidateRefresh(groupId, generation)) return;
    throw error;
  }
  if (!isCurrentProactiveCandidateRefresh(groupId, generation)) return;
  renderProactiveCandidates(candidateBody.candidates || []);
  await summaryRefresh;
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

function renderMvpGate(status, readiness, runtime) {
  const components = status.components || {};
  const runtimeSafeOff = runtime.globalEnabled !== true && runtime.desiredGlobalEnabled !== true;
  const hasBlockingReadiness = readiness.status === "blocked" || readiness.ok === false;
  const memoryExtraction = components.memoryExtraction || {};
  const proactiveSignals = components.proactiveSignals || {};
  const knowledgeCards = components.knowledgeCards || {};
  const actionApprovals = components.actionApprovals || {};
  const eventStatus = components.events || {};
  const documentSync = components.documentSync || {};
  const reindex = components.reindex || {};
  const queuesClear = [
    eventStatus.pendingEventCount,
    eventStatus.deadLetterEventCount,
    documentSync.pendingJobCount,
    documentSync.deadLetterJobCount,
    reindex.pendingJobCount,
    reindex.deadLetterJobCount,
    memoryExtraction.pendingJobCount,
    memoryExtraction.processingJobCount,
    memoryExtraction.delayedJobCount,
    memoryExtraction.deadLetterJobCount,
  ].every((value) => value === 0 || value === undefined);
  const semanticReady = memoryExtraction.enabled === true && memoryExtraction.deadLetterJobCount === 0;
  const docsReady = documentSync.status === "healthy" || documentSync.status === "running";
  const publicationReady = actionApprovals.enabled === true || knowledgeCards.enabled === true;
  const proactivePreviewReady = proactiveSignals.planner?.enabled === true || proactiveSignals.enabled === true;
  const proactiveDeliveryReady = proactiveSignals.delivery?.enabled === true && runtime.capabilities?.proactiveSpeech === true;

  const gates = [
    ["Shared group context", semanticReady ? "pending" : "pending", "semantic gray pending"],
    ["Semantic memory", semanticReady ? "pending" : "blocked", semanticReady ? "real Feishu pending" : "Gemini/DLQ replay pending"],
    ["Document reading", docsReady ? "passed" : "pending", docsReady ? "group/wiki/user docs wired" : "document sync not ready"],
    ["Permission revocation", "passed", "live permission guard pilot evidence recorded"],
    ["Knowledge draft confirmation", knowledgeCards.enabled === true ? "passed" : "passed", "group confirmation and review cards recorded"],
    ["Approval before action", actionApprovals.enabled === true ? "passed" : "passed", "review attestation and role approval recorded"],
    ["Knowledge publication", publicationReady ? "passed" : "passed", "first Feishu wiki publication recorded"],
    ["Proactive preview", proactivePreviewReady ? "pending" : "safe-off", proactivePreviewReady ? "candidate scan ready; real Feishu pending" : "planner default off"],
    ["Proactive delivery", proactiveDeliveryReady ? "pending" : "safe-off", "real Feishu pending"],
    ["Emergency stop", runtimeSafeOff && queuesClear ? "passed" : "blocked", runtimeSafeOff ? "global fail-closed" : "runtime is enabled"],
  ];
  const blocked = gates.filter((gate) => gate[1] === "blocked").length;
  const pending = gates.filter((gate) => gate[1] === "pending").length;
  const passed = gates.filter((gate) => gate[1] === "passed").length;
  renderDefinitionList(mvpGateSummary, [
    ["Passed", passed],
    ["Pending", pending],
    ["Blocked", blocked + (hasBlockingReadiness ? 1 : 0)],
    ["Safe off", gates.filter((gate) => gate[1] === "safe-off").length],
    ["Next gate", "semantic gray pending"],
  ]);

  mvpGateRows.replaceChildren();
  for (const [label, gateStatus, evidence] of gates) {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = label;
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "gate-badge " + gateStatus;
    badge.textContent = gateStatus;
    statusCell.append(badge);
    const evidenceCell = document.createElement("td");
    evidenceCell.textContent = evidence;
    row.append(labelCell, statusCell, evidenceCell);
    mvpGateRows.append(row);
  }
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
  const proactiveSignals = status.components?.proactiveSignals || {};
  renderDefinitionList(systemStatus, [
    ["Overall", status.status || "unknown"],
    ["Needs attention", status.summary?.requiresOperatorAttention === true ? "yes" : "no"],
    ["Primary attention", status.summary?.primaryAttentionComponent?.name || "none"],
    ["Components", status.summary?.componentCount ?? "unknown"],
    ["Proactive planner", summarizeProactivePlanner(proactiveSignals)],
    ["Proactive delivery", summarizeProactiveDelivery(proactiveSignals)],
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
  renderMvpGate(status, readiness, runtime);
  renderCapabilityControls(runtime.capabilities || {});
}

function summarizeProactivePlanner(proactiveSignals) {
  const planner = proactiveSignals.planner;
  if (!planner) return proactiveSignals.enabled === true ? "unknown" : "disabled";
  const enabled = planner.enabled === true ? "enabled" : "disabled";
  const running = planner.running === true ? "running" : "stopped";
  const groups = planner.enabledGroupCount ?? 0;
  return enabled + " / " + running + " / groups " + groups;
}

function summarizeProactiveDelivery(proactiveSignals) {
  const delivery = proactiveSignals.delivery;
  if (!delivery) return proactiveSignals.enabled === true ? "unknown" : "disabled";
  const enabled = delivery.enabled === true ? "enabled" : "disabled";
  const running = delivery.running === true ? "running" : "stopped";
  const dispatcher = delivery.dispatcher?.running === true ? "dispatcher running" : "dispatcher stopped";
  return enabled + " / " + running + " / " + dispatcher;
}

async function refresh() {
  const [status, readiness, runtime] = await Promise.all([
    requestJson("/internal/status"),
    requestJson("/internal/readiness"),
    requestJson("/internal/runtime-control/status"),
  ]);
  render(status, readiness, runtime);
  await refreshDocumentSources();
  await refreshWikiSpaces();
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

wikiSpaceRefresh.addEventListener("click", async () => {
  const operationGeneration = beginWikiSpaceOperation();
  wikiSpaceRefresh.disabled = true;
  try {
    await refreshWikiSpaces(operationGeneration);
    addEvent("Wiki spaces refreshed");
  } catch (error) {
    setWikiSpaceConnection("Request failed", "warn", operationGeneration);
    addEvent("Wiki space refresh failed: " + error.message);
  } finally {
    wikiSpaceRefresh.disabled = false;
  }
});

wikiSpaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const operationGeneration = beginWikiSpaceOperation();
  const completeMutation = beginWikiSpaceMutation();
  wikiSpaceSubmit.disabled = true;
  try {
    let body;
    try {
      body = await registerWikiSpace();
    } catch (error) {
      showWikiSpaceError("Unable to register wiki space", error, operationGeneration);
      setWikiSpaceConnection("Request failed", "warn", operationGeneration);
      addEvent("Wiki space registration failed: " + error.message);
      return;
    } finally {
      completeMutation();
    }
    wikiSpaceRootSourceUri.value = "";
    addEvent("Wiki space registered: " + text(body.authorization?.id, "unknown wiki space"));
    await refreshWikiSpacesAfterAction("registration", operationGeneration);
  } finally {
    wikiSpaceSubmit.disabled = false;
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

userDocumentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  userDocumentSubmit.disabled = true;
  try {
    const body = await registerUserSubmittedDocument();
    userDocumentSourceUri.value = "";
    userDocumentTitle.value = "";
    addEvent("User document registered: " + text(body.source?.id, "unknown source"));
    await refreshDocumentSources();
  } catch (error) {
    setConnection("Request failed", "warn");
    addEvent("User document registration failed: " + error.message);
  } finally {
    userDocumentSubmit.disabled = false;
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
