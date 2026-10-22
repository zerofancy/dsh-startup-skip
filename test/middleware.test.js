import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createState, createMiddleware } from '../core.js';

// Run with: node --test test/middleware.test.js
// Deliberately uses real HTTP sockets and the bridge's writeHead/write/end shape.
// No plugin/profile setup, external packages, subprocesses, or request-body parser.
const PATHS = {
  analytics: '/api/productAnalytics/enabled',
  settings: '/api/settings/describe',
  providers: '/api/llm/listConfigurableProviders',
  credentials: '/api/credentials/describe',
};
const SETTINGS = {
  namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }],
};
const CREDENTIALS = { DEEPSEEK_API_KEY: { configured: false, writable: true } };
const DEFAULT_VALUES = { analytics: false, settings: SETTINGS, providers: [], credentials: CREDENTIALS };
const TEST_OPTIONS = { timeout: 5000 };
const clone = (value) => structuredClone(value);
const rpc = (value) => ({ type: 'server-response', rpcId: 'test-id', result: { ok: true, value } });
const bytes = (value) => Buffer.from(JSON.stringify(value));
const defer = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function packet(stage, options = {}) {
  const body = options.body === undefined ? bytes(rpc(clone(DEFAULT_VALUES[stage]))) : Buffer.from(options.body);
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) },
    body,
    ...options,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      ...options.headers,
    },
  };
}

async function fixture(t, options = {}) {
  const state = createState();
  const queues = new Map();
  const sockets = new Set();
  const errors = [];
  const records = [];
  const bodyReads = [];
  const middleware = createMiddleware({ state, ...options });
  const server = http.createServer((req, res) => {
    const stage = Object.keys(PATHS).find((key) => PATHS[key] === req.url);
    const plan = queues.get(req.url)?.shift() ?? packet(stage || 'analytics');
    records.push({ method: req.method, path: req.url, headers: req.headers });
    const next = async () => {
      plan.entered?.resolve();
      if (plan.wait) await plan.wait;
      if (plan.beforeWrite) await plan.beforeWrite(req, res);
      if (plan.throwBeforeWrite) throw new Error('deliberate downstream failure');
      if (res.destroyed) return;
      res.writeHead(plan.status, plan.headers);
      const chunks = plan.chunks ?? [plan.body];
      for (let i = 0; i < chunks.length; i++) {
        if (res.destroyed) return;
        res.write(chunks[i]);
        if (i === 0 && plan.afterFirstWrite) await plan.afterFirstWrite(req, res);
        if (plan.yieldChunks) await new Promise((resolve) => setImmediate(resolve));
      }
      if (plan.throwAfterWrite) throw new Error('deliberate partial downstream failure');
      if (plan.destroyAfterWrite) return res.destroy();
      res.end();
    };
    // Observe only middleware access, not Node HTTP's own automatic draining.
    // The proxy still wraps the actual IncomingMessage from the real socket.
    const observedReq = new Proxy(req, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (['read', 'resume', 'pipe'].includes(key) || key === Symbol.asyncIterator) {
          return (...args) => {
            bodyReads.push(String(key));
            return value.apply(target, args);
          };
        }
        if (['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'].includes(key)) {
          return (event, ...args) => {
            if (event === 'data' || event === 'readable') bodyReads.push(`${key}:${event}`);
            return value.call(target, event, ...args);
          };
        }
        return value;
      },
    });
    Promise.resolve().then(() => middleware(observedReq, res, next)).catch((error) => {
      errors.push(error);
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('downstream failed');
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  function queue(stage, plan) {
    const path = PATHS[stage] ?? stage;
    if (!queues.has(path)) queues.set(path, []);
    queues.get(path).push(plan);
  }
  function start(stage, requestOptions = {}) {
    let request;
    const response = new Promise((resolve, reject) => {
      const { headers, body, leaveOpen, ...rest } = requestOptions;
      const outgoingHeaders = { cookie: 'dsh-test=native', 'content-type': 'application/json', ...headers };
      for (const key of Object.keys(outgoingHeaders)) {
        if (outgoingHeaders[key] === undefined) delete outgoingHeaders[key];
      }
      request = http.request({
        host: '127.0.0.1', port, path: PATHS[stage] ?? stage,
        method: 'POST', agent: false,
        headers: outgoingHeaders,
        ...rest,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('response aborted')));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      });
      request.setTimeout(2000, () => request.destroy(new Error('test request timeout')));
      request.on('error', reject);
      if (leaveOpen) {
        request.flushHeaders();
        if (body !== undefined) request.write(body);
      } else request.end(body);
    });
    return { request, response };
  }
  const send = (stage, requestOptions) => start(stage, requestOptions).response;
  async function preamble() {
    for (const stage of ['analytics', 'settings', 'providers']) {
      const result = await send(stage);
      assert.equal(result.status, 200);
    }
  }
  return { state, queue, start, send, preamble, errors, records, bodyReads };
}

