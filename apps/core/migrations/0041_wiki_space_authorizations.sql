CREATE TABLE wiki_space_authorizations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  root_source_uri TEXT NOT NULL CHECK (char_length(root_source_uri) BETWEEN 1 AND 2048),
  root_node_token TEXT NOT NULL CHECK (char_length(root_node_token) BETWEEN 1 AND 512),
  space_id TEXT CHECK (space_id IS NULL OR char_length(space_id) BETWEEN 1 AND 512),
  title TEXT CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 512),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scan_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (scan_state IN ('pending', 'scanning', 'synced', 'retry_wait', 'dead_letter', 'disabled')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_scan_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  last_scan_started_at TIMESTAMPTZ,
  last_scan_completed_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_classification TEXT
    CHECK (last_error_classification IS NULL OR char_length(last_error_classification) BETWEEN 1 AND 512),
  discovered_node_count BIGINT NOT NULL DEFAULT 0 CHECK (discovered_node_count >= 0),
  registered_document_count BIGINT NOT NULL DEFAULT 0 CHECK (registered_document_count >= 0),
  skipped_node_count BIGINT NOT NULL DEFAULT 0 CHECK (skipped_node_count >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (root_source_uri),
  CHECK (
    (enabled AND scan_state <> 'disabled')
    OR (NOT enabled AND scan_state = 'disabled')
  ),
  CHECK (
    (scan_state = 'scanning' AND lease_expires_at IS NOT NULL)
    OR (scan_state <> 'scanning' AND lease_expires_at IS NULL)
  )
);

CREATE INDEX wiki_space_authorizations_due_scan_idx
  ON wiki_space_authorizations (next_scan_at, created_at)
  WHERE enabled AND scan_state IN ('pending', 'retry_wait');

CREATE INDEX wiki_space_authorizations_expired_lease_idx
  ON wiki_space_authorizations (lease_expires_at, created_at)
  WHERE enabled AND scan_state = 'scanning';
