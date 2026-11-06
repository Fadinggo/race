'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');
const layout = require('../layout-v4.js');

class Node {
  constructor(tag, type = 1) {
    this.nodeType = type; this.nodeName = tag; this.tagName = tag; this.childNodes = []; this.parentNode = null;
    this.attrs = {}; this.listeners = {}; this.style = {}; this.height = 500;
    this.dataset = new Proxy({}, { get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())) ?? undefined,
      set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value); return true; } });
    this.classList = { contains: value => this.className.split(' ').includes(value), add: value => { if (!this.classList.contains(value)) this.className = (this.className + ' ' + value).trim(); },
      remove: value => { this.className = this.className.split(' ').filter(c => c !== value).join(' '); } };
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  get parentElement() { return this.parentNode; }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  set className(value) { this.setAttribute('class', value); } get className() { return this.getAttribute('class') || ''; }
  set open(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } get open() { return this.hasAttribute('open'); }
  set hidden(value) { value ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); } get hidden() { return this.hasAttribute('hidden'); }
  set textContent(value) { this.childNodes.forEach(n => { n.parentNode = null; }); this.childNodes = []; if (String(value)) this.append(new Text(String(value))); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  setAttribute(name, value) { this.attrs[name] = String(value); } getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return name in this.attrs; } removeAttribute(name) { delete this.attrs[name]; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) { if (node.parentNode) node.remove(); const i = before ? this.childNodes.indexOf(before) : this.childNodes.length; this.childNodes.splice(i, 0, node); node.parentNode = this; return node; }
  remove() { if (this.parentNode) { const a = this.parentNode.childNodes; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
  replaceChildren(...nodes) { for (const n of [...this.childNodes]) n.remove(); this.append(...nodes); }
  after(node) { this.parentNode.insertBefore(node, this.nextSibling); }
  addEventListener(type, fn, options) { (this.listeners[type] ||= []).push({ fn, options }); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item.fn !== fn); }
  dispatchEvent(event) { if (!event.target) Object.defineProperty(event, 'target', { value: this }); for (const item of this.listeners[event.type] || []) item.fn(event); return true; }
  contains(node) { return node === this || this.childNodes.some(c => c.contains?.(node)); }
  matches(selector) { if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1)); if (selector === 'button[data-ledger-mode]') return this.nodeName === 'button' && this.hasAttribute('data-ledger-mode'); return this.nodeName === selector; }
  closest(selector) { for (let n = this; n; n = n.parentNode) if (n.matches?.(selector)) return n; return null; }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { height: this.height, top: 0 }; }
  scrollIntoView() { throw Error('forced scrollIntoView'); }
}
class Text extends Node { constructor(value) { super('#text', 3); this.value = value; } get textContent() { return this.value; } set textContent(v) { this.value = String(v); } }
class Document extends Node {
  constructor() { super('#document', 9); this.nodes = {}; this.hidden = false; }
  createElement(tag) { return new Node(tag); }
  getElementById(id) { return this.nodes[id] || null; }
  add(id, tag = 'div', parent = this) { const node = this.createElement(tag); this.nodes[id] = node; parent.append(node); return node; }
}
function page() {
  const doc = new Document(); const wrap = doc.add('wrap'); wrap.className = 'wrap is-loading';
  for (const id of ['clk', 'data-status', 'data-updated', 'cards', 'chart-status', 'eqc']) doc.add(id, 'div', wrap);
  const shelf = doc.add('notes-shelf', 'div', wrap); for (const id of ['notes-a', 'notes-b']) doc.add(id, 'aside', shelf);
  const ledger = doc.add('ledger', 'section', wrap); ledger.className = 'ledger-section';
  const filters = doc.add('ledger-filters', 'div', ledger); const rows = doc.add('rows', 'div', ledger);
  const button = doc.createElement('button'); button.dataset.ledgerMode = 'A'; button.dataset.ledgerGroup = 'trader'; filters.append(button);
  return { doc, wrap, ledger, filters, rows, button };
}
const snapshot = value => ({ snapshot_id: 'one', source: 'own-okx-readonly', updated: 1760000000,
  traders: { 'Grok-Trader-A': { equity: value, start: 100, updated: 1760000000, positions: [] }, 'Grok-Trader-B': { equity: 100, start: 100, updated: 1760000000, positions: [] } },
  trades: [{ trader: 'Grok-Trader-A', market: 'ETH', side: 'long', ts: 1760000000, price: 1, qty: 1 }, { trader: 'Grok-Trader-B', market: 'BTC', side: 'long', ts: 1760000000, price: 1, qty: 1 }] });
