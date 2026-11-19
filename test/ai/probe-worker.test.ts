import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeAiModel, probeAiChannel } from '../../backends/worker/src/lib/ai/probe';
import type { AiProtocol } from '../../shared/ai-probe';
import { parseAiHeaders, parseAiRequest } from '../../shared/ai-request';
import { ExternalRequestBudget, ExternalBudgetExceeded } from '../../backends/worker/src/lib/http/request-budget';

const original = globalThis.fetch;
const config = { protocol: 'openai' as const, baseUrl: 'https://provider.example/v1/', apiKey: 'fixture-secret', model: 'fixture-model', timeoutMs: 1000 };
try {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://provider.example/v1/chat/completions');
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-secret');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'fixture-model', messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 64, stream: false });
    return Response.json({ choices: [{ message: { content: 'anything' } }] });
  };
  assert.equal((await probeAiModel(config)).outcome, 'ok');
  assert.equal((await probeAiModel({ ...config, baseUrl: 'https://u:p@provider.example/v1' })).outcome, 'invalid_config');
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://provider.example/custom%2Ftenant/v1//chat/completions');
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  assert.equal((await probeAiModel({ ...config, baseUrl: 'https://provider.example/custom%2Ftenant/v1//' })).outcome, 'ok');
  globalThis.fetch = async () => Response.json({ error: { message: 'fixture-secret' } }, { status: 429 });
  const rejected = await probeAiModel(config);
  assert.equal(rejected.outcome, 'rate_limit_or_quota');
  assert.doesNotMatch(JSON.stringify(rejected), /fixture-secret/);
  globalThis.fetch = async () => new Response('x'.repeat(65536), { status: 200 });
  assert.equal((await probeAiModel(config)).outcome, 'invalid_response');
  globalThis.fetch = async () => new Response('', { status: 302, headers: { location: 'https://other.example' } });
  assert.equal((await probeAiModel(config)).outcome, 'unexpected_status');
  globalThis.fetch = async () => { throw new DOMException('secret', 'TimeoutError'); };
  assert.equal((await probeAiModel(config)).outcome, 'timeout');
  const budget = new ExternalRequestBudget();
  while (budget.remaining) budget.reserve();
  await assert.rejects(() => probeAiModel(config, budget), ExternalBudgetExceeded);
  const protocols = JSON.parse(readFileSync('test/fixtures/ai-protocols.json', 'utf8')) as Array<{ protocol: AiProtocol; path: string; headers: Record<string, string>; body: unknown; response: unknown; models: unknown }>;
  for (const fixture of protocols) {
    const selected = { ...config, protocol: fixture.protocol, baseUrl: 'https://provider.example/custom%2Ftenant/v1//' };
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++;
      const channel = init?.method === 'GET';
      assert.equal(String(input), `https://provider.example/custom%2Ftenant/v1//${channel ? 'models' : fixture.path}`);
      assert.equal(init?.redirect, 'manual');
      const headers = new Headers(init?.headers);
      for (const key of ['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version']) assert.equal(headers.get(key), fixture.headers[key] ?? null);
      if (!channel) assert.deepEqual(JSON.parse(String(init?.body)), fixture.body);
      return Response.json(channel ? fixture.models : fixture.response);
    };
    assert.equal((await probeAiModel(selected)).outcome, 'ok', fixture.protocol);
    assert.equal((await probeAiChannel(selected)).outcome, 'ok', fixture.protocol);
    assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 405 }); };
    assert.equal((await probeAiChannel(selected)).outcome, 'models_endpoint_unsupported');
    globalThis.fetch = async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://other.example' } }); };
    assert.equal((await probeAiModel(selected)).outcome, 'unexpected_status');
    assert.equal(calls, 4, 'no protocol fallback or automatic retry');
  }
  globalThis.fetch = async () => { throw new Error('must not send invalid config'); };
  for (const model of ['models/gemini-model', '../models', '%2e%2e', 'gemini?key=secret', 'gemini#fragment']) assert.equal((await probeAiModel({ ...config, protocol: 'gemini', model })).outcome, 'invalid_config');
  const options = JSON.parse(readFileSync('test/fixtures/ai-options.json', 'utf8'));
  for (const headers of options.invalidHeaders) assert.equal(parseAiHeaders(headers), null);
  for (const request of options.invalidRequests) assert.equal(parseAiRequest(request), null);
  for (const fixture of protocols) {
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('cf-access-client-secret'), 'private-header-fixture');
      const body = JSON.parse(String(init?.body));
      if (fixture.protocol === 'gemini') { assert.equal(body.contents[0].parts[0].text, options.request.prompt); assert.equal(body.generationConfig.maxOutputTokens, 128); }
      else if (fixture.protocol === 'openai_responses') { assert.equal(body.input, options.request.prompt); assert.equal(body.max_output_tokens, 128); }
      else { assert.equal(body.messages[0].content, options.request.prompt); assert.equal(body.max_tokens, 128); }
      return Response.json(fixture.response);
    };
    assert.equal((await probeAiModel({ ...config, protocol: fixture.protocol, headers: options.headers, request: { ...options.request, expectedText: 'OK' } })).outcome, 'ok');
    assert.equal((await probeAiModel({ ...config, protocol: fixture.protocol, headers: options.headers, request: options.request })).outcome, 'response_mismatch');
  }
} finally { globalThis.fetch = original; }
console.log('PASS AI Worker probe: bounded request, auth, classification, timeout and budget');
