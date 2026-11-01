'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const layout = require('../layout-v4.js');

const sharedCases = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist-cases.json'), 'utf8'));
for (const fixture of sharedCases) {
  test(`shared watchlist validation: ${fixture.name}`, () => {
    const result = layout.normalizeWatchlist(fixture.document);
    if (fixture.valid) assert.equal(result.length, fixture.document.items.length);
    else assert.deepEqual(result, []);
  });
}

const now = Date.parse('2026-11-01T14:00:00+08:00');
const traderA = 'Grok-Trader-A';
const traderB = 'Grok-Trader-B';
const watch = (changes = {}) => ({
  id: 'A-20261101-1400-ETH', trader: traderA, instrument: 'ETH-USDT-SWAP', direction: 'long',
  summary: '回測支撐後觀察量能。', detail: { reason: '支撐守住。', plan: '等突破後分批。', invalidation: '跌破支撐離場。' },
  confidence: 70, created_ts: now / 1000 - 3600, expires_ts: now / 1000 + 3600,
  ref_price: 2500, outcome: null, ...changes
});
const open = (changes = {}) => ({
  trader: traderA, kind: 'open', instrument: 'ETH-USDT-SWAP', direction: 'long', ts: now / 1000 - 7200,
  reasons: { funding_rate: '費率低。', open_interest: '未平倉量增加。', key_levels: '支撐守住。', volume: '量能增加。', events: '未取得資料' },
  stop_loss: 2400, take_profit: 2700, invalidation: '跌破支撐離場。', confidence: '七成', ...changes
});
const position = (changes = {}) => ({
  inst: 'ETH-USDT-SWAP', side: 'long', size: 2, averagePrice: 2500, upl: 12,
  unit: '張', uplCurrency: 'USDT', ...changes
});
const snapshot = (changes = {}) => ({ traders: [
  { name: traderA, currency: 'USDT', positions: [position()] },
  { name: traderB, currency: 'USDT', positions: [] }
], ...changes });
const documentOf = items => ({ version: 1, items });
const response = value => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) });

function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node, selector) {
  const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector);
  if (attribute) {
    const [_, name, value] = attribute;
    const actual = name.startsWith('data-')
      ? node.dataset[name.slice(5).replace(/-([a-z])/g, (all, char) => char.toUpperCase())]
      : node.attributes[name];
    return value === undefined ? actual !== undefined : actual === value;
  }
  if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
  if (selector.includes('.')) {
    const [tag, className] = selector.split('.');
    return node.tagName === tag && node.className.split(' ').includes(className);
  }
  return node.tagName === selector;
}
class TextNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.className = ''; this.dataset = {}; this.attributes = {};
    this.text = ''; this.open = false; this.listeners = {}; this.style = {};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML parsing is forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners[event.type] || []) listener(event);
    if (typeof this['on' + event.type] === 'function') this['on' + event.type](event);
  }
  click() { this.dispatchEvent({ type: 'click', preventDefault() {} }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
}
function makeDocument() {
  const nodes = { positions: new TextNode('section'), watchlist: new TextNode('section') };
  const listeners = {};
  return {
    nodes, listeners, hidden: false,
    createElement: tag => new TextNode(tag),
    createDocumentFragment: () => new TextNode('fragment'),
    getElementById: id => nodes[id] || null,
    addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener); }
  };
}
function options(fetcher, clock = () => now) {
  const intervals = [], timeouts = [], cleared = [];
  return {
    fetcher, now: clock, intervals, timeouts, cleared,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    setTimeout: (callback, ms) => { timeouts.push({ callback, ms }); return timeouts.length; },
    clearTimeout: id => cleared.push(id)
  };
}

test('watchlist accepts the documented dated ID and preserves the input', () => {
  const value = documentOf([watch()]);
  const before = JSON.stringify(value);
  assert.equal(layout.normalizeWatchlist(value).length, 1);
  assert.equal(JSON.stringify(value), before);
});

test('watchlist accepts empty documents and optional explicit expiry', () => {
  assert.deepEqual(layout.normalizeWatchlist(documentOf([])), []);
  assert.equal(layout.normalizeWatchlist(documentOf([watch({ status: 'expired' })])).length, 1);
});

