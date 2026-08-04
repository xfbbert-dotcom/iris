CREATE TABLE conversation_message_deletion_tombstones (
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  provider_message_id TEXT NOT NULL CHECK (char_length(provider_message_id) BETWEEN 1 AND 512),
  conversation_message_id TEXT NOT NULL UNIQUE CHECK (
    char_length(conversation_message_id) BETWEEN 1 AND 512
  ),
  chat_id TEXT NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 512),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_message_id),
  CHECK (conversation_message_id = provider || ':' || provider_message_id)
);
