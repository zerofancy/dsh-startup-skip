import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createState, createMiddleware } from '../core.js';

// Narrow regression probes for response-wrapper behavior. No real credentials,
// profile mutation, subprocesses, wall-clock waits, or non-built-in dependencies.
const PATHS = [
  '/api/productAnalytics/enabled',
  '/api/settings/describe',
  '/api/llm/listConfigurableProviders',
  '/api/credentials/describe',
];
const VALUES = [
  false,
  { namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }] },
  [],
  { DEEPSEEK_API_KEY: { configured: false, writable: true } },
];
const METHODS = ['writeHead', 'write', 'end', 'flushHeaders'];
const encoded = (stage) => Buffer.from(JSON.stringify({
  type: 'server-response', rpcId: 'test-id', result: { ok: true, value: VALUES[stage] },
}));

function request(stage, headers = {}) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = PATHS[stage];
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = {
    cookie: 'test-session=not-a-real-credential',
    'user-agent': 'edge-regression-native',
    'content-type': 'application/json',
    ...headers,
  };
  return req;
}

class FakeResponse extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this.destroyed = false;
    this.headers = new Map();
    this.chunks = [];
    this.calls = [];
  }
  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
    return this;
  }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
  hasHeader(name) { return this.headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this.headers.delete(String(name).toLowerCase()); }
  writeHead(status, message, headers) {
    this.calls.push(['writeHead', status, message, headers]);
    this.statusCode = status;
    if (typeof message === 'string') this.statusMessage = message;
    else headers = message;
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
    } else if (headers) {
      for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    }
    this.headersSent = true;
    return this;
  }
  write(chunk, encoding, callback) {
    this.calls.push(['write']);
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (this.options.writeError) throw this.options.writeError;
    this.headersSent = true;
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    callback?.();
    return this.options.writeResult ?? true;
  }
  end(chunk, encoding, callback) {
    this.calls.push(['end']);
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (this.options.endError) throw this.options.endError;
    this.headersSent = true;
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    }
    this.writableEnded = true;
    callback?.();
    return this;
  }
  flushHeaders() {
    this.calls.push(['flushHeaders']);
    if (this.options.flushError) throw this.options.flushError;
    this.headersSent = true;
  }
  get body() { return Buffer.concat(this.chunks); }
}

function snapshotMethods(res) {
  return METHODS.map((name) => ({
    name,
    method: res[name],
    descriptor: Object.getOwnPropertyDescriptor(res, name),
  }));
}
function assertRestored(res, snapshot) {
  for (const { name, method, descriptor } of snapshot) {
    assert.strictEqual(res[name], method, `${name} original function restored`);
    assert.deepEqual(Object.getOwnPropertyDescriptor(res, name), descriptor, `${name} own-property descriptor restored`);
  }
  assert.equal(res.listenerCount('close'), 0, 'capture close listener is removed');
}
function writePacket(res, stage) {
  const body = encoded(stage);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.write(body);
  return res.end();
}
function fixture(options = {}) {
  const state = createState();
  const middleware = createMiddleware({ state, ...options });
  async function run(stage, { res = new FakeResponse(), headers, next } = {}) {
    await middleware(request(stage, headers), res, next ?? (() => writePacket(res, stage)));
    return res;
  }
  async function preamble() {
    for (let stage = 0; stage < 3; stage++) await run(stage);
    assert.equal(state.phase, 'waiting-credentials');
  }
  return { state, middleware, run, preamble };
}
function assertPlain(res, stage = 3) {
  assert.deepEqual(res.body, encoded(stage));
}
function assertAdapted(res) {
  const value = JSON.parse(res.body.toString('utf8')).result.value;
  assert.deepEqual(value.DEEPSEEK_API_KEY, VALUES[3].DEEPSEEK_API_KEY);
  const extras = Object.entries(value).filter(([key]) => !Object.hasOwn(VALUES[3], key));
  assert.ok(extras.some(([, info]) => info?.configured === true), 'a separate marker is appended');
}

