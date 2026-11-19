CREATE TABLE IF NOT EXISTS ai_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol = 'openai'),
  credential_ciphertext TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_models (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES ai_channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  interval_sec INTEGER NOT NULL CHECK (interval_sec BETWEEN 60 AND 86400),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 60000 AND timeout_ms < interval_sec * 1000),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  revision TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (channel_id, model_id),
  UNIQUE (channel_id, name)
);
