import { createHash } from 'node:crypto';

export const MARKER = '__local_dsh_startup_skip__';
const PATHS = [
  '/api/productAnalytics/enabled',
  '/api/settings/describe',
  '/api/llm/listConfigurableProviders',
  '/api/credentials/describe',
];
const PHASES = ['waiting-preamble', 'waiting-settings', 'waiting-providers', 'waiting-credentials'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createState() {
  return { active: true, phase: PHASES[0], reason: null, identity: null, startedAt: null, busy: null };
}

// This is a startup heuristic, never an authentication decision. Connection has
// already admitted the request before this middleware is invoked.
function nativeIdentity(req) {
  const headers = req.headers;
  const address = req.socket?.remoteAddress;
  if (req.method !== 'POST' || headers.origin !== undefined || headers.referer !== undefined) return null;
  if (!(address === '::1' || /^127\./.test(address ?? '') || /^::ffff:127\./.test(address ?? ''))) return null;
  if (typeof headers.cookie !== 'string' || headers.cookie.length === 0) return null;
  if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) return null;
  return createHash('sha256').update(headers.cookie).update('\0').update(String(headers['user-agent'] ?? '')).digest('hex');
}

function envelopeValue(buffer) {
  const message = JSON.parse(buffer.toString('utf8'));
  if (!object(message) || message.type !== 'server-response' || typeof message.rpcId !== 'string' ||
      !object(message.result) || message.result.ok !== true || !Object.hasOwn(message.result, 'value')) {
    throw new Error('unexpected-envelope');
  }
  return message;
}

function validValue(stage, value) {
  if (stage === 0) return typeof value === 'boolean';
  if (stage === 1) return object(value) && Array.isArray(value.namespaces) && value.namespaces.some(ns =>
    object(ns) && ns.ns === 'llm-deepseek' && object(ns.value) &&
    typeof ns.value.apiKeyEnv === 'string' && ns.value.apiKeyEnv.length > 0);
  if (stage === 2) return Array.isArray(value) && value.every(provider => object(provider) &&
    typeof provider.settingsNs === 'string' && Array.isArray(provider.settingsPath) &&
    provider.settingsPath.every(key => typeof key === 'string'));
  return object(value) && Object.keys(value).length > 0 && !Object.hasOwn(value, MARKER) &&
    Object.values(value).every(info => object(info) && typeof info.configured === 'boolean' &&
      typeof info.writable === 'boolean' && (info.source === undefined || typeof info.source === 'string'));
}

/**
 * Buffer only a small, explicitly selected JSON response from the stock HTTP
 * bridge. Unknown encodings/statuses and over-limit responses pass unchanged.
 * No request bytes are read, no route is replaced, and no credential is stored.
 */
