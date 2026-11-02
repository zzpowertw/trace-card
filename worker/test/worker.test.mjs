// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {_internal} from '../src/index.js';
import {fakeGarmin, memoryKV, makeFit, makeZip} from './helpers.mjs';

const realFetch = globalThis.fetch;
function setup({kv = true} = {}){
  const g = fakeGarmin();
  globalThis.fetch = g.fetchImpl;
  const env = {GARMIN_API_KEY: 'test-garmin-key', ACCESS_KEY: 'pw-123', ALLOWED_ORIGINS: ''};
  if (kv) env.TRACE_KV = memoryKV();
  const call = (path, {key = 'pw-123', method = 'GET', origin = 'https://zz.github.io'} = {}) => {
    const headers = {Origin: origin}; if (key != null) headers['X-Key'] = key;
    return worker.fetch(new Request('https://w.example' + path, {method, headers}), env, {waitUntil(){}});
  };
  return {g, env, call};
}
test.after(() => { globalThis.fetch = realFetch; });

test('health needs no key and reports config', async () => {
  const {call} = setup();
  const r = await call('/health', {key: null});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.hasApiKey, true); assert.equal(j.hasKV, true);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('CORS preflight', async () => {
  const {call} = setup();
  const r = await call('/activities', {method: 'OPTIONS', key: null});
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-Key/);
});

test('wrong / missing access key -> 401 with CORS', async () => {
  const {call} = setup();
  for (const key of [null, 'nope']){
    const r = await call('/activities', {key});
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'BAD_ACCESS_KEY');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  }
});

test('activities: slim list, sorted, token cached across calls', async () => {
  const {g, call} = setup({kv: false});
  const r = await call('/activities?days=7');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.activities.map(a => a.id), ['1002', '1001']);
  assert.deepEqual(Object.keys(j.activities[0]).sort(), ['distance','duration','elapsedDuration','id','movingDuration','name','start','startGMT','type'].sort());
  assert.equal(j.activities[0].type, 'road_biking');
  assert.match(g.state.lastSearch.startDate, /^\d{4}-\d\d-\d\d$/);
  await call('/activities?days=7');
  assert.equal(g.state.tokenCalls, 1, 'token reused');
});

test('activities: bad days', async () => {
  const {call} = setup();
  assert.equal((await call('/activities?days=0')).status, 400);
  assert.equal((await call('/activities?days=abc')).status, 400);
});

test('KV snapshot served when fresh, bypassed with fresh=1', async () => {
  const {g, call} = setup();
  await call('/activities?days=30');           // builds snapshot
  const before = g.state.searchCalls;
  const j = await (await call('/activities?days=30')).json();
  assert.equal(j.cached, true);
  assert.equal(g.state.searchCalls, before);
  const j2 = await (await call('/activities?days=30&fresh=1')).json();
  assert.equal(j2.cached, false);
  assert.ok(g.state.searchCalls > before);
});

test('cron fills snapshot', async () => {
  const {env} = setup();
  const waits = [];
  await worker.scheduled({}, env, {waitUntil: p => waits.push(p)});
  await Promise.all(waits);
  const snap = JSON.parse(env.TRACE_KV.m.get('garmin:activities:snapshot'));
  assert.equal(snap.activities.length, 2);
});

test('fit: unzips and returns the original FIT bytes', async () => {
  const {g, call} = setup();
  const r = await call('/fit/1002');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/octet-stream');
  const b = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual(b, g.state.fit);
});

test('fit: errors', async () => {
  const {call} = setup();
  assert.equal((await call('/fit/abc')).status, 404);
  assert.equal((await call('/fit/404')).status, 404);
  const r = await call('/fit/555');
  assert.equal((await r.json()).code, 'NO_FIT');
});

test('rejected bearer token is re-exchanged once', async () => {
  const {g, call} = setup();
  await call('/activities?days=7&fresh=1');
  g.state.rejectNextBearer = true;
  const r = await call('/activities?days=7&fresh=1');
  assert.equal(r.status, 200);
  assert.equal(g.state.tokenCalls, 2);
});

test('expired Garmin key -> clear message', async () => {
  const {g, call} = setup();
  g.state.keyValid = false;
  const r = await call('/activities?days=7');
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.code, 'KEY_EXPIRED');
  assert.match(j.message, /請到 Garmin Connect 重新建立/);
});

test('ALLOWED_ORIGINS restricts origin', async () => {
  const {env, call} = setup();
  env.ALLOWED_ORIGINS = 'https://zz.github.io';
  assert.equal((await call('/health', {origin: 'https://zz.github.io'})).headers.get('Access-Control-Allow-Origin'), 'https://zz.github.io');
  assert.equal((await call('/health', {origin: 'https://evil.example'})).headers.get('Access-Control-Allow-Origin'), 'https://zz.github.io');
});

test('extractFit handles stored zip & plain FIT', async () => {
  const fit = makeFit({n: 5});
  const plain = await _internal.extractFit(fit.slice().buffer);
  assert.deepEqual(plain.bytes, fit);
  const z = makeZip('a.fit', fit, {withDescriptor: false});
  const r = await _internal.extractFit(z.slice().buffer);
  assert.deepEqual(r.bytes, fit);
});