function withPage(run) {
  const names = ['fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'addEventListener', 'getComputedStyle', 'RaceLayout', 'RaceNotesReady', 'scrollTo', 'scrollBy', 'sessionStorage', 'requestAnimationFrame', 'history', 'innerHeight', 'scrollY'];
  const saved = Object.fromEntries(names.map(n => [n, global[n]]));
  const timeouts = []; let data = snapshot(110);
  global.fetch = async url => ({ ok: true, json: async () => url.startsWith('data') ? data : { snapshot_id: 'one', series: {} } });
  global.setInterval = () => 0; global.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; }; global.clearTimeout = () => {};
  global.addEventListener = () => {}; global.getComputedStyle = () => ({ getPropertyValue: name => name === '--notes-after-cards' ? '1' : '' });
  global.RaceLayout = null; global.RaceNotesReady = Promise.resolve(); global.sessionStorage = { getItem: () => null, removeItem() {} };
  const scrollCalls = []; const previousScrollIntoView = Node.prototype.scrollIntoView;
  global.scrollTo = (...args) => scrollCalls.push(['scrollTo', ...args]);
  global.scrollBy = (...args) => scrollCalls.push(['scrollBy', ...args]);
  Node.prototype.scrollIntoView = (...args) => scrollCalls.push(['scrollIntoView', ...args]);
  const p = page();
  return Promise.resolve().then(() => run({ ...p, timeouts, scrollCalls, setData: value => { data = value; } })).finally(() => { Node.prototype.scrollIntoView = previousScrollIntoView; for (const n of names) global[n] = saved[n]; });
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('real refresh preserves cards and notes, updates equity and never forces scrolling', async () => withPage(async p => {
  const notes = p.doc.nodes['notes-a']; const marker = p.doc.createElement('article'); notes.append(marker);
  const controller = dashboard.start(p.doc); await settle();
  const panel = p.doc.nodes.cards.children[0], card = panel.children[0], parent = notes.parentNode;
  assert.match(card.textContent, /110\.00/);
  p.setData(snapshot(125)); await controller.refresh();
  assert.equal(p.doc.nodes.cards.children[0], panel); assert.equal(panel.children[0], card);
  assert.equal(p.doc.nodes['notes-a'], notes); assert.equal(notes.parentNode, parent); assert.equal(notes.firstChild, marker); assert.match(card.textContent, /125\.00/);
  assert.deepEqual(p.scrollCalls, []);
}));

test('initial content remains hidden until asynchronous sections are ready', async () => withPage(async p => {
  let release; global.RaceNotesReady = new Promise(resolve => { release = resolve; });
  dashboard.start(p.doc); await settle(); assert.equal(p.wrap.classList.contains('is-loading'), true);
  release(); await settle(); assert.equal(p.wrap.classList.contains('is-loading'), false);
}));

test('startup restores only after async reveal and later refreshes stay scroll-free', async () => withPage(async p => {
  let release, saved = JSON.stringify({ y: 500, id: 'positions', offset: -20 });
  const frames = [];
  global.RaceNotesReady = new Promise(resolve => { release = resolve; });
  global.sessionStorage = { getItem: () => saved, removeItem: () => { saved = null; } };
  global.requestAnimationFrame = fn => frames.push(fn);
  global.history = { scrollRestoration: 'auto' }; global.innerHeight = 100; global.scrollY = 0;
  p.doc.documentElement = { scrollHeight: 200 };
  const positions = p.doc.add('positions', 'div', p.wrap);
  positions.getBoundingClientRect = () => ({ top: 480 });
  const controller = dashboard.start(p.doc); await settle();
  assert.equal(global.history.scrollRestoration, 'manual');
  assert.equal(frames.length, 0); assert.notEqual(saved, null);
  release(); await settle();
  assert.equal(p.wrap.classList.contains('is-loading'), false);
  assert.deepEqual(p.scrollCalls, []);
  p.doc.documentElement.scrollHeight = 600;
  p.timeouts.find(timer => timer.ms === 50).fn();
  assert.deepEqual(p.scrollCalls, [['scrollTo', 0, 500]]); assert.equal(saved, null);
  assert.equal(global.history.scrollRestoration, 'auto');
  p.setData(snapshot(125)); await controller.refresh();
  assert.deepEqual(p.scrollCalls, [['scrollTo', 0, 500]]);
}));

test('chip clicks render immediately after interaction and retain and clear height', async () => withPage(async p => {
  dashboard.start(p.doc); await settle();
  assert.match(p.rows.textContent, /BTC/);
  p.doc.dispatchEvent({ type: 'pointerdown' });
  p.filters.dispatchEvent({ type: 'click', target: p.button });
  assert.equal(p.button.getAttribute('aria-pressed'), 'true'); assert.equal(p.ledger.style.minHeight, '500px');
  assert.match(p.rows.textContent, /ETH/); assert.doesNotMatch(p.rows.textContent, /BTC/);
  p.filters.dispatchEvent({ type: 'click', target: p.button });
  assert.equal(p.ledger.style.minHeight, ''); assert.equal(p.button.getAttribute('aria-pressed'), 'false'); assert.match(p.rows.textContent, /BTC/);
}));

test('scheduler isolates exceptions, immediate renders supersede queued work, and captures inner scrolling', () => {
  let now = 1000, timer; const doc = new Document(), logs = [], saved = console.error;
  console.error = error => logs.push(error.message);
  try {
    const schedule = dashboard.createRenderScheduler(doc, { now: () => now, setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {} });
    assert.equal(doc.listeners.scroll[0].options.capture, true); assert.equal(doc.listeners.scroll[0].options.passive, true);
    doc.listeners.scroll[0].fn({ target: new Node('inner') });
    const key = {}, output = []; schedule(key, () => output.push('stale')); schedule({}, () => { throw Error('broken'); }); schedule({}, () => output.push('revealed'));
    schedule.now(key, () => output.push('tap')); assert.deepEqual(output, ['tap']);
    now += 2000; timer(); assert.deepEqual(output, ['tap', 'revealed']); assert.deepEqual(logs, ['broken']);
  } finally { console.error = saved; }
});

test('position updates retain existing rows and insert only new keyed positions', () => {
  const doc = new Document(), container = doc.add('positions');
  const pos = { inst: 'ETH', side: 'long', size: 1, averagePrice: 2, upl: 3 };
  const snap = positions => ({ traders: [{ name: 'Grok-Trader-A', currency: 'USDT', positions }, { name: 'Grok-Trader-B', positions: [] }] });
  layout.renderPositions(doc, container, snap([pos]));
  const block = container.children[0], row = block.querySelector('.layout-details');
  layout.renderPositions(doc, container, snap([{ ...pos, upl: 8 }, { ...pos, inst: 'BTC' }]));
  assert.equal(container.children[0], block); assert.equal(block.querySelectorAll('.layout-details')[0], row);
  assert.equal(block.querySelectorAll('.layout-details').length, 2); assert.match(row.textContent, /\+8/);
});


test('fallback reveals page even if startup throws', () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const wrap = new Node('div'); wrap.className = 'wrap is-loading';
  const events = {}, timers = [], scrolls = [];
  let saved = JSON.stringify({ y: 500, id: '' });
  const doc = { readyState: 'loading', visibilityState: 'visible', documentElement: { scrollHeight: 600 },
    addEventListener: (name, fn) => (events[name] ||= []).push(fn),
    removeEventListener: (name, fn) => { events[name] = (events[name] || []).filter(item => item !== fn); },
    getElementById() { throw Error('startup failed'); }, querySelector: () => wrap };
  const context = { document: doc, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimeout() {},
    setInterval() {}, console: { error() {} }, AbortController, Date, Event, Promise, TextEncoder,
    sessionStorage: { getItem: () => saved, removeItem: () => { saved = null; } },
    history: { scrollRestoration: 'auto' }, innerHeight: 100, scrollY: 0, scrollTo: (x, y) => scrolls.push([x, y]) };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../dashboard.js'), 'utf8'), context);
  events.DOMContentLoaded[0]();
  assert.equal(wrap.classList.contains('is-loading'), true);
  const restoreEvents = ['visibilitychange', 'touchstart', 'touchmove', 'wheel', 'scroll', 'pointerdown'];
  const listenerCounts = Object.fromEntries(restoreEvents.map(type => [type, events[type].length]));
  timers.find(timer => timer.ms === 15000).fn();
  assert.equal(wrap.classList.contains('is-loading'), false);
  assert.deepEqual(scrolls, [[0, 500]]); assert.equal(saved, null);
  assert.equal(context.history.scrollRestoration, 'auto');
  for (const type of restoreEvents) assert.equal(events[type].length, listenerCounts[type] - 1);
});

