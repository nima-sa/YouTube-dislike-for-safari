const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('YouTube Dislike Extension/Resources/content.js', 'utf8');
const A = 'YLUD8tKK5yM', B = 'Ab5EIsr6_xc';
const modern = '<segmented-like-dislike-button-view-model><like-button-view-model><button aria-pressed="false"><span role="text">1.8K</span></button></like-button-view-model><dislike-button-view-model><button aria-pressed="false"><span role="text">Dislike</span></button></dislike-button-view-model></segmented-like-dislike-button-view-model>';
const old = '<ytd-segmented-like-dislike-button-renderer><div><button aria-pressed="false"><span id="text">1.8K</span></button></div><div><button aria-pressed="false"><span id="text">Dislike</span></button></div></ytd-segmented-like-dislike-button-renderer>';
const desktop = (controls = modern, id = A) => `<ytd-watch-flexy video-id="${id}"><div id="top-level-buttons-computed">${controls}</div></ytd-watch-flexy>`;
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, { html = desktop(), url = `https://www.youtube.com/watch?v=${A}`, dislikes = 1438, responder, lang = 'en' } = {}) {
  const dom = new JSDOM(`<html lang="${lang}"><head></head><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
  const { window } = dom;
  const intervals = new Map(), handlers = new Map(), requests = [];
  let timerId = 0, time = 10000;
  window.Date.now = () => time;
  window.setInterval = fn => { intervals.set(++timerId, fn); return timerId; };
  window.clearInterval = id => intervals.delete(id);
  window.fetch = () => { throw new Error('Content scripts must not fetch'); };
  window.browser = { runtime: { sendMessage: message => {
    requests.push(message);
    return responder ? responder(message) : Promise.resolve(message.type === 'ryd.stats' ? { ok: true, stats: { dislikes } } : { ok: true });
  } } };
  const add = window.addEventListener.bind(window);
  window.addEventListener = (name, fn, options) => { handlers.set(name, fn); add(name, fn, options); };
  window.eval(source);
  const buttons = () => [...window.document.querySelectorAll('#top-level-buttons-computed button, #actions button, .slim-video-action-bar-actions button')];
  return {
    window, document: window.document, requests, intervals, buttons,
    tick: (ms = 500) => { time += ms; [...intervals.values()].forEach(fn => fn()); },
    event: name => window.dispatchEvent(new window.Event(name)),
    label: () => window.document.querySelector('dislike-button-view-model span'),
    submissions: () => requests.filter(r => r.type === 'ryd.vote'),
    state: value => { const [like, dislike] = buttons(); like.setAttribute('aria-pressed', String(value === 1)); dislike.setAttribute('aria-pressed', String(value === -1)); },
    // jsdom cannot create trusted input. Invoke the captured listener with a test event;
    // production still receives only native Event.isTrusted. No test hook ships in the script.
    activate: (index, props = {}) => handlers.get('click')({ isTrusted: true, button: 0, target: buttons()[index], ...props }),
    key: (index, key = 'Enter') => handlers.get('keydown')({ isTrusted: true, key, target: buttons()[index] }),
    navigate: id => {
      window.dispatchEvent(new window.Event('yt-navigate-start'));
      window.history.pushState({}, '', `/watch?v=${id}`);
      window.document.body.innerHTML = desktop(modern, id);
      window.dispatchEvent(new window.Event('yt-navigate-finish'));
    },
  };
}
test('shows only the estimate in the native button with its exact tooltip', async t => {
  const env = setup(t); await flush();
  assert.equal(env.document.querySelector('#ryd-user-votes'), null);
  assert.equal(env.label().textContent, '≈ 1.4K');
  assert.match(env.label().title, /1,438/);
  assert.equal(env.document.querySelector('like-button-view-model span').textContent, '1.8K');
  assert.deepEqual(JSON.parse(JSON.stringify(env.requests[0])), { version: 1, type: 'ryd.stats', videoId: A });
});
test('zero is a real estimate; missing counts leave the native button', async t => {
  for (const dislikes of [0, undefined, null]) {
    const env = setup(t, { responder: async () => ({ ok: true, stats: { dislikes } }) }); await flush();
    assert.equal(env.label().textContent, dislikes === 0 ? '≈ 0' : 'Dislike');
  }
});
test('never inserts HTML from a response', async t => {
  const env = setup(t, { dislikes: '<img src=x onerror="window.pwned=true">' }); await flush();
  assert.equal(env.document.querySelector('img'), null); assert.equal(env.label().textContent, 'Dislike');
});
test('rejects non-finite, negative, fractional and unsafe counts', async t => {
  for (const dislikes of [Infinity, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, '12']) {
    const env = setup(t, { dislikes }); await flush(); assert.equal(env.label().textContent, 'Dislike');
  }
});
test('background failures leave native controls and do not poll the API', async t => {
  for (const result of [null, { ok: false, error: 'http-429' }, { ok: true, stats: {} }]) {
    const env = setup(t, { responder: async () => result }); await flush(); env.tick();
    assert.equal(env.label().textContent, 'Dislike'); assert.equal(env.requests.length, 1);
  }
});
test('a timeout or disconnected background leaves the native button', async t => {
  const env = setup(t, { responder: async () => { throw new Error('timeout'); } }); await flush();
  assert.equal(env.label().textContent, 'Dislike');
});
test('ignores stale statistics after SPA navigation', async t => {
  const pending = [];
  const env = setup(t, { responder: () => new Promise(resolve => pending.push(resolve)) }); env.navigate(B);
  pending[1]({ ok: true, stats: { dislikes: 0 } }); await flush();
  pending[0]({ ok: true, stats: { dislikes: 1438 } }); await flush();
  assert.equal(env.label().textContent, '≈ 0'); assert.equal(env.submissions().length, 0);
});
test('remounts after button replacement without duplicate labels or a new fetch', async t => {
  const env = setup(t); await flush(); env.document.body.innerHTML = desktop();
  for (let i = 0; i < 10; i++) env.tick();
  assert.equal(env.label().textContent, '≈ 1.4K'); assert.equal(env.requests.length, 1);
  env.buttons()[0].click(); assert.equal(env.submissions().length, 0); assert.equal(env.label().textContent, '≈ 1.4K');
});
test('supports legacy desktop, desktop grid, mobile and active Shorts', async t => {
  const fixtures = [
    { html: desktop(old) }, { html: desktop().replaceAll('ytd-watch-flexy', 'ytd-watch-grid') },
    { url: `https://m.youtube.com/watch?v=${A}`, html: `<div class="slim-video-action-bar-actions"><div class="segmented-buttons"><button aria-pressed="false">Like</button><button aria-pressed="false"><span class="button-renderer-text">Dislike</span></button></div></div>` },
    ...['ytd-reel-video-renderer', 'ytm-reel-item-renderer'].map(tag => ({ url: `https://${tag.startsWith('ytm') ? 'm' : 'www'}.youtube.com/shorts/${A}`, html: `<${tag} is-active video-id="${A}"><div id="actions"><div id="like-button"><button aria-pressed="false">Like</button></div><div id="dislike-button"><button aria-pressed="false">Dislike</button></div></div></${tag}>` })),
  ];
  for (const fixture of fixtures) {
    const env = setup(t, fixture); await flush(); assert.match(env.document.body.textContent, /≈ 1.4K/);
    env.activate(1); env.state(-1); env.tick(); env.tick();
    assert.equal(env.submissions()[0]?.value, -1);
  }
});
test('waits for controls belonging to the current video', async t => {
  const env = setup(t, { html: desktop(modern, B) }); await flush(); assert.equal(env.label().textContent, 'Dislike');
  env.activate(0); env.state(1); env.tick(); env.tick(); assert.equal(env.submissions().length, 0);
  env.document.querySelector('ytd-watch-flexy').setAttribute('video-id', A); env.tick();
  assert.equal(env.label().textContent, '≈ 1.4K');
});
test('restores native text on non-video navigation and keeps one poll', async t => {
  const env = setup(t); await flush(); env.window.history.pushState({}, '', '/');
  for (let i = 0; i < 100; i++) env.event('yt-navigate-finish');
  assert.equal(env.label().textContent, 'Dislike'); assert.equal(env.intervals.size, 1); assert.equal(env.requests.length, 1);
});
test('rejects malformed video IDs', t => {
  for (const url of ['https://www.youtube.com/watch?v=abc%26extra%3D1', 'https://www.youtube.com/', 'https://www.youtube.com/shorts/invalid']) {
    assert.equal(setup(t, { url }).requests.length, 0);
  }
});
test('restores after back-forward cache and never sends a preexisting vote', async t => {
  const env = setup(t); env.state(1); await flush(); env.event('pagehide'); assert.equal(env.intervals.size, 0);
  env.window.dispatchEvent(new env.window.PageTransitionEvent('pageshow', { persisted: true })); await flush();
  env.tick(); assert.equal(env.intervals.size, 1); assert.equal(env.label().textContent, '≈ 1.4K'); assert.equal(env.submissions().length, 0);
});
test('uses Russian descriptions and English fallback', async t => {
  for (const lang of ['ru-RU', 'fr']) {
    const env = setup(t, { lang }); await flush();
    assert.match(env.label().title, lang.startsWith('ru') ? /Приблизительное/ : /Estimated/);
  }
});
test('submits confirmed like, dislike and withdrawal without inflating counts', async t => {
  const env = setup(t); await flush();
  for (const [button, value] of [[0, 1], [1, -1], [1, 0]]) {
    env.activate(button); env.state(value); env.tick(); assert.notEqual(env.submissions().at(-1)?.value, value);
    env.tick(); assert.equal(env.submissions().at(-1).value, value);
    assert.equal(env.label().textContent, '≈ 1.4K');
  }
  assert.deepEqual(env.submissions().map(r => r.value), [1, -1, 0]);
});
test('skips synthetic, unconfirmed and unknown-state clicks', async t => {
  const env = setup(t); await flush();
  env.activate(0, { isTrusted: false }); env.state(1); env.tick(); env.tick();
  env.activate(1); env.tick(); env.tick(); // no native state change
  env.buttons()[1].removeAttribute('aria-pressed'); env.activate(0); env.state(0); env.tick(); env.tick();
  assert.equal(env.submissions().length, 0);
});
test('a sign-in dialog or an optimistic rollback prevents delivery', async t => {
  for (const dialog of [true, false]) {
    const env = setup(t); await flush(); env.activate(0); env.state(1); env.tick(100);
    if (dialog) env.document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Sign in</div>'); else env.state(0);
    env.tick(); env.tick(); assert.equal(env.submissions().length, 0);
  }
});
test('rapid switches retain only the last confirmed intent and bind it to the clicked video', async t => {
  const env = setup(t); await flush();
  env.activate(0); env.state(1); env.tick(50); env.activate(1); env.state(-1); env.tick(); env.tick();
  assert.deepEqual(env.submissions().map(r => [r.videoId, r.value]), [[A, -1]]);
  env.activate(1); env.state(0); env.navigate(B); env.tick(); env.tick();
  assert.equal(env.submissions().length, 1);
});
test('keyboard activation survives state changes before the native click', async t => {
  const env = setup(t); await flush(); env.key(0); env.state(1); env.activate(0); env.tick(); env.tick();
  assert.equal(env.submissions()[0]?.value, 1);
});
test('does not infer voting controls from arbitrary neighboring buttons', async t => {
  const env = setup(t, { html: desktop('<div><button aria-pressed="false">Share</button></div><div><button aria-pressed="false">Save</button></div>') });
  await flush(); env.activate(1); env.state(-1); env.tick(); env.tick();
  assert.equal(env.submissions().length, 0); assert.doesNotMatch(env.document.body.textContent, /≈/);
});

test('restores original tooltip after YouTube reuses a label', async t => {
  const env = setup(t); await flush();
  env.label().textContent = 'Updated dislike label'; env.tick();
  env.window.history.pushState({}, '', '/'); env.tick();
  assert.equal(env.label().textContent, 'Updated dislike label'); assert.equal(env.label().getAttribute('title'), null);
});

test('detects mobile YouTube on www and adds one compact label to icon-only controls', async t => {
  const env = setup(t, { html: `<ytm-app><div class="slim-video-action-bar-actions"><div class="segmented-buttons"><button aria-pressed="false"><svg></svg></button><button aria-pressed="false"><svg></svg></button></div></div></ytm-app>` });
  await flush(); env.tick(); env.tick();
  const labels = env.document.querySelectorAll('.ryd-estimate-label');
  assert.equal(labels.length, 1);
  assert.equal(labels[0].textContent, '≈ 1.4K');
  assert.match(labels[0].title, /1,438/);
  assert.equal(env.buttons()[1].querySelectorAll('svg').length, 1);
  assert.equal(env.submissions().length, 0);
});
