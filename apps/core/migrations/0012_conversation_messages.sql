CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  message_type TEXT NOT NULL,
  text TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  raw_event_idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_message_id)
);

CREATE INDEX IF NOT EXISTS conversation_messages_chat_sent_at_idx
  ON conversation_messages (chat_id, sent_at DESC);