for (const [label, change] of [
  ['confidence below zero', { confidence: -1 }], ['confidence above one hundred', { confidence: 101 }],
  ['nonfinite confidence', { confidence: Infinity }], ['boolean confidence', { confidence: true }],
  ['invalid trader', { trader: 'Other' }], ['invalid direction', { direction: 'up' }],
  ['expiry before creation', { expires_ts: now / 1000 - 7200 }],
  ['nonpositive reference price', { ref_price: 0 }], ['unknown status', { status: 'closed' }],
  ['summary over sixty codepoints', { summary: '觀'.repeat(61) }],
  ['unexpected field', { extra: 'unexpected' }], ['missing detail field', { detail: { reason: '理由', plan: '計畫' } }],
  ['sensitive narrative', { detail: { reason: 'token: TEST_ONLY', plan: '等量', invalidation: '跌破' } }],
  ['sensitive symbol', { instrument: 'token:TEST_ONLY' }]
]) {
  test('watchlist rejects ' + label, () => assert.deepEqual(layout.normalizeWatchlist(documentOf([watch(change)])), []));
}

test('watchlist rejects duplicate IDs and unknown document keys', () => {
  assert.deepEqual(layout.normalizeWatchlist(documentOf([watch(), watch()])), []);
  assert.deepEqual(layout.normalizeWatchlist({ ...documentOf([watch()]), extra: 1 }), []);
});

test('watchlist accepts display-only outcomes but rejects invalid verdicts and long reviews', () => {
  const outcome = { price_at_expiry: 2550, change_pct: 2, verdict: 'hit', review: '符合當時觀察。' };
  assert.equal(layout.normalizeWatchlist(documentOf([watch({ outcome })])).length, 1);
  assert.deepEqual(layout.normalizeWatchlist(documentOf([watch({ outcome: { ...outcome, verdict: 'win' } })])), []);
  assert.deepEqual(layout.normalizeWatchlist(documentOf([watch({ outcome: { ...outcome, review: '觀'.repeat(301) } })])), []);
});

test('dated public IDs do not exempt invalid dates, invalid clocks or long numeric suffixes', () => {
  for (const id of ['A-20260230-1400-ETH', 'A-20261101-2400-ETH', 'A-20261101-1460-ETH',
    'A-20261101-1400-12345678', 'A-20261101-1400-' + 'x'.repeat(32)]) {
    assert.deepEqual(layout.normalizeWatchlist(documentOf([watch({ id })])), []);
  }
});

test('separate ordinary narrative fields are not concatenated into a false sensitive token', () => {
  const item = watch({ summary: 'support-level-alpha-one', detail: {
    reason: 'volume-trend-beta-two', plan: 'wait-for-breakout', invalidation: 'close-below-support'
  } });
  assert.equal(layout.normalizeWatchlist(documentOf([item])).length, 1);
});

test('JSON parser rejects duplicate decoded keys and overflowing numeric values', () => {
  assert.throws(() => layout.parseWatchlistJSON('{"version":1,"items":[],"\\u0069tems":[]}'));
  assert.throws(() => layout.parseWatchlistJSON('{"version":1,"items":[],"overflow":1e999}'));
});

test('latest position explanation matches trader and instrument and selects latest open', () => {
  const newest = open({ ts: now / 1000 - 30 });
  const other = [open(), open({ trader: traderB, ts: now / 1000 }),
    open({ instrument: 'BTC-USDT-SWAP', ts: now / 1000 }),
    open({ kind: 'close', ts: now / 1000 }), newest];
  assert.equal(layout.latestOpen(other, traderA, 'ETH-USDT-SWAP'), newest);
  assert.equal(layout.latestOpen(other, traderA, 'SOL-USDT-SWAP'), null);
});

