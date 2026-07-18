CREATE TABLE proactive_signal_candidates (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  source_type TEXT NOT NULL CHECK (source_type IN ('thread', 'action')),
  thread_id TEXT,
  action_item_id TEXT,
  source_version BIGINT NOT NULL CHECK (source_version >= 1),
  reason TEXT NOT NULL CHECK (reason IN (
    'quiet_unresolved_thread', 'quiet_open_action', 'overdue_action'
  )),
  score DOUBLE PRECISION NOT NULL CHECK (score BETWEEN 0 AND 1),
  score_factors JSONB NOT NULL CHECK (jsonb_typeof(score_factors) = 'object'),
  explanation TEXT NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 512),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dismissed', 'expired')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  source_activity_at TIMESTAMPTZ NOT NULL,
  eligible_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  dismissed_at TIMESTAMPTZ,
  dismissed_by TEXT CHECK (
    dismissed_by IS NULL OR char_length(dismissed_by) BETWEEN 1 AND 512
  ),
  dismissal_reason TEXT CHECK (
    dismissal_reason IS NULL OR char_length(dismissal_reason) BETWEEN 1 AND 512
  ),
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (thread_id, group_id)
    REFERENCES discussion_threads(id, group_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_item_id, group_id)
    REFERENCES action_items(id, group_id) ON DELETE RESTRICT,
  CHECK (
    (source_type = 'thread' AND thread_id IS NOT NULL AND action_item_id IS NULL)
    OR (source_type = 'action' AND action_item_id IS NOT NULL AND thread_id IS NULL)
  ),
  CHECK (
    (status = 'pending' AND dismissed_at IS NULL AND dismissed_by IS NULL
      AND dismissal_reason IS NULL AND expired_at IS NULL)
    OR (status = 'dismissed' AND dismissed_at IS NOT NULL AND dismissed_by IS NOT NULL
      AND expired_at IS NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND dismissed_at IS NULL
      AND dismissed_by IS NULL AND dismissal_reason IS NULL)
  )
);

CREATE UNIQUE INDEX proactive_signal_candidates_idempotency_idx
  ON proactive_signal_candidates (
    group_id,
    source_type,
    COALESCE(thread_id, action_item_id),
    source_version,
    reason,
    policy_version
  );

CREATE UNIQUE INDEX proactive_signal_candidates_one_pending_idx
  ON proactive_signal_candidates (
    group_id,
    source_type,
    COALESCE(thread_id, action_item_id),
    reason
  )
  WHERE status = 'pending';

CREATE INDEX proactive_signal_candidates_group_status_score_idx
  ON proactive_signal_candidates (group_id, status, score DESC, eligible_at ASC, id ASC);

CREATE TABLE proactive_signal_candidate_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  candidate_id TEXT NOT NULL REFERENCES proactive_signal_candidates(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'dismissed', 'expired')),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  actor TEXT CHECK (actor IS NULL OR char_length(actor) BETWEEN 1 AND 512),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, to_version)
);

CREATE TABLE proactive_signal_scan_runs (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  requested_group_ids TEXT[] NOT NULL CHECK (cardinality(requested_group_ids) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  scanned_source_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_source_count >= 0),
  created_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (created_candidate_count >= 0),
  duplicate_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_candidate_count >= 0),
  expired_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (expired_candidate_count >= 0),
  skipped_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_candidate_count >= 0),
  failure_classification TEXT CHECK (
    failure_classification IS NULL OR char_length(failure_classification) BETWEEN 1 AND 128
  ),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'processing' AND finished_at IS NULL AND failure_classification IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND failure_classification IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND failure_classification IS NOT NULL)
  )
);

CREATE INDEX proactive_signal_scan_runs_started_idx
  ON proactive_signal_scan_runs (started_at DESC, id DESC);

CREATE OR REPLACE FUNCTION proactive_signal_event_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'proactive signal event records are append-only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER proactive_signal_candidate_events_append_only
BEFORE UPDATE OR DELETE ON proactive_signal_candidate_events
FOR EACH ROW EXECUTE FUNCTION proactive_signal_event_append_only_guard();

CREATE TRIGGER proactive_signal_candidate_events_truncate_guard
BEFORE TRUNCATE ON proactive_signal_candidate_events
FOR EACH STATEMENT EXECUTE FUNCTION proactive_signal_event_append_only_guard();
