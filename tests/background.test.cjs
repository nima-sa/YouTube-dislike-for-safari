const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const { createBackground, solvePuzzle, parseStats, videoFromURL, KEY, TTL } = require('../YouTube Dislike Extension/Resources/background.js');
const A = 'YLUD8tKK5yM', B = 'Ab5EIsr6_xc';
const puzzle = { challenge: 'AAAAAAAAAAAAAAAAAAAAAA==', difficulty: 0 };
const response = (json = true, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] }, json: async () => json });
const copy = x => JSON.parse(JSON.stringify(x));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error('condition not reached'); }
function harness({ stored, fetcher, time = 1000000, failStorage = false } = {}) {
  const disk = stored || {};
  const calls = [], writes = [], alarms = new Map(), timers = new Map(), listeners = {};
  let timerId = 0;
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const api = {
    runtime: { id: 'our-extension', getURL: p => `safari-web-extension://test/${p}`, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
    storage: { local: {
      get: async () => copy(disk),
      set: async data => { if (failStorage) throw new Error('disk full'); Object.assign(disk, copy(data)); writes.push(copy(data)); },
    } },
    alarms: { create: async (name, options) => alarms.set(name, options), clear: async name => alarms.delete(name), onAlarm: event('alarm') },
  };
  const bg = createBackground(api, {
    crypto: webcrypto, now: () => time,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      const call = { url, ...options, body: options.body && JSON.parse(options.body) }; calls.push(call);
      assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
      if (fetcher) return fetcher(call, disk);
      return response(url.includes('/puzzle/') && options.method === 'GET' || url.endsWith('/interact/vote') ? puzzle : true);
    },
  });
  const sender = (id = A, tab = 1) => ({ id: api.runtime.id, frameId: 0, tab: { id: tab }, url: `https://www.youtube.com/watch?v=${id}` });
  const popup = { id: api.runtime.id, url: api.runtime.getURL('popup.html') };
  return { api, bg, disk, calls, writes, alarms, timers, listeners, sender, popup,
    advance: ms => { time += ms; },
    vote: (value = -1, id = A, tab = 1) => bg.onMessage({ version: 1, type: 'ryd.vote', videoId: id, value }, sender(id, tab)),
    configure: enabled => bg.onMessage({ version: 1, type: 'ryd.configure', enabled }, popup),
    status: () => bg.onMessage({ version: 1, type: 'ryd.status' }, popup),
  };
}
const votes = env => env.calls.filter(c => c.url.endsWith('/interact/vote'));
const confirms = env => env.calls.filter(c => c.url.endsWith('/interact/confirmVote'));