test('position summary prefers key levels, skips unavailable reasons and clips by codepoint', () => {
  assert.equal(layout.reasonSummary(open()), '支撐守住。');
  const fallback = open({ reasons: { key_levels: '未取得資料', funding_rate: '未取得資料', volume: '有效量能' } });
  assert.equal(layout.reasonSummary(fallback), '有效量能');
  assert.equal(layout.reasonSummary(null), '尚無說明');
  assert.ok(Array.from(layout.reasonSummary(open({ reasons: { key_levels: '觀'.repeat(100) } }))).length <= 61);
});

test('positions render A and B as separate blocks with collapsed details and honest missing market fields', () => {
  const doc = makeDocument();
  const node = doc.nodes.positions;
  layout.renderPositions(doc, node, snapshot(), [open()], now);
  assert.ok(node.textContent.includes(traderA));
  assert.ok(node.textContent.includes(traderB));
  assert.ok(node.textContent.includes('空手'));
  assert.ok(node.textContent.includes('支撐守住。'));
  assert.ok(node.textContent.includes('2400'));
  assert.ok(node.textContent.includes('2700'));
  assert.ok(node.textContent.includes('未提供'));
  assert.ok(node.querySelectorAll('details').length >= 1);
  assert.equal(node.querySelectorAll('details').every(detail => !detail.open), true);
});

test('positions show no-explanation fallback and render markup only as text', () => {
  const doc = makeDocument();
  const attack = '<img src=x onerror=alert(1)>';
  layout.renderPositions(doc, doc.nodes.positions, snapshot({ traders: [
    { name: traderA, currency: 'USDT', positions: [position({ inst: attack })] },
    { name: traderB, currency: 'USDT', positions: [] }
  ] }), [], now);
  assert.ok(doc.nodes.positions.textContent.includes('尚無說明'));
  assert.ok(doc.nodes.positions.textContent.includes(attack));
  assert.equal(doc.nodes.positions.querySelectorAll('img').length, 0);
});

test('watchlist expiry uses strict now-greater-than boundary and explicit expired status', () => {
  const boundary = watch({ expires_ts: now / 1000 });
  const past = watch({ id: 'A-old-ETH', expires_ts: now / 1000 - 1 });
  const explicit = watch({ id: 'A-explicit-ETH', status: 'expired' });
  const split = layout.splitWatchlist([boundary, past, explicit], traderA, 'all', now);
  assert.deepEqual(split.active.map(item => item.id), [boundary.id]);
  assert.deepEqual(new Set(split.expired.map(item => item.id)), new Set([past.id, explicit.id]));
});

test('direction and confidence classification applies to active and expired observations', () => {
  const items = [watch(), watch({ id: 'A-short-ETH', direction: 'short', confidence: 90 }),
    watch({ id: 'A-expired-long', status: 'expired', confidence: 40 }),
    watch({ id: 'A-expired-short', status: 'expired', direction: 'short', confidence: 80 }),
    watch({ id: 'B-other-ETH', trader: traderB, confidence: 100 })];
  const longs = layout.splitWatchlist(items, traderA, 'long', now);
  assert.equal(longs.active.length, 1);
  assert.equal(longs.expired.length, 1);
  assert.equal([...longs.active, ...longs.expired].every(item => item.direction === 'long'), true);
  const shorts = layout.splitWatchlist(items, traderA, 'short', now);
  assert.equal(shorts.active.length, 1);
  assert.equal(shorts.expired.length, 1);
  const sorted = layout.splitWatchlist(items, traderA, 'confidence', now);
  assert.deepEqual(sorted.active.map(item => item.confidence), [90, 70]);
  assert.deepEqual(sorted.expired.map(item => item.confidence), [80, 40]);
});

test('watchlist renders confidence dots, the expired disclosure and all outcome verdicts', () => {
  const doc = makeDocument();
  const outcome = verdict => ({ price_at_expiry: 2550, change_pct: 2, verdict, review: '檢討文字。' });
  const items = [watch(), ...['hit', 'miss', 'unclear'].map((verdict, index) => watch({
    id: `A-expired-${index}`, status: 'expired', outcome: outcome(verdict)
  }))];
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, new Map(), now);
  const text = doc.nodes.watchlist.textContent;
  assert.ok(text.includes('70%'));
  assert.ok(/[●○]/u.test(text));
  assert.ok(text.includes('3 已過期的觀察'));
  assert.ok(text.includes('✔ 準'));
  assert.ok(text.includes('✘ 不準'));
  assert.ok(text.includes('無法判斷'));
  assert.ok(text.includes('檢討文字。'));
  assert.equal(doc.nodes.watchlist.querySelectorAll('details').every(detail => !detail.open), true);
  assert.ok(text.includes('尚無觀察'));
});

