PRAGMA defer_foreign_keys = ON;

CREATE TABLE ai_channels_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'openai_responses', 'anthropic', 'gemini')),
  credential_ciphertext TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE ai_models_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES ai_channels_new(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  interval_sec INTEGER NOT NULL CHECK (interval_sec BETWEEN 60 AND 86400),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 60000 AND timeout_ms < interval_sec * 1000),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  revision TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  notification_channel_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE (channel_id, model_id),
  UNIQUE (channel_id, name)
);
CREATE TABLE ai_daily_new (
  model_id TEXT PRIMARY KEY REFERENCES ai_models_new(id) ON DELETE CASCADE,
  days_json TEXT NOT NULL
);

INSERT INTO ai_channels_new SELECT id,name,base_url,protocol,credential_ciphertext,revision,created_at,updated_at FROM ai_channels;
INSERT INTO ai_models_new SELECT id,channel_id,name,model_id,interval_sec,timeout_ms,enabled,is_public,revision,created_at,updated_at,notification_channel_ids FROM ai_models;
INSERT INTO ai_daily_new SELECT model_id,days_json FROM ai_daily;
DROP TABLE ai_daily;
DROP TABLE ai_models;
DROP TABLE ai_channels;
ALTER TABLE ai_channels_new RENAME TO ai_channels;
ALTER TABLE ai_models_new RENAME TO ai_models;
ALTER TABLE ai_daily_new RENAME TO ai_daily;

PRAGMA defer_foreign_keys = OFF;
