CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  revision TEXT NOT NULL,
  sync_revision TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_due BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions(enabled,next_due);
CREATE TABLE IF NOT EXISTS subscription_items (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  json TEXT NOT NULL,
  revision TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  UNIQUE(subscription_id,source_id)
);
CREATE INDEX IF NOT EXISTS subscription_items_public ON subscription_items(is_public,subscription_id);
CREATE TABLE IF NOT EXISTS subscription_documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  subscription_id TEXT,
  json TEXT NOT NULL,
  expires_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS subscription_documents_expiry ON subscription_documents(expires_at);
CREATE INDEX IF NOT EXISTS subscription_documents_owner ON subscription_documents(subscription_id,kind);
ALTER TABLE ai_channels ADD COLUMN notification_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN event_kinds TEXT NOT NULL DEFAULT '["monitor_state","ai_state","agent_resource"]';
ALTER TABLE notifications ADD COLUMN source_types TEXT NOT NULL DEFAULT '["local"]';
ALTER TABLE notifications ADD COLUMN ai_channel_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE notifications ADD COLUMN subscription_ids TEXT NOT NULL DEFAULT '[]';