test('watchlist filter is immediate while a background render is deferred', async () => {
  const doc = new Document(); doc.add('positions'); doc.add('watchlist');
  let immediate = 0, defer = false; const queued = new Map(), previous = global.RaceStable;
  const stable = (key, fn) => defer ? queued.set(key, fn) : fn();
  stable.now = (key, fn) => { immediate++; queued.delete(key); fn(); }; global.RaceStable = stable;
  const item = { id: 'A-20261101-1400-ETH', trader: 'Grok-Trader-A', instrument: 'ETH-USDT-SWAP', direction: 'long', summary: 'BULLISH',
    detail: { reason: 'reason', plan: 'plan', invalidation: 'invalid' }, confidence: 70, created_ts: 1793510000, expires_ts: 1793520000, ref_price: 1, outcome: null };
  try {
    const controller = layout.mount(doc, { fetcher: async () => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ version: 1, items: [item] }) }),
      now: () => 1793511000000, setInterval() {}, setTimeout() {}, clearTimeout() {} });
    await controller.ready; assert.match(doc.nodes.watchlist.textContent, /BULLISH/); defer = true; controller.render();
    const button = doc.nodes.watchlist.querySelectorAll('button').find(node => node.textContent === '\u505a\u7a7a');
    button.dispatchEvent({ type: 'click' });
    assert.equal(immediate, 1); assert.doesNotMatch(doc.nodes.watchlist.textContent, /BULLISH/);
  } finally { global.RaceStable = previous; }
});

