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
  let elapsed = 0;
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
    now: () => now() + elapsed,
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
      if (ms === 100) elapsed += 30000;
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

test('activity defers reload until idle and a hidden tab reloads immediately with scroll saved', async () => {
  let time = 1000000;
  let version = 'v1';
  const timers = [];
  const listeners = {};
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const section = { id: 'positions', getBoundingClientRect: () => ({ top: -23 }) };
  const doc = { visibilityState: 'visible', addEventListener: (type, fn) => { listeners[type] = fn; },
    getElementById: () => null, elementFromPoint: () => ({ closest: () => section }) };
  let reloads = 0;
  const checker = dashboard.startVersionCheck(doc, {
    now: () => time, sessionStorage: storage, location: { reload: () => { reloads++; } },
    setInterval: () => {}, setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cleared = true; },
    fetcher: async url => ({ status: 200, text: async () => version + url })
  });
  await checker.ready;
  version = 'v2';
  await checker.check();
  listeners.touchstart();
  timers.find(timer => timer.ms === 100).fn();
  assert.equal(reloads, 0);
  time += 15000;
  listeners.scroll();
  timers.find(timer => timer.ms === 30000).fn();
  assert.equal(reloads, 0);
  doc.visibilityState = 'hidden';
  listeners.visibilitychange();
  assert.equal(reloads, 1);
  assert.deepEqual(JSON.parse(values.get('race-dashboard-scroll')), { y: 0, id: 'positions', offset: -23 });
});

test('reload saves a major section when the top hit is inline or empty', async () => {
  for (const hit of ['nested', 'inline', 'empty']) {
    let version = 'v1';
    const timers = [], listeners = {}, values = new Map();
    const positions = { id: 'positions', getBoundingClientRect: () => ({ top: -639, bottom: 200 }) };
    const cards = { id: 'cards', getBoundingClientRect: () => ({ top: -1000, bottom: -10 }) };
    const tiny = { id: 'clk' };
    const doc = { visibilityState: 'visible', addEventListener: (type, fn) => { listeners[type] = fn; },
      getElementById: id => ({ positions, cards })[id] || null,
      elementFromPoint: () => hit === 'empty' ? null : { closest: selector => selector === '[id]' ? tiny : hit === 'nested' ? positions : null } };
    const checker = dashboard.startVersionCheck(doc, { now: () => 100000,
      sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      location: { reload() {} }, setInterval() {},
      setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout() {},
      fetcher: async url => ({ status: 200, text: async () => version + url }) });
    await checker.ready; version = 'v2'; await checker.check();
    doc.visibilityState = 'hidden'; listeners.visibilitychange();
    assert.deepEqual(JSON.parse(values.get('race-dashboard-scroll')), { y: 0, id: 'positions', offset: -639 });
  }
});

function savedScrollPage(value = { y: 500, id: 'positions', offset: -20 }, visibilityState = 'visible') {
  let saved = JSON.stringify(value), loading = true, now = 0;
  const scrolls = [], listeners = {}, timers = [];
  const page = { scrollY: 100, innerHeight: 100, history: { scrollRestoration: 'auto' }, Date: { now: () => now },
    requestAnimationFrame: () => {}, scrollTo: (x, y) => { scrolls.push([x, y]); listeners.scroll?.(); },
    setTimeout: (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    sessionStorage: { getItem: () => saved, removeItem: () => { saved = null; } } };
  const doc = { visibilityState, documentElement: { scrollHeight: 150 },
    querySelector: () => ({ classList: { contains: () => loading } }),
    getElementById: id => id === 'positions' ? { getBoundingClientRect: () => ({ top: 70 }) } : null,
    addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; } };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = timers.filter(timer => !timer.cleared && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at; next.cleared = true; next.fn();
    }
    now = end;
  }
  return { page, doc, scrolls, listeners, advance, saved: () => saved, reveal: () => { loading = false; },
    visibility: value => { doc.visibilityState = value; listeners.visibilitychange?.(); } };
}

