CREATE TABLE approval_interaction_intents (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  callback_key TEXT NOT NULL UNIQUE CHECK (char_length(callback_key) BETWEEN 1 AND 512),
  interaction_kind TEXT NOT NULL CHECK (interaction_kind IN (
    'knowledge_draft_confirmation', 'action_proposal_approval'
  )),
  action TEXT NOT NULL CHECK (action IN ('request_revision', 'reject')),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  rejection_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((action = 'reject') = rejection_confirmed)
);