function json(response) {
  return JSON.parse(response.body.toString('utf8'));
}
function assertUnchanged(response, plan) {
  assert.equal(response.status, plan.status);
  assert.deepEqual(response.body, Buffer.from(plan.body), 'response bytes must remain unchanged');
  if (plan.headers['content-length'] !== undefined) {
    assert.equal(response.headers['content-length'], String(plan.headers['content-length']));
  }
  if (plan.headers['content-type'] !== undefined) {
    assert.equal(response.headers['content-type'], plan.headers['content-type']);
  }
}
function assertRealCredentialFalse(response) {
  const value = json(response).result.value;
  assert.deepEqual(value, CREDENTIALS, 'real credentials must be returned without a synthetic marker');
}
function assertSynthetic(response, original = CREDENTIALS) {
  const envelope = json(response);
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, 'test-id');
  assert.equal(envelope.result.ok, true);
  const value = envelope.result.value;
  for (const [key, entry] of Object.entries(original)) {
    assert.deepEqual(value[key], entry, `real credential ${key} must not be overwritten`);
  }
  const extras = Object.entries(value).filter(([key]) => !Object.hasOwn(original, key));
  assert.ok(extras.length >= 1, 'append a clearly separate synthetic credential marker');
  assert.ok(extras.some(([, entry]) => entry && entry.configured === true), 'marker must advertise configured:true');
  assert.equal(response.headers['content-encoding'], undefined);
  if (response.headers['content-length'] !== undefined) {
    assert.equal(Number(response.headers['content-length']), response.body.length, 'Content-Length counts UTF-8 bytes');
  }
  assert.ok(!(response.headers['content-length'] && response.headers['transfer-encoding']), 'do not send conflicting framing headers');
}

async function assertNoLaterRewrite(f) {
  await f.preamble();
  assertRealCredentialFalse(await f.send('credentials'));
}

test('createState starts active and waiting for the preamble; states are independent', TEST_OPTIONS, () => {
  const a = createState();
  const b = createState();
  assert.equal(a.active, true);
  assert.equal(a.phase, 'waiting-preamble');
  assert.equal(typeof a.phase, 'string');
  assert.ok('reason' in a, 'state exposes its diagnostic reason');
  assert.notStrictEqual(a, b);
  a.active = false;
  assert.equal(b.active, true);
});

test('native sequence accepts analytics:false/providers:[] and changes credentials only once', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  for (const stage of ['analytics', 'settings', 'providers']) {
    const plan = packet(stage);
    f.queue(stage, plan);
    assertUnchanged(await f.send(stage), plan);
  }
  const original = clone(CREDENTIALS);
  const plan = packet('credentials');
  f.queue('credentials', plan);
  const response = await f.send('credentials');
  assertSynthetic(response);
  assert.deepEqual(CREDENTIALS, original, 'fixture/source data is never mutated');
  assert.equal(f.state.phase, 'consumed');
  assertRealCredentialFalse(await f.send('credentials'));
  await assertNoLaterRewrite(f);
  assert.deepEqual(f.errors, []);
});