test('hidden load waits for visibility and restores through timers without animation frames', () => {
  const p = savedScrollPage(undefined, 'hidden');
  const restore = dashboard.restoreSavedScroll(p.doc, p.page);
  p.reveal(); restore(); p.advance(10000);
  assert.notEqual(p.saved(), null); assert.deepEqual(p.scrolls, []);
  p.visibility('visible'); p.advance(100);
  assert.deepEqual(p.scrolls, []);
  p.doc.documentElement.scrollHeight = 290; p.advance(50);
  assert.deepEqual(p.scrolls, [[0, 190]]); assert.equal(p.saved(), null);
  assert.equal(p.page.history.scrollRestoration, 'auto');
  assert.deepEqual(p.listeners, {});
  restore(); p.advance(5000); assert.deepEqual(p.scrolls, [[0, 190]]);
});

test('visible time pauses when hidden and gives up at the furthest reachable point', () => {
  const p = savedScrollPage({ y: 500, id: 'missing', offset: -20 });
  p.reveal(); dashboard.restoreSavedScroll(p.doc, p.page)();
  p.advance(1200); p.visibility('hidden'); p.advance(10000);
  assert.notEqual(p.saved(), null); assert.deepEqual(p.scrolls, []);
  p.visibility('visible'); p.advance(1799); assert.deepEqual(p.scrolls, []);
  p.advance(1); assert.deepEqual(p.scrolls, [[0, 50]]);
  assert.equal(p.saved(), null); assert.equal(p.page.history.scrollRestoration, 'auto');
  assert.deepEqual(p.listeners, {});
});

test('user interaction cancels restoration and restores automatic browser scrolling', () => {
  for (const event of ['touchstart', 'touchmove', 'wheel', 'scroll', 'pointerdown']) {
    const p = savedScrollPage();
    const restore = dashboard.restoreSavedScroll(p.doc, p.page);
    p.reveal(); restore(); p.listeners[event](); p.advance(5000); restore();
    assert.equal(p.saved(), null); assert.deepEqual(p.scrolls, []);
    assert.equal(p.page.history.scrollRestoration, 'auto'); assert.deepEqual(p.listeners, {});
  }
  assert.doesNotThrow(() => dashboard.restoreSavedScroll({}, { get sessionStorage() { throw new Error('blocked'); } }));
});

test('a visible tab waits a full thirty seconds after the latest activity', async () => {
  let time = 1000000;
  let version = 'v1';
  const timers = [];
  const listeners = {};
  let reloads = 0;
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; }, getElementById: () => null };
  const checker = dashboard.startVersionCheck(doc, { now: () => time, sessionStorage: { getItem: () => null, setItem: () => {} },
    location: { reload: () => reloads++ }, setInterval: () => {},
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: () => {},
    fetcher: async url => ({ status: 200, text: async () => version + url }) });
  await checker.ready;
  version = 'v2';
  await checker.check();
  time += 100;
  timers.find(timer => timer.ms === 100).fn();
  time += 10000;
  listeners.pointermove();
  time += 19900;
  timers.find(timer => timer.ms === 29900).fn();
  assert.equal(reloads, 0);
  time += 10100;
  timers.find(timer => timer.ms === 10100).fn();
  assert.equal(reloads, 1);
});

test('holding a pointer prevents reload even after thirty seconds', async () => {
  let time = 1000000;
  let version = 'v1';
  const timers = [], listeners = {};
  let reloads = 0;
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; }, getElementById: () => null };
  const checker = dashboard.startVersionCheck(doc, { now: () => time, sessionStorage: { getItem: () => null, setItem: () => {} },
    location: { reload: () => reloads++ }, setInterval: () => {},
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: () => {},
    fetcher: async url => ({ status: 200, text: async () => version + url }) });
  await checker.ready;
  version = 'v2';
  await checker.check();
  listeners.pointerdown({ pointerId: 1 });
  time += 30000;
  timers.find(timer => timer.ms === 100).fn();
  assert.equal(reloads, 0);
  listeners.pointerup({ pointerId: 1 });
  time += 1000;
  timers.find(timer => timer.ms === 1000).fn();
  assert.equal(reloads, 0);
  time += 29000;
  timers.find(timer => timer.ms === 29000).fn();
  assert.equal(reloads, 1);
});
