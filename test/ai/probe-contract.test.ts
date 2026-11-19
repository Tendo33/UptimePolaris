import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyAiResponse, type AiProtocol } from '../../shared/ai-probe';

const cases = JSON.parse(readFileSync('test/fixtures/ai-probe-responses.json', 'utf8')) as Array<{
  name: string; protocol?: AiProtocol; status: number; body: unknown; outcome: string;
}>;
for (const item of cases) assert.equal(classifyAiResponse(item.status, item.body, item.protocol), item.outcome, item.name);
console.log(`PASS AI response contract: ${cases.length} cases`);