test('watchlist buttons keep their actions through three consecutive filters', () => {
  const doc = new Document(), container = doc.add('watchlist');
  const item = { trader: 'Grok-Trader-A', instrument: 'ETH-USDT-SWAP',
    detail: { reason: 'reason', plan: 'plan', invalidation: 'invalid' }, confidence: 70,
    created_ts: 1793510000, expires_ts: 1793520000, ref_price: 1, outcome: null };
  layout.renderWatchlist(doc, container, [
    { ...item, id: 'long', direction: 'long', summary: 'LONG ROW' },
    { ...item, id: 'short', direction: 'short', summary: 'SHORT ROW' }
  ], new Map(), 1793511000000);
  const block = container.children[0];
  for (const [label, longVisible, shortVisible] of [
    ['\u505a\u591a', true, false], ['\u5168\u90e8', true, true], ['\u505a\u7a7a', false, true]
  ]) {
    const button = block.querySelectorAll('button').find(node => node.textContent === label);
    button.dispatchEvent({ type: 'click' });
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(block.querySelectorAll('button').filter(node => node.getAttribute('aria-pressed') === 'true'), [button]);
    assert.equal(block.textContent.includes('LONG ROW'), longVisible);
    assert.equal(block.textContent.includes('SHORT ROW'), shortVisible);
  }
});

test('identical notes remain separate after repeated morphs', () => {
  const doc = new Document(), container = doc.add('notes');
  const note = { trader: 'Grok-Trader-A', ts: 1793510000, kind: 'daily', market_recap: 'recap',
    trade_review: 'review', watch_next: 'watch', strategy_adjustments: 'strategy' };
  for (let i = 0; i < 3; i++) {
    dashboard.notes.renderColumn(doc, container, 'Grok-Trader-A', [{ ...note }, { ...note }], 1793511000000);
    const cards = container.querySelectorAll('article');
    assert.equal(cards.length, 2);
    assert.notEqual(cards[0], cards[1]);
  }
});

