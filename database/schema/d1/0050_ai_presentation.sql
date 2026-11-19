UPDATE presentation_state SET config_json=json_set(config_json,
  '$.aiEnabled',json(CASE WHEN EXISTS(SELECT 1 FROM ai_channels) THEN 'true' ELSE 'false' END),
  '$.aiOnMonitorPage',json('true'),
  '$.pages.ai',json('{"theme":null,"themeOptions":{}}')),
  revision='ai-pages-'||revision WHERE id='main';
INSERT INTO presentation_state(id,config_json,revision,updated_at)
SELECT 'main','{"agentEnabled":false,"aiEnabled":true,"aiOnMonitorPage":true,"workerService":"uptime-polaris","domains":[],"pages":{"monitor":{"theme":null,"themeOptions":{}},"agent":{"theme":null,"themeOptions":{}},"ai":{"theme":null,"themeOptions":{}}}}','ai-pages-initial',0
WHERE EXISTS(SELECT 1 FROM ai_channels) AND NOT EXISTS(SELECT 1 FROM presentation_state WHERE id='main');
