CREATE TABLE agent_execution_ledger_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  tenant_key TEXT NOT NULL CHECK (char_length(tenant_key) BETWEEN 1 AND 512),
  group_id TEXT CHECK (group_id IS NULL OR char_length(group_id) BETWEEN 1 AND 512),
  actor_open_id TEXT CHECK (actor_open_id IS NULL OR char_length(actor_open_id) BETWEEN 1 AND 512),
  subject_type TEXT NOT NULL CHECK (subject_type IN (
    'turn', 'tool_call', 'action_proposal', 'action_execution',
    'permission_decision', 'provider_request', 'hook'
  )),
  subject_id TEXT NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 512),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'turn_started', 'turn_completed', 'turn_failed', 'turn_cancelled',
    'tool_call_started', 'tool_call_progress', 'tool_call_completed',
    'tool_call_failed', 'tool_call_cancelled',
    'action_proposed', 'action_approved', 'action_rejected',
    'action_execution_started', 'action_execution_completed',
    'action_execution_failed', 'action_execution_reconciliation_required',
    'permission_allowed', 'permission_denied', 'permission_error',
    'provider_request_started', 'provider_request_completed',
    'provider_request_failed', 'hook_started', 'hook_completed', 'hook_failed'
  )),
  phase TEXT CHECK (phase IS NULL OR phase IN (
    'idle', 'context_assembly', 'sampling', 'tool_execution',
    'permission_prompt', 'approval_wait', 'external_call', 'completed'
  )),
  tool_call_id TEXT CHECK (tool_call_id IS NULL OR char_length(tool_call_id) BETWEEN 1 AND 512),
  tool_name TEXT CHECK (tool_name IS NULL OR char_length(tool_name) BETWEEN 1 AND 512),
  model_id TEXT CHECK (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 256),
  provider TEXT CHECK (provider IS NULL OR char_length(provider) BETWEEN 1 AND 128),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'success', 'error', 'cancelled', 'skipped', 'denied', 'unknown'
  )),
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR char_length(decision_reason) BETWEEN 1 AND 512
  ),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_fingerprint TEXT CHECK (
    content_fingerprint IS NULL OR content_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX agent_execution_ledger_events_group_time_idx
  ON agent_execution_ledger_events (tenant_key, group_id, created_at DESC, id DESC);

CREATE INDEX agent_execution_ledger_events_subject_time_idx
  ON agent_execution_ledger_events (tenant_key, subject_type, subject_id, created_at ASC, id ASC);

CREATE INDEX agent_execution_ledger_events_tool_call_idx
  ON agent_execution_ledger_events (tenant_key, tool_call_id, created_at ASC, id ASC)
  WHERE tool_call_id IS NOT NULL;

CREATE TRIGGER agent_execution_ledger_events_append_only
BEFORE UPDATE OR DELETE ON agent_execution_ledger_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER agent_execution_ledger_events_truncate_guard
BEFORE TRUNCATE ON agent_execution_ledger_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
