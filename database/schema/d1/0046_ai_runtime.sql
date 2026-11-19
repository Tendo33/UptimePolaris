ALTER TABLE ai_models ADD COLUMN notification_channel_ids TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS ai_runtime (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, revision TEXT NOT NULL);
INSERT INTO ai_runtime(id,json,revision) VALUES(1,'{"models":{},"channels":{}}','initial');
CREATE TABLE IF NOT EXISTS ai_daily (model_id TEXT PRIMARY KEY REFERENCES ai_models(id) ON DELETE CASCADE, days_json TEXT NOT NULL);