test('SHA-512 solution has the expected leading zero bits and little-endian nonce', async () => {
  const challenge = { ...puzzle, difficulty: 8 };
  const solved = await solvePuzzle(challenge, webcrypto);
  const nonce = Buffer.from(solved.solution, 'base64');
  assert.equal(nonce.length, 4);
  const digest = createHash('sha512').update(Buffer.concat([nonce, Buffer.alloc(16)])).digest();
  assert.equal(digest[0], 0);
  assert.equal(nonce.readUInt32LE(), 151);
});
test('challenge rejects bad input and enforces both time and attempt budgets', async () => {
  for (const bad of [null, {}, { ...puzzle, difficulty: -1 }, { ...puzzle, difficulty: 25 }, { ...puzzle, challenge: 'x' }]) {
    await assert.rejects(solvePuzzle(bad, webcrypto), /invalid-challenge/);
  }
  const never = { subtle: { digest: async () => new Uint8Array(64).fill(255).buffer } };
  await assert.rejects(solvePuzzle({ ...puzzle, difficulty: 8 }, never, { maxAttempts: 2 }), /challenge-limit/);
  let clock = 0;
  await assert.rejects(solvePuzzle(puzzle, never, { now: () => clock += 1000, maxMs: 2000 }), /challenge-limit/);
});
test('full lazy registration and vote confirmation persist before networking', async () => {
  let env;
  env = harness({ fetcher: async (call, disk) => {
    const current = disk[KEY].queue[A]?.current;
    assert.ok(current, 'the current vote must be durable before requests');
    assert.ok(current.attempts > 0);
    assert.match(disk[KEY].userId, /^[A-Za-z0-9]{36}$/);
    return response(call.method === 'GET' || call.url.endsWith('/interact/vote') ? puzzle : true);
  } });
  await env.bg.idle(); assert.equal(env.calls.length, 0); assert.equal(env.disk[KEY].userId, null);
  assert.equal((await env.vote()).status, 'queued'); await env.bg.idle();
  assert.equal(env.calls.length, 4); assert.equal(env.disk[KEY].registered, true);
  assert.deepEqual(Object.keys(votes(env)[0].body).sort(), ['userId', 'value', 'videoId']);
  assert.deepEqual(Object.keys(confirms(env)[0].body).sort(), ['solution', 'userId', 'videoId']);
  assert.equal(env.disk[KEY].lastDelivery.status, 'delivered'); assert.deepEqual(env.disk[KEY].queue, {});
  assert.equal(env.alarms.size, 0);
});
test('HTTP success alone is not delivery: both confirmations must be boolean true', async () => {
  for (const registration of [true, false]) {
    const env = harness({ fetcher: async c => response(c.method === 'GET' || c.url.endsWith('/interact/vote') ? puzzle :
      c.url.includes('/puzzle/') ? registration : { success: true }) });
    await env.bg.idle(); await env.vote(); await env.bg.idle();
    assert.equal(env.disk[KEY].lastDelivery.status, 'failed');
    assert.equal(votes(env).length, registration ? 1 : 0);
  }
});
test('parallel tabs register once, serialize active votes and coalesce unstarted changes', async () => {
  let release;
  const env = harness({ fetcher: async c => {
    if (c.url.endsWith('/interact/confirmVote') && !release) return new Promise(resolve => { release = () => resolve(response()); });
    return response(c.method === 'GET' || c.url.endsWith('/interact/vote') ? puzzle : true);
  } });
  await env.bg.idle(); await env.vote(1); await until(() => release);
  await Promise.all([env.vote(-1, A, 2), env.vote(1, A, 3), env.vote(0, A, 4), env.vote(-1, B, 5)]);
  assert.equal(votes(env).length, 1); assert.equal(env.disk[KEY].queue[A].next.value, 0);
  release(); await env.bg.idle();
  assert.deepEqual(votes(env).map(c => [c.body.videoId, c.body.value]), [[A, 1], [A, 0], [B, -1]]);
  assert.equal(env.calls.filter(c => c.url.includes('/puzzle/') && c.method === 'GET').length, 1);
});
test('restores queued and in-flight work after background loss with bounded attempts', async () => {
  const old = harness({ fetcher: () => new Promise(() => {}) });
  await old.bg.idle(); await old.vote(1); await until(() => old.calls.length === 1);
  await old.vote(0);
  const restored = harness({ stored: copy(old.disk) }); await restored.bg.idle();
  assert.deepEqual(votes(restored).map(c => c.body.value), [1, 0]);
  assert.equal(restored.disk[KEY].lastDelivery.status, 'delivered'); assert.deepEqual(restored.disk[KEY].queue, {});
  assert.ok(restored.writes.some(w => w[KEY].queue[A]?.current?.attempts === 2));
});
test('turning off aborts in-flight HTTP, clears waiting jobs and survives restart', async () => {
  let signal;
  const env = harness({ fetcher: c => new Promise((_, reject) => {
    signal = c.signal; signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  await env.bg.idle(); await env.vote(); await until(() => signal); await env.vote(1, B);
  assert.equal((await env.configure(false)).enabled, false); await env.bg.idle();
  assert.equal(signal.aborted, true); assert.deepEqual(env.disk[KEY].queue, {}); assert.equal(env.alarms.size, 0);
  assert.equal((await env.vote()).error, 'disabled'); await env.bg.idle(); assert.equal(env.calls.length, 1);
  const restored = harness({ stored: copy(env.disk) }); await restored.bg.idle(); assert.equal(restored.calls.length, 0);
  await restored.configure(true); await restored.vote(0); await restored.bg.idle(); assert.equal(votes(restored)[0].body.value, 0);
});
test('a late response after disabling cannot confirm the vote', async () => {
  let resolve;
  const env = harness({ fetcher: () => new Promise(r => { resolve = r; }) });
  await env.bg.idle(); await env.vote(); await until(() => resolve); await env.configure(false);
  resolve(response(puzzle)); await env.bg.idle();
  assert.equal(env.calls.length, 1); assert.equal(env.disk[KEY].lastDelivery, null);
});
test('ten-second HTTP timeout schedules at most three exponential retries', async () => {
  const env = harness({ fetcher: c => new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(new Error('timeout')))) });
  await env.bg.idle(); await env.vote();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await until(() => env.timers.size === 1);
    const timer = [...env.timers.values()][0]; assert.equal(timer.delay, 10000); timer.fn(); await env.bg.idle();
    if (attempt < 4) {
      assert.equal(env.disk[KEY].queue[A].current.attempts, attempt);
      env.advance(5000 * 2 ** (attempt - 1)); env.listeners.alarm({ name: 'ryd-queue' });
    }
  }
  assert.equal(env.calls.length, 4); assert.equal(env.disk[KEY].lastFailure.reason, 'timeout');
});
test('401 permits exactly one durable re-registration for vote or confirmation', async () => {
  for (const endpoint of ['/interact/vote', '/interact/confirmVote']) {
    const env = harness({ fetcher: async c => c.url.endsWith(endpoint) ? response(null, 401) :
      response(c.method === 'GET' || c.url.endsWith('/interact/vote') ? puzzle : true) });
    await env.bg.idle(); await env.vote(); await env.bg.idle();
    assert.equal(env.calls.filter(c => c.url.includes('/puzzle/') && c.method === 'GET').length, 2);
    assert.equal(env.disk[KEY].lastFailure.reason, 'http-401');
  }
});
test('429 honors seconds and HTTP-date Retry-After across restart and other videos', async () => {
  for (const header of ['120', new Date(1120000).toUTCString()]) {
    const env = harness({ fetcher: async () => response(null, 429, { 'Retry-After': header }) });
    await env.bg.idle(); await env.vote(); await env.bg.idle(); await env.vote(-1, B); await env.bg.idle();
    assert.equal(env.calls.length, 1);
    const restored = harness({ stored: copy(env.disk) }); await restored.bg.idle(); assert.equal(restored.calls.length, 0);
    restored.advance(119000); await restored.bg.wake(); assert.equal(restored.calls.length, 0);
    restored.advance(1000); await restored.bg.wake(); assert.equal(votes(restored).length, 2);
  }
});
test('expired jobs become visible failures and the queue holds at most 100 videos', async () => {
  const env = harness({ fetcher: async () => response(null, 503) }); await env.bg.idle();
  for (let i = 0; i < 101; i++) await env.vote(1, String(i).padStart(11, '0'));
  await env.bg.idle(); assert.equal(Object.keys(env.disk[KEY].queue).length, 100);
  assert.equal(env.disk[KEY].lastFailure.reason, 'queue-full');
  env.advance(TTL); await env.bg.wake();
  assert.deepEqual(env.disk[KEY].queue, {}); assert.equal((await env.status()).lastFailure.reason, 'expired');
});
test('rejects foreign senders, bad IDs/values, frames and page settings mutations', async () => {
  const env = harness(); await env.bg.idle();
  const valid = { version: 1, type: 'ryd.vote', videoId: A, value: 1 };
  for (const sender of [{}, { ...env.sender(), id: 'other' }, { ...env.sender(), frameId: 1 },
    { ...env.sender(), url: 'https://youtube.com.evil.test/watch?v=' + A }, { ...env.sender(), url: 'https://music.youtube.com/watch?v=' + A },
    { ...env.sender(), url: 'https://www.youtube.com/watch?v=' + B }, env.popup]) {
    assert.equal((await env.bg.onMessage(valid, sender)).ok, false);
  }
  for (const value of [2, '1', null, {}, NaN]) assert.equal((await env.vote(value)).ok, false);
  assert.equal((await env.bg.onMessage({ version: 1, type: 'ryd.configure', enabled: false }, env.sender())).ok, false);
  assert.equal(env.calls.length, 0);
});
test('storage failure prevents all vote requests', async () => {
  const env = harness({ failStorage: true }); await env.bg.idle().catch(() => {});
  assert.equal((await env.vote()).ok, false); assert.equal(env.calls.length, 0);
});
test('statistics validate IDs, errors, zero and unsafe responses centrally', async () => {
  for (const json of [null, [], {}, { traceId: 'error', dislikes: 2 }, { id: B, dislikes: 1 }, { dislikes: -1 }, { dislikes: '1' }, { dislikes: Infinity }, { dislikes: 1.5 }, { dislikes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => parseStats(json, A), /invalid-response/);
  }
  assert.deepEqual(parseStats({ id: A, dislikes: 0 }, A), { dislikes: 0 });
  assert.equal(videoFromURL(`https://m.youtube.com/shorts/${A}`), A);
  assert.equal(videoFromURL('https://www.youtube.com/watch?v=invalid'), null);
  const env = harness({ fetcher: async () => response({ id: A, dislikes: 0 }) }); await env.bg.idle();
  const result = await env.bg.onMessage({ version: 1, type: 'ryd.stats', videoId: A }, env.sender());
  assert.deepEqual(result.stats, { dislikes: 0 }); assert.equal(env.disk[KEY].registered, false);
});

test('popup statistics uses active tab, rejects foreign senders and never submits a vote', async () => {
  const env = harness({ fetcher: async () => response({ id: A, likes: 0, dislikes: 0 }) });
  await env.bg.idle();
  env.api.tabs = { query: async () => [{ id: 3, url: `https://www.youtube.com/watch?v=${A}` }] };
  const message = { version: 1, type: 'ryd.activeStats', videoId: B };
  assert.equal((await env.bg.onMessage(message, env.sender())).error, 'invalid-sender');
  assert.equal(env.calls.length, 0);
  const result = await env.bg.onMessage(message, env.popup);
  assert.deepEqual(result, { ok: true, videoId: A, stats: { likes: 0, dislikes: 0 } });
  assert.equal(env.calls.length, 1);
  assert.ok(env.calls[0].url.endsWith(A));
  assert.equal(votes(env).length, 0);
  env.api.tabs.query = async () => [{ id: 3, url: 'https://example.com/' }];
  assert.equal((await env.bg.onMessage(message, env.popup)).error, 'no-video');
  assert.equal(env.calls.length, 1);
});
test('popup statistics discards responses after active video changes', async () => {
  const env = harness({ fetcher: async () => response({ likes: 2, dislikes: 1 }) });
  let count = 0;
  env.api.tabs = { query: async () => [{ id: 3, url: `https://www.youtube.com/watch?v=${++count === 1 ? A : B}` }] };
  const result = await env.bg.onMessage({ version: 1, type: 'ryd.activeStats' }, env.popup);
  assert.equal(result.error, 'video-changed');
});
