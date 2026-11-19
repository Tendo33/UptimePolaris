ALTER TABLE ai_channels ADD COLUMN notification_channel_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_models DROP COLUMN notification_channel_ids;