test('missing, empty or oversized watchlist responses are harmless empty observations', async () => {
  const responses = [
    { ok: false, status: 404 },
    { ok: true, headers: { get: () => null }, text: async () => '' },
    { ok: true, headers: { get: () => '1048577' }, text: async () => { throw new Error('must not read'); } }
  ];
  for (const item of responses) assert.deepEqual(await layout.fetchWatchlist(async () => item, undefined, 1), []);
});

test('mount loads only a local watchlist resource and independently accepts financial and note updates', async () => {
  const doc = makeDocument();
  const requests = [];
  const opts = options(async (url, config) => { requests.push({ url, config }); return response(documentOf([watch()])); });
  const controller = layout.mount(doc, opts);
  await controller.ready;
  controller.updateSnapshot(snapshot());
  controller.updateNotes([open()]);
  assert.ok(doc.nodes.positions.textContent.includes('支撐守住。'));
  assert.ok(doc.nodes.watchlist.textContent.includes('回測支撐後觀察量能。'));
  assert.ok(requests.length >= 1);
  assert.equal(requests.every(request => /^watchlist\.json\?v=/.test(request.url)), true);
  assert.equal(requests.every(request => request.config.cache === 'no-store'), true);
  assert.ok(opts.intervals.some(item => item.ms === 30000));
});

test('mount recovers after unavailable or malformed watchlist without breaking positions', async () => {
  const doc = makeDocument();
  let failed = true;
  const controller = layout.mount(doc, options(async () => {
    if (failed) throw new Error('offline');
    return response(documentOf([watch()]));
  }));
  await controller.ready;
  controller.updateSnapshot(snapshot());
  assert.ok(doc.nodes.positions.textContent.includes('ETH-USDT-SWAP'));
  assert.ok(doc.nodes.watchlist.textContent.includes('尚無觀察'));
  failed = false;
  await controller.refresh();
  assert.ok(doc.nodes.watchlist.textContent.includes('回測支撐後觀察量能。'));
});

test('watchlist classification buttons update both lists and retain the other trader selection', () => {
  const doc = makeDocument();
  const modes = new Map([[traderB, 'short']]);
  const items = [
    watch({ summary: '甲多方' }),
    watch({ id: 'A-short', direction: 'short', summary: '甲空方' }),
    watch({ id: 'A-old-long', status: 'expired', summary: '過期多方' }),
    watch({ id: 'A-old-short', status: 'expired', direction: 'short', summary: '過期空方' }),
    watch({ id: 'B-long', trader: traderB, summary: '乙多方' }),
    watch({ id: 'B-short', trader: traderB, direction: 'short', summary: '乙空方' })
  ];
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, modes, now);
  let a = doc.nodes.watchlist.children[0];
  const longButton = a.querySelectorAll('button').find(button => button.textContent === '做多');
  longButton.click();
  a = doc.nodes.watchlist.children[0];
  const b = doc.nodes.watchlist.children[1];
  assert.ok(a.textContent.includes('甲多方'));
  assert.ok(a.textContent.includes('過期多方'));
  assert.equal(a.textContent.includes('甲空方'), false);
  assert.equal(a.textContent.includes('過期空方'), false);
  assert.equal(modes.get(traderA), 'long');
  assert.equal(modes.get(traderB), 'short');
  assert.ok(b.textContent.includes('乙空方'));
  assert.equal(b.textContent.includes('乙多方'), false);
  assert.equal(a.querySelectorAll('button').find(button => button.textContent === '做多').getAttribute('aria-pressed'), 'true');
});