function captureJson(res, { maxBytes, transform, commit, reject }) {
  const names = ['writeHead', 'write', 'end', 'flushHeaders'];
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(res, name)]));
  const original = Object.fromEntries(names.map(name => [name, res[name]]));
  let parts = [];
  let size = 0;
  let callbacks = [];
  let buffering = true;
  let ended = false;
  let restored = false;
  let headSeen = false;

  function restore() {
    if (restored) return;
    restored = true;
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(res, name, descriptor);
      else delete res[name];
    }
  }
  function callbackAll(error) {
    const pending = callbacks;
    callbacks = [];
    for (const callback of pending) callback(error);
  }
  function onClose() {
    if (!ended) {
      reject('connection-closed');
      callbackAll(new Error('response closed before completion'));
    }
    restore();
  }
  res.once('close', onClose);

  function flushOriginal(reason) {
    if (!buffering) return true;
    buffering = false;
    reject(reason);
    restore();
    let writable = true;
    if (parts.length) {
      const bytes = Buffer.concat(parts, size);
      parts = [];
      size = 0;
      const pending = callbacks;
      callbacks = [];
      let settled = false;
      const settle = error => {
        if (settled) return;
        settled = true;
        for (const callback of pending) callback(error);
      };
      try { writable = original.write.call(res, bytes, settle); }
      catch (error) { settle(error); throw error; }
    }
    return writable;
  }
  function headersOkay() {
    return res.statusCode === 200 &&
      /^application\/json(?:\s*;|$)/i.test(String(res.getHeader('content-type') ?? '')) &&
      !res.getHeader('content-encoding') && !res.getHeader('content-range') &&
      !res.hasHeader('trailer');
  }
  function addHeaders(headers) {
    if (Array.isArray(headers)) {
      if (headers.length % 2) throw new TypeError('invalid raw response headers');
      const grouped = new Map();
      for (let i = 0; i < headers.length; i += 2) {
        const name = String(headers[i]).toLowerCase();
        const values = grouped.get(name) ?? [];
        values.push(headers[i + 1]);
        grouped.set(name, values);
      }
      for (const [name, values] of grouped) res.setHeader(name, values.length === 1 ? values[0] : values);
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    }
  }

  res.writeHead = function (status, message, headers) {
    if (!buffering) return original.writeHead.apply(this, arguments);
    if (headSeen || res.headersSent) {
      flushOriginal('unexpected-header-write');
      return original.writeHead.apply(this, arguments);
    }
    headSeen = true;
    res.statusCode = status;
    if (typeof message === 'string') {
      res.statusMessage = message;
      addHeaders(headers);
    } else addHeaders(message);
    if (!headersOkay()) {
      flushOriginal('unsupported-response');
      return original.writeHead.call(res, res.statusCode, res.statusMessage);
    }
    return res;
  };
  res.write = function (chunk, encoding, callback) {
    if (!buffering) return original.write.apply(this, arguments);
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (callback !== undefined && typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) throw new TypeError('chunk must be a string or byte view');
    if (!headSeen || !headersOkay()) {
      flushOriginal('unexpected-response-writer');
      return original.write.call(res, chunk, encoding, callback);
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) :
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (size + bytes.byteLength > maxBytes) {
      const previousWritable = flushOriginal('response-too-large');
      return original.write.call(res, bytes, callback) && previousWritable;
    }
    parts.push(bytes);
    size += bytes.byteLength;
    if (callback) callbacks.push(callback);
    return true; // bounded buffering; the stock bridge does not await callbacks
  };
  res.flushHeaders = function () {
    flushOriginal('early-header-flush');
    return original.flushHeaders.call(res);
  };
  res.end = function (chunk, encoding, callback) {
    if (!buffering) return original.end.apply(this, arguments);
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; encoding = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (callback !== undefined && typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (chunk !== undefined && chunk !== null) res.write(chunk, encoding);
    if (!buffering) return original.end.call(res, callback);
    ended = true;
    let bytes = Buffer.concat(parts, size);
    parts = [];
    try {
      if (!headSeen || !headersOkay()) reject('unsupported-response');
      else {
        const changed = transform(bytes);
        if (changed) {
          bytes = changed;
          res.removeHeader('content-length');
          res.removeHeader('etag');
          res.removeHeader('content-md5');
          res.removeHeader('digest');
        }
      }
    } catch {
      reject('unexpected-response-body'); // never log payloads or credentials
    }
    restore();
    let settled = false;
    const settle = error => {
      if (settled) return;
      settled = true;
      callbackAll(error);
      if (callback) callback(error);
    };
    try {
      const result = original.end.call(res, bytes, settle);
      commit(); // commit only after the original end accepts the response
      return result;
    } catch (error) {
      reject('response-send-error');
      settle(error);
      throw error;
    }
  };

  return {
    dispose() {
      try {
        if (!ended && buffering && !res.destroyed) flushOriginal('incomplete-response');
      } finally {
        restore();
        res.off('close', onClose);
        if (res.destroyed && !ended) callbackAll(new Error('response destroyed'));
      }
    },
  };
}

export function createMiddleware({ state, now = Date.now, maxBytes = 262144, log = () => {} }) {
  const disable = reason => {
    if (state.phase === 'consumed' || state.phase === 'disabled') return;
    state.phase = 'disabled';
    state.reason = reason;
    state.busy = null;
    log('disabled', reason);
  };
  return async (req, res, next) => {
    if (!state.active || state.phase === 'consumed' || state.phase === 'disabled') return next();
    const identity = nativeIdentity(req);
    if (identity === null) return next();
    const stage = PATHS.indexOf(req.url);
    if (stage < 0) return next();
    if (state.phase === PHASES[0] && stage !== 0) return next();
    if (state.startedAt !== null && now() - state.startedAt > 30000) {
      disable('startup-window-expired');
      return next();
    }
    if (state.busy || state.phase !== PHASES[stage] || (state.identity && state.identity !== identity)) {
      disable('ambiguous-startup-sequence');
      return next();
    }
    if (stage === 0) {
      state.identity = identity;
      state.startedAt = now();
    }
    const ticket = {};
    state.busy = ticket;
    let completed = false;
    let accepted = false;
    let finalReason;
    const capture = captureJson(res, {
      maxBytes,
      reject: disable,
      commit() {
        if (!accepted || !state.active || state.busy !== ticket || state.phase !== PHASES[stage]) return;
        completed = true;
        state.busy = null;
        if (stage < 3) state.phase = PHASES[stage + 1];
        else {
          state.phase = 'consumed';
          state.reason = finalReason;
          log('consumed', state.reason);
        }
      },
      transform(bytes) {
        if (!state.active || state.busy !== ticket || state.phase !== PHASES[stage]) {
          disable('adaptation-cancelled');
          return null;
        }
        const message = envelopeValue(bytes);
        const value = message.result.value;
        if (!validValue(stage, value)) throw new Error('unexpected-value');
        accepted = true;
        if (stage < 3) return null;
        const present = Object.values(value).some(info => info.configured === true);
        finalReason = present ? 'real-credential-already-configured' : 'startup-check-adapted';
        if (present) return null;
        message.result.value = { ...value, [MARKER]: {
          configured: true, writable: false, source: 'local-startup-policy',
        } };
        return Buffer.from(JSON.stringify(message));
      },
    });
    let downstreamError;
    try {
      await next();
    } catch (error) {
      downstreamError = error;
      disable('downstream-error');
      throw error;
    } finally {
      try { capture.dispose(); }
      catch (error) { if (!downstreamError) throw error; }
      finally { if (!completed) disable('incomplete-startup-stage'); }
    }
  };
}