test('raw end synchronous throw disables instead of consuming and settles pending callbacks', async () => {
  const f = fixture();
  await f.preamble();
  const failure = new Error('raw end refused response');
  const res = new FakeResponse({ endError: failure });
  const before = snapshotMethods(res);
  const writes = [];
  const ends = [];
  await assert.rejects(f.run(3, { res, next() {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(encoded(3), (error) => writes.push(error));
    res.end((error) => ends.push(error));
  } }), (error) => error === failure);
  assert.equal(f.state.phase, 'disabled');
  assert.notEqual(f.state.phase, 'consumed');
  assert.deepEqual(writes, [failure]);
  assert.deepEqual(ends, [failure]);
  assertRestored(res, before);
  assertPlain(await f.run(3));
});

for (const [label, callback] of [['number', 123], ['object', {}], ['null', null], ['string', 'not-a-function']]) {
  test(`write rejects ${label} callback synchronously without buffering the rejected chunk`, async () => {
    const f = fixture();
    await f.preamble();
    const res = new FakeResponse();
    const before = snapshotMethods(res);
    await f.run(3, { res, next() {
      res.writeHead(200, { 'content-type': 'application/json' });
      assert.throws(() => res.write(Buffer.from('must-not-appear'), 'utf8', callback), TypeError);
      res.write(encoded(3));
      res.end();
    } });
    assertAdapted(res);
    assertRestored(res, before);
  });
}

for (const [label, makeChunk] of [
  ['raw ArrayBuffer', () => new ArrayBuffer(8)],
  ['number array', () => [123, 125]],
]) {
  test(`write rejects ${label} synchronously; a following valid write still works`, async () => {
    const f = fixture();
    await f.preamble();
    const res = new FakeResponse();
    await f.run(3, { res, next() {
      res.writeHead(200, { 'content-type': 'application/json' });
      assert.throws(() => res.write(makeChunk()), TypeError);
      res.write(encoded(3));
      res.end();
    } });
    assertAdapted(res);
  });
}

test('ArrayBuffer views honor byteOffset/byteLength, including DataView and Uint8Array', async () => {
  const f = fixture();
  await f.preamble();
  const body = encoded(3);
  const backing = new Uint8Array(body.length + 12);
  backing.fill(0xff);
  backing.set(body, 5);
  const split = 29;
  const res = new FakeResponse();
  await f.run(3, { res, next() {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(new DataView(backing.buffer, 5, split));
    res.end(new Uint8Array(backing.buffer, 5 + split, body.length - split));
  } });
  assertAdapted(res);
  assert.equal(f.state.phase, 'consumed');
});

test('raw write throw during size-limit flush settles earlier callbacks exactly once and restores methods', async () => {
  const f = fixture({ maxBytes: 512 });
  await f.preamble();
  const failure = new Error('raw flush write failed');
  const res = new FakeResponse({ writeError: failure });
  const before = snapshotMethods(res);
  const callbackErrors = [];
  await assert.rejects(f.run(3, { res, next() {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(Buffer.from('first'), (error) => callbackErrors.push(['first', error]));
    res.write(Buffer.from('second'), (error) => callbackErrors.push(['second', error]));
    res.write(Buffer.alloc(600));
  } }), (error) => error === failure);
  assert.deepEqual(callbackErrors, [['first', failure], ['second', failure]]);
  assert.equal(f.state.phase, 'disabled');
  assertRestored(res, before);
  res.emit('close');
  assert.equal(callbackErrors.length, 2, 'no second settlement on a subsequent close');
});

test('startup older than 30 seconds passes credentials unchanged and disables', async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock });
  await f.preamble();
  clock += 30001;
  assertPlain(await f.run(3));
  assert.equal(f.state.phase, 'disabled');
  assertPlain(await f.run(3));
});

