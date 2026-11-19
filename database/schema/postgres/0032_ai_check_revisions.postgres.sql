ALTER TABLE ai_channels ADD COLUMN check_revision TEXT NOT NULL DEFAULT '';
UPDATE ai_channels SET check_revision=revision;
ALTER TABLE ai_models ADD COLUMN check_revision TEXT NOT NULL DEFAULT '';
UPDATE ai_models SET check_revision=revision;