test('configured:true consumes the opportunity without adding a marker', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const value = { DEEPSEEK_API_KEY: { configured: true, writable: true } };
  const plan = packet('credentials', { body: bytes(rpc(value)) });
  f.queue('credentials', plan);
  assertUnchanged(await f.send('credentials'), plan);
  assert.equal(f.state.phase, 'consumed');
  assertRealCredentialFalse(await f.send('credentials'));
});

test('Origin browser traffic passes through without stealing any native stage', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  for (const stage of ['analytics', 'settings', 'providers', 'credentials']) {
    const plan = packet(stage);
    f.queue(stage, plan);
    assertUnchanged(await f.send(stage, { headers: { origin: 'http://localhost:16967' } }), plan);
  }
  assert.equal(f.state.phase, 'waiting-preamble');
  await f.preamble();
  const browserPlan = packet('credentials');
  f.queue('credentials', browserPlan);
  assertUnchanged(await f.send('credentials', { headers: { origin: 'null' } }), browserPlan);
  assertSynthetic(await f.send('credentials'));
});

test('Referer browser traffic is ineligible and does not consume the native preamble', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const plan = packet('analytics');
  f.queue('analytics', plan);
  assertUnchanged(await f.send('analytics', { headers: { referer: 'http://localhost:16967/' } }), plan);
  assert.equal(f.state.phase, 'waiting-preamble');
  await f.preamble();
  assertSynthetic(await f.send('credentials'));
});

test('a request without a cookie and a GET are not native startup requests', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.send('analytics', { headers: { cookie: undefined } });
  await f.send('analytics', { method: 'GET' });
  assert.equal(f.state.phase, 'waiting-preamble');
  await f.preamble();
  assertSynthetic(await f.send('credentials'));
});

test('an out-of-order credentials request never changes subsequent business credentials', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  assertRealCredentialFalse(await f.send('credentials'));
  assertRealCredentialFalse(await f.send('credentials'));
});

test('an unrelated route is byte-transparent and does not steal the sequence', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const plan = packet('analytics', { body: Buffer.from('ordinary business payload'), headers: { 'content-type': 'text/plain' } });
  f.queue('/api/not-startup', plan);
  assertUnchanged(await f.send('/api/not-startup'), plan);
  await f.preamble();
  assertSynthetic(await f.send('credentials'));
});

test('buffered UTF-8 split at every byte is preserved and rewritten framing is correct', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const value = { ...clone(CREDENTIALS), '未配置🔑': { configured: false, writable: false, label: '中文 / café / 🔑' } };
  const body = bytes(rpc(value));
  const plan = packet('credentials', {
    body,
    chunks: Array.from(body, (byte) => Buffer.from([byte])),
    yieldChunks: true,
    headers: { 'x-bridge-test': 'preserve-me' },
  });
  f.queue('credentials', plan);
  const response = await f.send('credentials');
  assertSynthetic(response, value);
  assert.equal(response.headers['x-bridge-test'], 'preserve-me');
  assert.ok(response.body.length > body.length, 'a separate marker increases the JSON payload');
});

test('chunked downstream response works without an original Content-Length', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const body = bytes(rpc(clone(CREDENTIALS)));
  const plan = packet('credentials', { body, chunks: [body.subarray(0, 17), body.subarray(17)] });
  delete plan.headers['content-length'];
  f.queue('credentials', plan);
  assertSynthetic(await f.send('credentials'));
});

