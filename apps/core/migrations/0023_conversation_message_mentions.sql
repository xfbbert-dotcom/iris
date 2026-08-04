CREATE TABLE conversation_message_mentions (
  conversation_message_id TEXT NOT NULL
    REFERENCES conversation_messages(id) ON DELETE CASCADE,
  mention_key TEXT NOT NULL CHECK (char_length(mention_key) BETWEEN 1 AND 512),
  mentioned_open_id TEXT NOT NULL
    CHECK (char_length(mentioned_open_id) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_message_id, mention_key),
  UNIQUE (conversation_message_id, mentioned_open_id)
);

CREATE INDEX conversation_message_mentions_open_id_idx
  ON conversation_message_mentions (mentioned_open_id, conversation_message_id);
