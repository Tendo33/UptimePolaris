import assert from 'node:assert/strict';
import { fetchSiteIcon } from '../../backends/worker/src/lib/monitor/icon';
import { validateSubscriptionDestination } from '../../backends/worker/src/lib/subscriptions/egress';
import { publicSubscriptionUrl } from '../../shared/subscription-fetch';

const original = globalThis.fetch;
const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
try {
  let calls: string[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 404 });
    if (url.pathname === '/') return new Response('<link rel="icon" href="/assets/logo.png">'+'x'.repeat(100000), {headers:{'content-type':'text/html','content-length':'100050'}});
    return new Response(png, {headers:{'content-type':'image/png'}});
  };
  const valid = await fetchSiteIcon(new URL('https://status.service.net'), {validateUrl: async url => { assert.equal(url.host,'status.service.net'); }});
  assert.equal(valid?.contentType,'image/png'); assert.deepEqual(calls,['/favicon.ico','/','/assets/logo.png']);
  calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls.push(url.hostname);
    if (url.hostname === 'cloudflare-dns.com') return Response.json({Status:0,Answer:[{type:1,data:url.searchParams.get('name')==='private.service.net'?'127.0.0.1':'1.1.1.1'}]});
    if (url.hostname === 'private.service.net') throw new Error('private origin reached');
    return new Response(null,{status:302,headers:{location:'https://private.service.net/icon'}});
  };
  assert.equal(await fetchSiteIcon(new URL('https://status.service.net'), {validateUrl:url=>validateSubscriptionDestination(publicSubscriptionUrl(url.href))}),null);
  assert.ok(!calls.includes('private.service.net'));
  let cancelled=0;
  globalThis.fetch = async input => new URL(String(input)).pathname==='/' ? new Response(null,{status:404}) : new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(128*1024));},cancel(){cancelled++;}}),{headers:{'content-type':'image/png'}});
  assert.equal(await fetchSiteIcon(new URL('https://status.service.net')),null); assert.equal(cancelled,1);
  globalThis.fetch = async () => new Response('<svg onload="alert(1)"></svg>',{headers:{'content-type':'image/svg+xml'}});
  assert.equal(await fetchSiteIcon(new URL('https://status.service.net')),null);
  console.log('PASS subscription icon discovery, redirect DNS validation, bounded streams and SVG refusal');
} finally {globalThis.fetch=original;}