const BAD_RESPONSES = [
  ['HTTP failure', () => packet('credentials', { status: 500 })],
  ['RPC failure', () => packet('credentials', { body: bytes({ type: 'server-response', rpcId: 'test-id', result: { ok: false, error: { message: 'no' } } }) })],
  ['wrong RPC envelope', () => packet('credentials', { body: bytes({ result: { ok: true, value: CREDENTIALS } }) })],
  ['invalid JSON', () => packet('credentials', { body: Buffer.from('{"broken":') })],
  ['non-JSON content type', () => packet('credentials', { headers: { 'content-type': 'text/plain' } })],
  ['compressed response', () => packet('credentials', { headers: { 'content-encoding': 'gzip' } })],
  ['null credentials', () => packet('credentials', { body: bytes(rpc(null)) })],
  ['array credentials', () => packet('credentials', { body: bytes(rpc([])) })],
];
for (const [name, makePlan] of BAD_RESPONSES) {
  test(`${name} passes unchanged and permanently fails closed`, TEST_OPTIONS, async (t) => {
    const f = await fixture(t);
    await f.preamble();
    const plan = makePlan();
    f.queue('credentials', plan);
    const response = await f.send('credentials');
    assertUnchanged(response, plan);
    if (plan.headers['content-encoding']) assert.equal(response.headers['content-encoding'], plan.headers['content-encoding']);
    assert.equal(f.state.phase, 'disabled');
    assertRealCredentialFalse(await f.send('credentials'));
    await assertNoLaterRewrite(f);
  });
}

test('invalid settings response disables the round before credentials', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.send('analytics');
  const plan = packet('settings', { body: bytes(rpc({ namespaces: 'not-an-array' })) });
  f.queue('settings', plan);
  assertUnchanged(await f.send('settings'), plan);
  assert.equal(f.state.phase, 'disabled');
  await f.send('providers');
  assertRealCredentialFalse(await f.send('credentials'));
});

test('error on an early preamble stage cannot be retried into a later rewrite', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const plan = packet('analytics', { body: bytes({ type: 'server-response', rpcId: 'test-id', result: { ok: false, error: 'failed' } }) });
  f.queue('analytics', plan);
  assertUnchanged(await f.send('analytics'), plan);
  assert.equal(f.state.phase, 'disabled');
  await assertNoLaterRewrite(f);
});

test('response exceeding maxBytes is passed byte-for-byte and disables the round', TEST_OPTIONS, async (t) => {
  const f = await fixture(t, { maxBytes: 1024 });
  await f.preamble();
  const body = bytes(rpc({ ...clone(CREDENTIALS), padding: { configured: false, note: 'x'.repeat(2048) } }));
  const plan = packet('credentials', { body, chunks: [body.subarray(0, 500), body.subarray(500)] });
  f.queue('credentials', plan);
  assertUnchanged(await f.send('credentials'), plan);
  assert.equal(f.state.phase, 'disabled');
  assertRealCredentialFalse(await f.send('credentials'));
});

test('stream crossing maxBytes without Content-Length is flushed unchanged', TEST_OPTIONS, async (t) => {
  const f = await fixture(t, { maxBytes: 1024 });
  await f.preamble();
  const body = bytes(rpc({ ...clone(CREDENTIALS), padding: { configured: false, note: '界'.repeat(700) } }));
  const plan = packet('credentials', { body, chunks: [body.subarray(0, 700), body.subarray(700, 1400), body.subarray(1400)], yieldChunks: true });
  delete plan.headers['content-length'];
  f.queue('credentials', plan);
  assertUnchanged(await f.send('credentials'), plan);
  assert.equal(f.state.phase, 'disabled');
  assertRealCredentialFalse(await f.send('credentials'));
});

test('duplicate in-flight analytics stage cancels rather than advancing twice', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  const entered = defer();
  const release = defer();
  t.after(() => release.resolve());
  const firstPlan = packet('analytics', { entered, wait: release.promise });
  f.queue('analytics', firstPlan);
  const first = f.send('analytics');
  await entered.promise;
  const duplicatePlan = packet('analytics');
  f.queue('analytics', duplicatePlan);
  assertUnchanged(await f.send('analytics'), duplicatePlan);
  release.resolve();
  assertUnchanged(await first, firstPlan);
  await f.send('settings');
  await f.send('providers');
  assertRealCredentialFalse(await f.send('credentials'));
  assert.equal(f.state.phase, 'disabled');
});

