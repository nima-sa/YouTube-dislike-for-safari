// Protocol: https://github.com/Anarios/return-youtube-dislike
"use strict";
const RYD = (() => {
  const API = 'https://returnyoutubedislikeapi.com';
  const KEY = 'rydState';
  const ALARM = 'ryd-queue';
  const TTL = 24 * 60 * 60 * 1000;
  const VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const validVote = v => v === -1 || v === 0 || v === 1;
  const clone = v => JSON.parse(JSON.stringify(v));
  class Failure extends Error {
    constructor(code, retryable = false, retryAt = 0, status = 0) {
      super(code);
      Object.assign(this, { code, retryable, retryAt, status });
    }
  }
  function videoFromURL(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password ||
          !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
      const id = url.pathname === '/watch' ? url.searchParams.get('v') :
        /^\/shorts\/[^/]+\/?$/.test(url.pathname) ? url.pathname.split('/')[2] : null;
      return typeof id === 'string' && VIDEO.test(id) ? id : null;
    } catch { return null; }
  }
  function parseStats(json, id) {
    if (!json || typeof json !== 'object' || Array.isArray(json) || 'traceId' in json ||
        (json.id !== undefined && json.id !== id) || !Number.isSafeInteger(json.dislikes) || json.dislikes < 0) {
      throw new Failure('invalid-response');
    }
    if (json.likes !== undefined && (!Number.isSafeInteger(json.likes) || json.likes < 0)) throw new Failure('invalid-response');
    return { dislikes: json.dislikes, ...(json.likes === undefined ? {} : { likes: json.likes }) };
  }
  async function solvePuzzle(puzzle, cryptoImpl, { now = () => performance.now(), check = () => {},
    maxAttempts = 250000, maxMs = 2000 } = {}) {
    if (!puzzle || typeof puzzle.challenge !== 'string' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(puzzle.challenge) ||
        !Number.isInteger(puzzle.difficulty) || puzzle.difficulty < 0 || puzzle.difficulty > 24) {
      throw new Failure('invalid-challenge');
    }
    const challenge = Uint8Array.from(atob(puzzle.challenge), c => c.charCodeAt(0));
    if (challenge.length !== 16) throw new Failure('invalid-challenge');
    const bytes = new Uint8Array(20);
    bytes.set(challenge, 4);
    const view = new DataView(bytes.buffer);
    const start = now();
    const limit = Math.min(maxAttempts, 3 * 2 ** puzzle.difficulty);
    for (let nonce = 0; nonce < limit; nonce++) {
      check();
      if (now() - start >= maxMs) break;
      view.setUint32(0, nonce, true);
      const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-512', bytes));
      check();
      if (now() - start >= maxMs) break;
      let zeroes = 0;
      for (const byte of digest) {
        if (byte === 0) zeroes += 8;
        else { zeroes += Math.clz32(byte) - 24; break; }
      }
      if (zeroes >= puzzle.difficulty) return { solution: btoa(String.fromCharCode(...bytes.slice(0, 4))) };
    }
    throw new Failure('challenge-limit');
  }
  function createBackground(api, deps = {}) {
    const fetchImpl = deps.fetch || fetch;
    const cryptoImpl = deps.crypto || crypto;
    const now = deps.now || Date.now;
    const setTimer = deps.setTimeout || setTimeout;
    const clearTimer = deps.clearTimeout || clearTimeout;
    let state, running = null, registration = null, epoch = 0;
    let lock = Promise.resolve();
    const controllers = new Set();
    const statsRequests = new Map();
    const initial = () => ({ version: 1, enabled: true, userId: null, registered: false,
      queue: {}, notBefore: 0, lastDelivery: null, lastFailure: null });
    const ready = api.storage.local.get(KEY).then(stored => {
      const saved = stored[KEY];
      state = saved?.version === 1 ? { ...initial(), ...saved } : initial();
      state.enabled = state.enabled !== false;
      if (!/^[A-Za-z0-9]{36}$/.test(state.userId || '')) { state.userId = null; state.registered = false; }
      state.queue = state.queue && typeof state.queue === 'object' && !Array.isArray(state.queue) ? state.queue : {};
      for (const [id, entry] of Object.entries(state.queue)) {
        if (!VIDEO.test(id) || !entry || typeof entry !== 'object') { delete state.queue[id]; continue; }
        for (const slot of ['current', 'next']) {
          const job = entry[slot];
          if (!job || !validVote(job.value) || typeof job.token !== 'string' ||
              !Number.isFinite(job.createdAt) || !Number.isFinite(job.retryAt) ||
              !Number.isInteger(job.attempts) || job.attempts < 0) entry[slot] = null;
        }
        if (!entry.current && !entry.next) delete state.queue[id];
      }
      if (!state.enabled) state.queue = {};
    });
    // Memory changes only after durable storage succeeds. All mutations share this lock.
    function change(edit) {
      const work = lock.then(async () => {
        await ready;
        const draft = clone(state);
        const result = edit(draft);
        await api.storage.local.set({ [KEY]: draft });
        state = draft;
        return result;
      });
      lock = work.catch(() => {});
      return work;
    }
    function record(draft, id, job, status, reason) {
      const result = { videoId: id, value: job.value, status, at: now(), ...(reason ? { reason } : {}) };
      draft.lastDelivery = result;
      if (status === 'failed') draft.lastFailure = result;
      else if (draft.lastFailure?.videoId === id) draft.lastFailure = null;
    }
    function prune(draft) {
      for (const [id, entry] of Object.entries(draft.queue)) {
        for (const slot of ['current', 'next']) {
          if (entry[slot] && now() - entry[slot].createdAt >= TTL) {
            record(draft, id, entry[slot], 'failed', 'expired');
            entry[slot] = null;
          }
        }
        if (!entry.current && !entry.next) delete draft.queue[id];
      }
    }
    async function arm() {
      await ready;
      // Repeating recovery also covers a crash during an HTTP request.
      if (Object.keys(state.queue).length) {
        const times = Object.values(state.queue).map(e => (e.current || e.next).retryAt);
        const when = Math.max(now() + 1000, Math.min(...times), state.notBefore || 0);
        await api.alarms.create(ALARM, { when: Math.min(when, now() + 60000), periodInMinutes: 1 });
      } else await api.alarms.clear(ALARM);
    }
    async function request(path, body, check = () => {}, voteRequest = false) {
      check();
      const controller = new AbortController();
      if (voteRequest) controllers.add(controller);
      const timeout = setTimer(() => controller.abort(), 10000);
      try {
        const response = await fetchImpl(API + path, {
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        check();
        if (!response.ok) {
          const header = response.headers?.get('Retry-After');
          const retryAt = header && /^\d+(\.\d+)?$/.test(header) ? now() + Number(header) * 1000 : Date.parse(header || '') || 0;
          throw new Failure(`http-${response.status}`, response.status === 429 || response.status === 408 || response.status >= 500,
            retryAt, response.status);
        }
        const json = await response.json();
        check();
        return json;
      } catch (error) {
        check();
        if (error instanceof Failure) throw error;
        if (error instanceof SyntaxError) throw new Failure('invalid-response');
        throw new Failure(controller.signal.aborted ? 'timeout' : 'network', true);
      } finally {
        clearTimer(timeout);
        controllers.delete(controller);
      }
    }
    function randomId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      return Array.from(cryptoImpl.getRandomValues(new Uint32Array(36)), x => chars[x % chars.length]).join('');
    }
    function ensureRegistered(check) {
      if (registration) return registration;
      registration = (async () => {
        check();
        if (state.registered) return state.userId;
        if (!state.userId) await change(draft => { draft.userId = randomId(); });
        check();
        const userId = state.userId;
        const path = `/puzzle/registration?userId=${encodeURIComponent(userId)}`;
        const puzzle = await request(path, undefined, check, true);
        const solution = await solvePuzzle(puzzle, cryptoImpl, { check });
        if (await request(path, solution, check, true) !== true) throw new Failure('registration-rejected');
        check();
        await change(draft => { draft.registered = true; });
        return userId;
      })().finally(() => { registration = null; });
      return registration;
    }
    async function deliver(id, job, startedEpoch) {
      const check = () => {
        if (epoch !== startedEpoch || !state.enabled || state.queue[id]?.current?.token !== job.token) throw new Failure('cancelled');
        if (now() - job.createdAt >= TTL) throw new Failure('expired');
      };
      while (true) {
        try {
          const userId = await ensureRegistered(check);
          const puzzle = await request('/interact/vote', { userId, videoId: id, value: job.value }, check, true);
          const solution = await solvePuzzle(puzzle, cryptoImpl, { check });
          if (await request('/interact/confirmVote', { ...solution, userId, videoId: id }, check, true) !== true) {
            throw new Failure('confirmation-rejected');
          }
          return;
        } catch (error) {
          check();
          if (error.status !== 401 || job.reauthUsed) throw error;
          // Persist the budget so a background restart cannot repeat registration forever.
          await change(draft => {
            draft.queue[id].current.reauthUsed = true;
            draft.registered = false;
            draft.userId = null;
          });
          job.reauthUsed = true;
        }
      }
    }
    async function drain() {
      await ready;
      while (true) {
        const selected = await change(draft => {
          prune(draft);
          if (!draft.enabled || draft.notBefore > now()) return null;
          for (const [id, entry] of Object.entries(draft.queue)) {
            const candidate = entry.current || entry.next;
            if (candidate.retryAt > now()) continue;
            if (candidate.attempts >= 4) {
              record(draft, id, candidate, 'failed', 'retry-limit');
              if (entry.current) entry.current = null; else entry.next = null;
              if (!entry.current && !entry.next) delete draft.queue[id];
              continue;
            }
            if (!entry.current) { entry.current = entry.next; entry.next = null; }
            entry.current.attempts++;
            return { id, job: clone(entry.current), startedEpoch: epoch };
          }
          return null;
        });
        await arm();
        if (!selected) return;
        const { id, job, startedEpoch } = selected;
        let error;
        try { await deliver(id, job, startedEpoch); } catch (failure) { error = failure; }
        await change(draft => {
          const entry = draft.queue[id];
          if (epoch !== startedEpoch || entry?.current?.token !== job.token) return;
          if (!error) {
            record(draft, id, job, 'delivered');
            entry.current = null;
          } else if (error.retryable && job.attempts < 4 && now() - job.createdAt < TTL) {
            entry.current.retryAt = Math.max(now() + 5000 * 2 ** (job.attempts - 1), error.retryAt || 0);
            entry.current.reason = error.code;
            if (error.status === 429) draft.notBefore = entry.current.retryAt;
          } else {
            record(draft, id, job, 'failed', error.code || 'internal');
            entry.current = null;
          }
          if (!entry.current && !entry.next) delete draft.queue[id];
        });
      }
    }
    function wake() {
      if (!running) running = drain().finally(() => { running = null; });
      return running;
    }
    const safeWake = () => { void wake().catch(() => { /* Next event retries; never send after a failed storage commit. */ }); };
    function isPopup(sender) {
      return sender?.id === api.runtime.id && ((!sender.tab && sender.url === api.runtime.getURL('popup.html')) ||
        sender.url === api.runtime.getURL('settings.html'));
    }
    function isVideo(sender, id) {
      return sender?.id === api.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) &&
        VIDEO.test(id) && videoFromURL(sender.url) === id;
    }
    /** @param {{version:1,type:'ryd.stats'|'ryd.vote'|'ryd.status'|'ryd.configure'|'ryd.activeStats',videoId?:string,value?:-1|0|1,enabled?:boolean}} message */
    async function onMessage(message, sender) {
      if (!message || message.version !== 1 || typeof message.type !== 'string') return { ok: false, error: 'invalid-message' };
      try {
        if (message.type === 'ryd.stats' || message.type === 'ryd.vote') {
          if (typeof message.videoId !== 'string' || !isVideo(sender, message.videoId)) return { ok: false, error: 'invalid-sender' };
          if (message.type === 'ryd.stats') {
            safeWake();
            const id = message.videoId;
            if (!statsRequests.has(id)) {
              statsRequests.set(id, request(`/votes?videoId=${encodeURIComponent(id)}`).then(json => parseStats(json, id))
                .finally(() => statsRequests.delete(id)));
            }
            return { ok: true, stats: await statsRequests.get(id) };
          }
          if (!validVote(message.value)) return { ok: false, error: 'invalid-vote' };
          // Arm before storage: a suspension after the commit still has a wake-up event.
          await api.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
          const result = await change(draft => {
            prune(draft);
            if (!draft.enabled) return { ok: false, error: 'disabled' };
            const id = message.videoId;
            const job = { value: message.value, token: randomId(), createdAt: now(), retryAt: now(), attempts: 0, reauthUsed: false };
            if (!draft.queue[id] && Object.keys(draft.queue).length >= 100) {
              record(draft, id, job, 'failed', 'queue-full');
              return { ok: false, error: 'queue-full' };
            }
            draft.queue[id] ||= { current: null, next: null };
            draft.queue[id].next = job;
            return { ok: true, status: 'queued' };
          });
          safeWake();
          return result;
        }
        if (!isPopup(sender)) return { ok: false, error: 'invalid-sender' };
        if (message.type === 'ryd.activeStats') {
          const [tab] = await api.tabs.query({ active: true, currentWindow: true });
          const id = videoFromURL(tab?.url);
          if (!id) return { ok: false, error: 'no-video' };
          const stats = parseStats(await request(`/votes?videoId=${encodeURIComponent(id)}`), id);
          if (!Number.isSafeInteger(stats.likes)) return { ok: false, error: 'invalid-response' };
          const [current] = await api.tabs.query({ active: true, currentWindow: true });
          if (current?.id !== tab.id || videoFromURL(current?.url) !== id) return { ok: false, error: 'video-changed' };
          return { ok: true, videoId: id, stats };
        }
        if (message.type === 'ryd.configure' && typeof message.enabled === 'boolean') {
          await change(draft => {
            draft.enabled = message.enabled;
            if (!draft.enabled) { draft.queue = {}; draft.notBefore = 0; }
          });
          if (!message.enabled) {
            epoch++;
            for (const controller of controllers) controller.abort();
          }
        } else if (message.type !== 'ryd.status') return { ok: false, error: 'invalid-message' };
        await change(prune);
        await arm();
        safeWake();
        return { ok: true, enabled: state.enabled, pending: Object.keys(state.queue).length,
          lastDelivery: state.lastDelivery, lastFailure: state.lastFailure };
      } catch (error) { return { ok: false, error: error.code || 'storage-or-network' }; }
    }
    // Register synchronously: Safari uses these listeners to wake the background page.
    api.runtime.onMessage.addListener(onMessage);
    api.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) safeWake(); });
    api.runtime.onStartup.addListener(safeWake);
    api.runtime.onInstalled.addListener(safeWake);
    safeWake();
    return { onMessage, wake, ready, idle: async () => { await ready; await running; await lock; }, snapshot: () => clone(state) };
  }
  return { createBackground, solvePuzzle, parseStats, videoFromURL, KEY, TTL };
})();
if (typeof module !== 'undefined') module.exports = RYD;
if (typeof browser !== 'undefined') RYD.createBackground(browser);