test('morph uses a linear number of key reads for 600 trade-log rows', () => {
  const now = Date.parse('2026-11-02T00:30:00+08:00');
  function keyReads(count) {
    const doc = new Document(), old = doc.add('old'), fresh = doc.add('fresh');
    const trades = Array.from({ length: count }, (_, i) => ({ trader: 'Grok-Trader-A', timestamp: now + i,
      market: 'ETH', side: 'long', event: 'open', price: 1, qty: 1, pnl: null }));
    const state = () => ({ days: new Map(), rows: new Set() });
    dashboard.renderGroupedRows(doc, old, trades, 'all', state(), now);
    dashboard.renderGroupedRows(doc, fresh, trades, 'all', state(), now);
    const getAttribute = Node.prototype.getAttribute; let reads = 0;
    Node.prototype.getAttribute = function (name) { if (name === 'data-morph-key') reads++; return getAttribute.call(this, name); };
    try { dashboard.morph(old, [...fresh.childNodes]); } finally { Node.prototype.getAttribute = getAttribute; }
    assert.equal(old.querySelectorAll('.ledger-trade').length, count);
    return reads;
  }
  const small = keyReads(300), large = keyReads(600);
  assert.ok(large <= small * 2.1, `key reads: ${small} / ${large}`);
});

test('unkeyed nodes are reused by position even when their classes change', () => {
  const doc = new Document(), parent = doc.add('parent');
  const first = doc.createElement('button'), second = doc.createElement('button');
  first.className = 'active'; parent.append(first, second);
  const newFirst = doc.createElement('button'), newSecond = doc.createElement('button');
  newSecond.className = 'active';
  dashboard.morph(parent, [newFirst, newSecond]);
  assert.deepEqual(parent.children, [first, second]);
  assert.equal(first.className, ''); assert.equal(second.className, 'active');
});

test('a deferred tick crossing 24 hours survives a simultaneous snapshot refresh', async () => {
  const doc = new Document(); doc.add('positions'); doc.add('watchlist');
  let clock = 1800000000000, defer = false; const queued = new Map(), intervals = [], previous = global.RaceStable;
  global.RaceStable = (key, fn) => defer ? queued.set(key, fn) : fn();
  try {
    const controller = layout.mount(doc, { fetcher: async () => ({ ok: false }), now: () => clock,
      setInterval: (fn, ms) => intervals.push({ fn, ms }), setTimeout() {}, clearTimeout() {} });
    await controller.ready;
    const snapshot = { traders: [{ name: 'Grok-Trader-A', positions: [] }, { name: 'Grok-Trader-B', positions: [] }],
      trades: [{ trader: 'Grok-Trader-A', event: 'open', timestamp: clock - 86400000 + 1000, market: 'ETH', side: 'long' }] };
    controller.updateSnapshot(snapshot); assert.match(doc.nodes.positions.textContent, /ETH/);
    defer = true; clock += 2000; intervals.find(item => item.ms === 60000).fn(); controller.updateSnapshot(snapshot);
    defer = false; for (const fn of [...queued.values()]) fn();
    assert.doesNotMatch(doc.nodes.positions.textContent, /ETH/);
  } finally { global.RaceStable = previous; }
});


test('phone chips wrap without a separate horizontal scrollbar and keep 40px targets', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /\.filter-bar\{flex-wrap:wrap\}/);
  assert.match(html, /\.filter-bar button\{[^}]*min-height:40px/);
  assert.doesNotMatch(html, /\.filter-bar\{[^}]*overflow-x:auto/);
});

test('filter session records later height growth before another shrink', async () => withPage(async p => {
  const previous = global.ResizeObserver; let resize;
  global.ResizeObserver = class { constructor(fn) { resize = fn; } observe() {} };
  try {
    dashboard.start(p.doc); await settle();
    p.filters.dispatchEvent({ type: 'click', target: p.button });
    p.ledger.height = 800; resize(); assert.equal(p.ledger.style.minHeight, '800px');
    p.ledger.height = 500; resize(); assert.equal(p.ledger.style.minHeight, '800px');
    p.filters.dispatchEvent({ type: 'click', target: p.button }); assert.equal(p.ledger.style.minHeight, '');
  } finally { global.ResizeObserver = previous; }
}));
