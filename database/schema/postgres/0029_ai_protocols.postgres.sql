ALTER TABLE ai_channels DROP CONSTRAINT ai_channels_protocol_check;
ALTER TABLE ai_channels ADD CONSTRAINT ai_channels_protocol_check
  CHECK (protocol IN ('openai', 'openai_responses', 'anthropic', 'gemini'));
