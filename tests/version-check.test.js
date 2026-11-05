'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');

function setup({ visibilityState = 'visible', now = () => 1000000, sessionStorage, version = 'v1', cachedVersion = version, mode = 'ok' } = {}) {
  sessionStorage ||= { getItem: () => null, setItem: () => {} };
  let currentVersion = version;
  const requests = [];
  const intervals = [];
  const timers = [];
  const listeners = {};
  const reloads = [];
  const status = { textContent: '', className: '' };
  const doc = {
    visibilityState,
    addEventListener: (name, callback) => { listeners[name] = callback; },
    getElementById: id => id === 'data-status' ? status : null
  };
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (mode === 'pending') return new Promise(() => {});
    if (mode === 'error' && url === 'dashboard.js') throw new Error('offline');
    if (mode === 'force-cache-error' && options.cache === 'force-cache' && url === 'dashboard.js') throw new Error('offline');
    return {
      status: mode === 'http' && url === 'layout-v4.js' ? 503 : 200,
      text: async () => `${options.cache === 'force-cache' ? cachedVersion : currentVersion}:${url}`
    };
  };
  const checker = dashboard.startVersionCheck(doc, {
    fetcher,
    now,
    sessionStorage,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
    location: { reload: () => { reloads.push(currentVersion); } }
  });
  return {
    checker, doc, intervals, listeners, reloads, requests, status, timers,
    setVersion: value => { currentVersion = value; },
    setMode: value => { mode = value; },
    fire: ms => timers.filter(timer => !timer.cleared && timer.ms === ms).forEach(timer => {
      timer.cleared = true;
      timer.callback();
    })
  };
}

test('matching version fingerprint does not reload', async () => {
  const page = setup();
  await page.checker.ready;
  assert.equal(await page.checker.check(), false);
  assert.deepEqual(page.reloads, []);
  assert.equal(page.intervals[0].ms, 5 * 60000);
  assert.deepEqual(page.requests.map(request => request.url), [
    'index.html', 'dashboard.js', 'layout-v4.js', 'index.html', 'dashboard.js', 'layout-v4.js',
    'index.html', 'dashboard.js', 'layout-v4.js'
  ]);
  assert.deepEqual(page.requests.map(request => request.options.cache), [
    'force-cache', 'force-cache', 'force-cache', 'reload', 'reload', 'reload', 'reload', 'reload', 'reload'
  ]);
});

test('a changed cached fingerprint reloads during the first check', async () => {
  const page = setup({ version: 'v2', cachedVersion: 'v1' });
  assert.equal(await page.checker.ready, true);
  assert.equal(page.status.textContent, '網頁有新版本，重新載入中…');
  assert.equal(await page.checker.check(), false);
  page.fire(100);
  assert.deepEqual(page.reloads, ['v2']);
});

test('a failing force-cache fetch falls back to the reload fingerprint', async () => {
  const page = setup({ mode: 'force-cache-error' });
  assert.equal(await page.checker.ready, false);
  assert.equal(await page.checker.check(), false);
  assert.deepEqual(page.reloads, []);
});

test('changed fingerprint shows status and schedules one reload', async () => {
  const page = setup();
  await page.checker.ready;
  page.setVersion('v2');
  assert.equal(await page.checker.check(), true);
  assert.equal(page.status.textContent, '網頁有新版本，重新載入中…');
  assert.equal(await page.checker.check(), false);
  page.fire(100);
  assert.deepEqual(page.reloads, ['v2']);
});

test('a second version change waits until the ten minute reload cooldown expires', async () => {
  let now = 1000000;
  const values = new Map();
  const sessionStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  const first = setup({ now: () => now, sessionStorage });
  await first.checker.ready;
  first.setVersion('v2');
  assert.equal(await first.checker.check(), true);
  first.fire(100);

  const nextPage = setup({ now: () => now, sessionStorage });
  nextPage.setVersion('v2');
  await nextPage.checker.ready;
  nextPage.setVersion('v3');
  now += 5 * 60000;
  assert.equal(await nextPage.checker.check(), false);
  assert.deepEqual(nextPage.reloads, []);
  now += 6 * 60000;
  assert.equal(await nextPage.checker.check(), true);
  nextPage.fire(100);
  assert.deepEqual(nextPage.reloads, ['v3']);
});

test('network errors and non-200 responses do not reload, and a later check can recover', async () => {
  const page = setup();
  await page.checker.ready;
  page.setVersion('v2');
  page.setMode('error');
  assert.equal(await page.checker.check(), false);
  page.setMode('http');
  assert.equal(await page.checker.check(), false);
  assert.deepEqual(page.reloads, []);
  page.setMode('ok');
  assert.equal(await page.checker.check(), true);
  page.fire(100);
  assert.deepEqual(page.reloads, ['v2']);
});

test('a version request that does not settle times out without reloading', async () => {
  const page = setup();
  await page.checker.ready;
  page.setVersion('v2');
  page.setMode('pending');
  const check = page.checker.check();
  page.fire(10000);
  assert.equal(await check, false);
  assert.deepEqual(page.reloads, []);
});

test('hidden tabs skip checks and becoming visible starts one immediately', async () => {
  const page = setup();
  await page.checker.ready;
  page.doc.visibilityState = 'hidden';
  page.setVersion('v2');
  await page.intervals[0].callback();
  assert.equal(page.requests.length, 6);
  page.doc.visibilityState = 'visible';
  assert.equal(await page.listeners.visibilitychange(), true);
  assert.equal(page.requests.length, 9);
  assert.deepEqual(page.reloads, []);
  page.fire(100);
  assert.deepEqual(page.reloads, ['v2']);
});
