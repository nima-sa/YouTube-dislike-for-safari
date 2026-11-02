const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const path = 'YouTube Dislike Extension/Resources/';
const flush = () => new Promise(r => setImmediate(r));
function setup(t, language = 'en', responder = async () => ({ ok: true, enabled: true, pending: 0 }), page = 'settings.html') {
  const dom = new JSDOM(fs.readFileSync(path + page, 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let changed;
  const requests = [];
  dom.window.browser = { i18n: { getUILanguage: () => language }, runtime: { getManifest: () => ({ version: '1.2.0' }), sendMessage: m => { requests.push(m); return responder(m); } },
    storage: { onChanged: { addListener: fn => { changed = fn; } } } };
  dom.window.eval(fs.readFileSync(path + 'popup.js', 'utf8'));
  return { window: dom.window, document: dom.window.document, requests,
    change: state => changed({ rydState: { newValue: state } }, 'local') };
}
test('popup provides Russian and English fallback, privacy and a safe source link', async t => {
  for (const language of ['ru-RU', 'en-US', 'ja']) {
    const env = setup(t, language); await flush();
    assert.equal(env.document.documentElement.lang, language.startsWith('ru') ? 'ru' : 'en');
    assert.equal(env.document.querySelector('#enabled').checked, true);
    assert.equal(env.document.querySelector('#version').textContent, 'v1.2.0');
    const feedback = new URL(env.document.querySelector('#feedback').href);
    assert.equal(feedback.protocol, 'mailto:');
    assert.equal(feedback.pathname, 'denis@malina.page');
    assert.match(feedback.searchParams.get('body'), /1\.2\.0/);
    assert.match(env.document.body.textContent, /IP/);
    assert.match(env.document.body.textContent, /cookies/);
    assert.equal(env.document.querySelector('a').rel, 'noopener noreferrer');
    assert.ok([...env.document.querySelectorAll('[data-i18n]')].every(n => n.textContent.length > 0));
  }
});
test('toggle commits via background and delivery updates do not trigger message loops', async t => {
  const env = setup(t, 'en', async m => ({ ok: true, enabled: m.type === 'ryd.configure' ? m.enabled : true, pending: 0 }));
  await flush(); const toggle = env.document.querySelector('#enabled');
  toggle.checked = false; toggle.dispatchEvent(new env.window.Event('change')); await flush();
  assert.equal(toggle.checked, false); assert.match(env.document.querySelector('#status').textContent, /off/);
  assert.equal(env.requests.filter(m => m.type !== 'ryd.activeStats').length, 2);
  env.change({ enabled: false, queue: {}, lastFailure: { videoId: 'YLUD8tKK5yM', at: 1, reason: 'expired' } });
  assert.match(env.document.querySelector('#failure').textContent, /24-hour/); assert.equal(env.requests.filter(m => m.type !== 'ryd.activeStats').length, 2);
});
test('failed initial settings read keeps the toggle disabled; failed save restores its value', async t => {
  const unavailable = setup(t, 'en', async () => ({ ok: false })); await flush();
  assert.equal(unavailable.document.querySelector('#enabled').disabled, true);
  const env = setup(t, 'en', async m => m.type === 'ryd.configure' ? { ok: false } : { ok: true, enabled: true, pending: 0 }); await flush();
  const toggle = env.document.querySelector('#enabled'); toggle.checked = false;
  toggle.dispatchEvent(new env.window.Event('change')); await flush();
  assert.equal(toggle.checked, true); assert.match(env.document.querySelector('#status').textContent, /could not be saved/);
});
test('compact popup shows only statistics, preserving zero; other pages show a short hint', async t => {
  const env = setup(t, 'en', async () => ({ ok: true, stats: { likes: 0, dislikes: 0 } }), 'popup.html');
  await flush();
  assert.equal(env.document.querySelector('#video-stats').hidden, false);
  assert.equal(env.document.querySelector('#video-likes').textContent, '0');
  assert.equal(env.document.querySelector('#video-dislikes').textContent, '≈ 0');
  assert.equal(env.document.querySelector('#enabled'), null);
  assert.equal(env.document.querySelector('header'), null);
  assert.equal(env.requests.length, 1);
  const empty = setup(t, 'ru', async () => ({ ok: false, error: 'no-video' }), 'popup.html');
  await flush();
  assert.equal(empty.document.querySelector('#video-stats').hidden, true);
  assert.match(empty.document.querySelector('#video-status').textContent, /YouTube/);
});