test('exactly 30 seconds remains inside the startup window', async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock });
  await f.preamble();
  clock += 30000;
  assertAdapted(await f.run(3));
  assert.equal(f.state.phase, 'consumed');
});

for (const [label, headers] of [
  ['cookie', { cookie: 'test-session=another-not-real-credential' }],
  ['user-agent', { 'user-agent': 'another-native-client' }],
]) {
  test(`${label} identity change disables rather than joining startup sessions`, async () => {
    const f = fixture();
    await f.run(0);
    assertPlain(await f.run(1, { headers }), 1);
    assert.equal(f.state.phase, 'disabled');
    await f.run(2);
    assertPlain(await f.run(3));
  });
}

test('writeHead raw header array and statusMessage survive capture and duplicate headers remain grouped', async () => {
  const f = fixture();
  await f.preamble();
  const res = new FakeResponse();
  const before = snapshotMethods(res);
  await f.run(3, { res, next() {
    res.writeHead(200, 'Startup OK', [
      'Content-Type', 'application/json; charset=utf-8',
      'Content-Length', String(encoded(3).length),
      'X-Test', 'first',
      'X-Test', 'second',
    ]);
    res.write(encoded(3));
    res.end();
  } });
  assertAdapted(res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.statusMessage, 'Startup OK');
  assert.equal(res.getHeader('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(res.getHeader('x-test'), ['first', 'second']);
  assert.equal(res.getHeader('content-length'), undefined, 'old framing length is removed after adaptation');
  assertRestored(res, before);
});

test('flushHeaders forwards buffered bytes unchanged, calls the real flush, and disables adaptation', async () => {
  const f = fixture();
  await f.preamble();
  const res = new FakeResponse();
  const before = snapshotMethods(res);
  const callbackErrors = [];
  const body = encoded(3);
  await f.run(3, { res, next() {
    res.writeHead(200, 'Startup OK', { 'content-type': 'application/json', 'content-length': String(body.length) });
    res.write(body.subarray(0, 23), (error) => callbackErrors.push(error));
    res.flushHeaders();
    res.write(body.subarray(23));
    res.end();
  } });
  assertPlain(res);
  assert.equal(f.state.phase, 'disabled');
  assert.deepEqual(callbackErrors, [undefined]);
  assert.equal(res.calls.filter(([name]) => name === 'flushHeaders').length, 1);
  assert.equal(res.getHeader('content-length'), String(body.length));
  assertRestored(res, before);
});

test('raw flushHeaders throw still restores methods and preserves the thrown error', async () => {
  const f = fixture();
  await f.preamble();
  const failure = new Error('raw flushHeaders failed');
  const res = new FakeResponse({ flushError: failure });
  const before = snapshotMethods(res);
  await assert.rejects(f.run(3, { res, next() {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(encoded(3));
    res.flushHeaders();
  } }), (error) => error === failure);
  assert.equal(f.state.phase, 'disabled');
  assertRestored(res, before);
});

test('downstream error is not replaced by a secondary dispose/flush error', async () => {
  const f = fixture();
  await f.preamble();
  const primary = new Error('primary downstream failure');
  const secondary = new Error('secondary dispose flush failure');
  const res = new FakeResponse({ writeError: secondary });
  const before = snapshotMethods(res);
  const callbackErrors = [];
  await assert.rejects(f.run(3, { res, next() {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(encoded(3), (error) => callbackErrors.push(error));
    throw primary;
  } }), (error) => error === primary);
  assert.deepEqual(callbackErrors, [secondary]);
  assert.equal(f.state.phase, 'disabled');
  assertRestored(res, before);
  assertPlain(await f.run(3));
});

test('cleanup restores a pre-existing own response method descriptor, not merely its function', async () => {
  const f = fixture();
  await f.preamble();
  const res = new FakeResponse();
  Object.defineProperty(res, 'write', {
    value: FakeResponse.prototype.write,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  const before = snapshotMethods(res);
  await f.run(3, { res });
  assertAdapted(res);
  assertRestored(res, before);
});