test('instrument grouping gives both active and expired lists their own symbol headings', () => {
  const doc = makeDocument();
  const items = [watch(), watch({ id: 'A-BTC', instrument: 'BTC-USDT-SWAP' }),
    watch({ id: 'A-old-ETH', status: 'expired' }),
    watch({ id: 'A-old-BTC', instrument: 'BTC-USDT-SWAP', status: 'expired' })];
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, new Map([[traderA, 'instrument']]), now);
  const headings = doc.nodes.watchlist.children[0].querySelectorAll('h4').map(node => node.textContent);
  assert.deepEqual(headings, ['BTC', 'ETH', 'BTC', 'ETH']);
});

test('instrument grouping combines the same base coin across quote currencies in both lists', () => {
  const doc = makeDocument();
  const items = [watch(), watch({ id: 'A-ETH-USD', instrument: 'ETH-USD-SWAP' }),
    watch({ id: 'A-old-ETH-USDT', status: 'expired' }),
    watch({ id: 'A-old-ETH-USD', instrument: 'ETH-USD-SWAP', status: 'expired' })];
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, new Map([[traderA, 'instrument']]), now);
  const a = doc.nodes.watchlist.children[0];
  assert.deepEqual(a.querySelectorAll('h4').map(node => node.textContent), ['ETH', 'ETH']);
  assert.ok(a.textContent.includes('ETH-USDT-SWAP'));
  assert.ok(a.textContent.includes('ETH-USD-SWAP'));
  assert.equal(a.querySelectorAll('.layout-details').length, 4);
});

test('watchlist row and expired-list expansion survives independent rerenders', () => {
  const doc = makeDocument();
  const modes = new Map();
  const items = [watch(), watch({ id: 'A-old', status: 'expired' })];
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, modes, now);
  const first = doc.nodes.watchlist.querySelectorAll('details');
  first[0].open = true;
  first[1].open = true;
  first[2].open = true;
  const openKeys = new Set(first.map(node => node.dataset.layoutKey));
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, modes, now + 1000);
  const after = doc.nodes.watchlist.querySelectorAll('details');
  assert.equal(after.every(node => node.open && openKeys.has(node.dataset.layoutKey)), true);
});

test('position expansion survives refresh and explanations remain isolated between traders', () => {
  const doc = makeDocument();
  const shared = snapshot({ traders: [
    { name: traderA, currency: 'USDT', positions: [position()] },
    { name: traderB, currency: 'USDT', positions: [position()] }
  ] });
  const notes = [open({ reasons: { key_levels: '甲方理由' } }), open({ trader: traderB, reasons: { key_levels: '乙方理由' } })];
  layout.renderPositions(doc, doc.nodes.positions, shared, notes, now);
  doc.nodes.positions.querySelectorAll('details')[0].open = true;
  layout.renderPositions(doc, doc.nodes.positions, shared, notes, now + 1000);
  assert.equal(doc.nodes.positions.querySelectorAll('details')[0].open, true);
  assert.equal(doc.nodes.positions.querySelectorAll('details')[1].open, false);
  assert.equal(doc.nodes.positions.children[0].textContent.includes('乙方理由'), false);
  assert.equal(doc.nodes.positions.children[1].textContent.includes('甲方理由'), false);
});

test('expired verdicts have the specified green, red and grey classes and missing outcome is neutral', () => {
  const doc = makeDocument();
  const items = ['hit', 'miss', 'unclear', null].map((verdict, index) => watch({
    id: `A-verdict-${index}`, status: 'expired',
    outcome: verdict ? { price_at_expiry: 2550, change_pct: 2, verdict, review: '' } : null
  }));
  layout.renderWatchlist(doc, doc.nodes.watchlist, items, new Map(), now);
  const all = descendants(doc.nodes.watchlist);
  assert.ok(all.some(node => node.textContent === '✔ 準' && node.className === 'pos'));
  assert.ok(all.some(node => node.textContent === '✘ 不準' && node.className === 'neg'));
  assert.ok(all.some(node => node.textContent === '– 無法判斷' && node.className === 'muted'));
  assert.ok(doc.nodes.watchlist.textContent.includes('尚無結果'));
});