test('two overlapping credentials responses cannot both get a marker', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const entered = defer();
  const release = defer();
  t.after(() => release.resolve());
  const firstPlan = packet('credentials', { entered, wait: release.promise });
  f.queue('credentials', firstPlan);
  const first = f.send('credentials');
  await entered.promise;
  const secondPlan = packet('credentials');
  f.queue('credentials', secondPlan);
  const secondResponse = await f.send('credentials');
  release.resolve();
  const firstResponse = await first;
  assertUnchanged(firstResponse, firstPlan);
  assertUnchanged(secondResponse, secondPlan);
  assert.equal(f.state.phase, 'disabled');
  assertRealCredentialFalse(await f.send('credentials'));
});

test('browser credentials during native in-flight credentials do not count as a duplicate', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const entered = defer();
  const release = defer();
  t.after(() => release.resolve());
  f.queue('credentials', packet('credentials', { entered, wait: release.promise }));
  const native = f.send('credentials');
  await entered.promise;
  const browserPlan = packet('credentials');
  f.queue('credentials', browserPlan);
  assertUnchanged(await f.send('credentials', { headers: { origin: 'http://localhost:16967' } }), browserPlan);
  release.resolve();
  assertSynthetic(await native);
  assert.equal(f.state.phase, 'consumed');
});

test('unload before a request disables rewriting', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  f.state.active = false;
  await f.preamble();
  assertRealCredentialFalse(await f.send('credentials'));
});

test('unload while credentials response is pending prevents modification', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const entered = defer();
  const release = defer();
  t.after(() => release.resolve());
  const plan = packet('credentials', { entered, wait: release.promise });
  f.queue('credentials', plan);
  const pending = f.send('credentials');
  await entered.promise;
  f.state.active = false;
  release.resolve();
  assertUnchanged(await pending, plan);
  assertRealCredentialFalse(await f.send('credentials'));
});

test('unload after the first buffered chunk also prevents modification', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const firstChunk = defer();
  const release = defer();
  t.after(() => release.resolve());
  const body = bytes(rpc(clone(CREDENTIALS)));
  const plan = packet('credentials', {
    body,
    chunks: [body.subarray(0, 23), body.subarray(23)],
    afterFirstWrite: async () => { firstChunk.resolve(); await release.promise; },
  });
  f.queue('credentials', plan);
  const pending = f.send('credentials');
  await firstChunk.promise;
  f.state.active = false;
  release.resolve();
  assertUnchanged(await pending, plan);
});

test('the middleware does not wait for or parse an unfinished request body', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const pending = f.start('credentials', {
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    body: '{this body is deliberately unfinished',
    leaveOpen: true,
  });
  t.after(() => pending.request.destroy());
  // A body-reading middleware would deadlock here until the request timeout.
  assertSynthetic(await pending.response);
  assert.deepEqual(f.bodyReads, [], 'middleware must not subscribe to or consume request-body streams');
  pending.request.destroy();
});

test('downstream rejection cannot leave a usable half-advanced sequence', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  f.queue('credentials', packet('credentials', { throwBeforeWrite: true }));
  const response = await f.send('credentials');
  assert.equal(response.status, 500);
  assert.equal(response.body.toString(), 'downstream failed');
  assertRealCredentialFalse(await f.send('credentials'));
  assert.equal(f.state.phase, 'disabled');
});

test('client disconnect during a pending response cannot enable a later rewrite', TEST_OPTIONS, async (t) => {
  const f = await fixture(t);
  await f.preamble();
  const firstChunk = defer();
  const release = defer();
  const closed = defer();
  t.after(() => release.resolve());
  f.queue('credentials', packet('credentials', {
    beforeWrite: (_req, res) => { res.once('close', () => closed.resolve()); },
    afterFirstWrite: async () => { firstChunk.resolve(); await release.promise; },
  }));
  const pending = f.start('credentials');
  const rejected = assert.rejects(pending.response);
  await firstChunk.promise;
  pending.request.destroy(new Error('deliberate client disconnect'));
  await rejected;
  // A socket-close event, not a sleep, orders the abort before the next request.
  await closed.promise;
  release.resolve();
  assertRealCredentialFalse(await f.send('credentials'));
  assert.equal(f.state.phase, 'disabled');
});
