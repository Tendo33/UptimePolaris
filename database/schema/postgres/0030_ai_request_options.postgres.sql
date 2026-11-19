ALTER TABLE ai_channels ADD COLUMN headers_ciphertext TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_channels ADD COLUMN header_names_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_models ADD COLUMN request_json TEXT NOT NULL DEFAULT '{"prompt":"Reply OK.","maxOutputTokens":64,"expectedText":""}';
