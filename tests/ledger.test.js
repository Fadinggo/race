'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');

class TextNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.text = '';
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.children.push(...node.children);
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { this.listeners.click(); }
}
const doc = { createElement: tag => new TextNode(tag), createDocumentFragment: () => new TextNode('#fragment') };
const nodes = node => [node, ...node.children.flatMap(nodes)];
const trade = (overrides = {}) => ({
  trader: 'Grok-Trader-A', market: 'ETH-USDT-SWAP', side: '開多', price: '100', qty: '1 張',
  timestamp: Date.parse('2026-11-01T06:00:00Z'), time: '', pnl: 2, pnlCurrency: 'USDT',
  fee: -0.1, feeCurrency: 'USDT', note: '說明', ...overrides
});

test('trade normalization retains fees and fee currency without assuming missing values are zero', () => {
  const snapshot = dashboard.pairSnapshot({
    snapshot_id: 'fixture', source: 'own-okx-readonly', traders: { 'Grok-Trader-A': {} },
    trades: [
      { trader: 'Grok-Trader-A', fee: '-0.012', feeCcy: 'BTC' },
      { trader: 'Grok-Trader-A' }
    ]
  }, { snapshot_id: 'fixture', series: {} });
  assert.equal(snapshot.trades[0].fee, -0.012);
  assert.equal(snapshot.trades[0].feeCurrency, 'BTC');
  assert.equal(snapshot.trades[1].fee, null);
  assert.equal(snapshot.trades[1].feeCurrency, null);
});

test('trader grouping sums fees and PNL with newest group first and never mutates input', () => {
  const trades = [trade(), trade({ trader: 'Grok-Trader-B', pnl: -3 }), trade({ pnl: 4, fee: 0.02 })];
  const before = JSON.stringify(trades);
  const grouped = dashboard.groupTrades(trades, 'trader');
  assert.deepEqual(grouped.map(item => item.label), ['Grok-Trader-A', 'Grok-Trader-B']);
  assert.equal(grouped[0].trades.length, 2);
  assert.equal(grouped[0].pnl, '+6 USDT');
  assert.equal(grouped[0].fees, '+0.08 USDT');
  assert.equal(JSON.stringify(trades), before);
});

test('coin grouping combines one base coin across settlement markets but separates other coins', () => {
  const grouped = dashboard.groupTrades([
    trade(), trade({ market: 'BTC-USDT-SWAP' }), trade({ market: 'ETH-USDC-SWAP' })
  ], 'market');
  assert.deepEqual(grouped.map(item => [item.label, item.trades.length]), [['ETH', 2], ['BTC', 1]]);
});

test('open/close grouping recognizes normal closes and liquidations while preserving unknown actions', () => {
  const grouped = dashboard.groupTrades([
    trade({ side: '開空' }), trade({ side: '平空' }), trade({ side: '部分強平多' }),
    trade({ side: '減倉平空' }), trade({ side: '買入' })
  ], 'action');
  assert.deepEqual(grouped.map(item => [item.label, item.trades.length]), [['其他', 1], ['平倉', 3], ['開倉', 1]]);
});

test('normalized events group by action and side, with missing markets grouped together', () => {
  const snapshot = dashboard.pairSnapshot({
    snapshot_id: 'fixture', source: 'own-okx-readonly', traders: { 'Grok-Trader-A': {} },
    trades: [
      { trader: 'Grok-Trader-A', event: 'open', side: 'long', market: '' },
      { trader: 'Grok-Trader-A', event: 'close', side: 'short', market: '—' }
    ]
  }, { snapshot_id: 'fixture', series: {} });
  assert.deepEqual(dashboard.groupTrades(snapshot.trades, 'action').map(group => group.label), ['平倉 short', '開倉 long']);
  assert.deepEqual(dashboard.groupTrades(snapshot.trades, 'market').map(group => [group.label, group.trades.length]), [['幣種未提供', 2]]);
});

test('positive fee costs display negative totals and negative fees display rebates', () => {
  const groups = dashboard.groupTrades([trade({ fee: 0.3 }), trade({ trader: 'Grok-Trader-B', fee: -0.1 })], 'trader');
  assert.equal(groups[0].fees, '+0.1 USDT');
  assert.equal(groups[1].fees, '-0.3 USDT');
});

test('profit/loss grouping keeps break-even and unknown PNL distinct', () => {
  const grouped = dashboard.groupTrades([
    trade({ pnl: 0 }), trade({ pnl: 1 }), trade({ pnl: -1 }), trade({ pnl: null })
  ], 'result');
  assert.deepEqual(grouped.map(item => item.label), ['損益未提供', '賠', '賺', '持平']);
});

test('totals preserve mixed currency units and explicitly mark unknown amounts', () => {
  const group = dashboard.groupTrades([
    trade(), trade({ pnl: 0.002, pnlCurrency: 'BTC', fee: 0.0001, feeCurrency: 'BTC' }),
    trade({ pnl: null, fee: null }), trade({ pnl: 3, pnlCurrency: null, fee: 2, feeCurrency: null })
  ], 'trader')[0];
  assert.match(group.pnl, /0.002 BTC/);
  assert.match(group.pnl, /2 USDT/);
  assert.match(group.pnl, /資料不完整/);
  assert.match(group.fees, /-0.0001 BTC/);
  assert.match(group.fees, /\+0.1 USDT/);
  assert.match(group.fees, /資料不完整/);
  assert.equal(dashboard.groupTrades([trade({ pnl: null })], 'trader')[0].pnl, '—（資料不完整）');
});

test('overflow in grouped finite monetary inputs is unavailable rather than Infinity', () => {
  const group = dashboard.groupTrades([trade({ pnl: 1e308, fee: -1e308 }), trade({ pnl: 1e308, fee: -1e308 })], 'trader')[0];
  assert.equal(group.pnl, '— USDT（資料不完整）');
  assert.equal(group.fees, '— USDT（資料不完整）');
});

const state = () => ({ days: new Map(), rows: new Set() });
const dayGroups = container => container.children.filter(node => node.className === 'ledger-day');
const tradeRows = container => nodes(container).filter(node => node.className === 'ledger-trade');
const dayNow = Date.parse('2026-11-02T00:30:00+08:00');
const dayTrades = () => [
  trade({ timestamp: Date.parse('2026-11-01T23:59:59+08:00'), event: 'close', pnl: -3 }),
  trade({ timestamp: dayNow, event: 'close', pnl: 2, openReason: '<img src=x>', closeReason: 'close', note: 'long note' }),
  trade({ timestamp: dayNow + 1000, trader: 'Grok-Trader-B', event: 'close', pnl: -0.5 })
];

test('Taipei day folds show filtered counts and four-decimal USDT net; desktop opens only today', () => {
  const container = new TextNode('div');
  dashboard.renderGroupedRows(doc, container, dayTrades(), 'all', state(), dayNow, false);
  const groups = dayGroups(container);
  assert.deepEqual(groups.map(group => group.children[0].textContent), [
    '11/02（2 筆，淨 +1.5000 USDT）',     '11/01（1 筆，淨 -3.0000 USDT）'
  ]);
  assert.deepEqual(groups.map(group => group.open), [true, false]);
  assert.deepEqual(tradeRows(container)[1].children.map(cell => cell.textContent).slice(0, 2), ['00:30:00', 'A']);
  assert.equal(nodes(container).some(node => node.tagName === 'img'), false);
  dashboard.renderGroupedRows(doc, container, dayTrades(), 'all', state(), dayNow, true);
  assert.ok(dayGroups(container).every(group => !group.open));
});

test('default disclosure state follows the 600px media query', () => {
  const previous = global.matchMedia;
  try {
    for (const phone of [true, false]) {
      global.matchMedia = query => {
        assert.equal(query, '(max-width: 600px)');
        return { matches: phone };
      };
      const container = new TextNode('div');
      dashboard.renderGroupedRows(doc, container, dayTrades(), 'all', state(), dayNow);
      assert.deepEqual(dayGroups(container).map(group => group.open), [!phone, false]);
    }
  } finally { global.matchMedia = previous; }
});

test('compact rows expose seven columns and each row toggles only its own text', () => {
  const container = new TextNode('div');
  dashboard.renderGroupedRows(doc, container, dayTrades(), 'all', state(), dayNow, true);
  const rows = tradeRows(container);
  assert.ok(rows.every(row => row.children.length === 7));
  assert.deepEqual(nodes(container).filter(node => node.tagName === 'th').map(node => node.textContent).slice(0, 7),
    ['TIME', 'TRADER', 'MARKET', 'SIDE', 'PRICE', 'QTY', 'PNL']);
  const details = nodes(container).filter(node => node.className === 'ledger-trade-detail');
  assert.ok(details.every(detail => detail.hidden));
  rows[1].click();
  assert.equal(rows[1].attributes['aria-expanded'], 'true');
  assert.equal(details[1].hidden, false);
  assert.equal(details[0].hidden, true);
  assert.match(details[1].textContent, /開倉理由：<img src=x>/);
  assert.match(details[1].textContent, /平倉理由：close/);
  assert.match(details[1].textContent, /NOTE：long note/);
  rows[1].click();
  assert.equal(details[1].hidden, true);
  let prevented = false;
  rows[1].listeners.keydown({ key: ' ', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(details[1].hidden, false);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /\.ledger-trade\{height:36px/);
  assert.match(html, /text-overflow:ellipsis;white-space:nowrap/);
  assert.match(html, /\.ledger-section table\{[^}]*table-layout:fixed/);
});

test('chips filter within days and recalculate counts and totals', () => {
  const container = new TextNode('div');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/data-ledger-mode="([^"]+)"/g)].map(match => match[1]), ['all', 'A', 'B', 'profit', 'loss']);
  for (const [filter, expected] of [
    ['A', ['11/02（1 筆，淨 +2.0000 USDT）', '11/01（1 筆，淨 -3.0000 USDT）']],
    ['B', ['11/02（1 筆，淨 -0.5000 USDT）']],
    ['profit', ['11/02（1 筆，淨 +2.0000 USDT）']],
    ['loss', ['11/02（1 筆，淨 -0.5000 USDT）', '11/01（1 筆，淨 -3.0000 USDT）']]
  ]) {
    dashboard.renderGroupedRows(doc, container, dayTrades(), filter, state(), dayNow, true);
    assert.deepEqual(dayGroups(container).map(group => group.children[0].textContent), expected);
  }
});

test('open day and row survive changed snapshots and filtering; closed today stays closed', () => {
  const container = new TextNode('div');
  const saved = state();
  const trades = dayTrades();
  dashboard.renderGroupedRows(doc, container, trades, 'all', saved, dayNow, false);
  const groups = dayGroups(container);
  groups[0].open = false; groups[0].listeners.toggle();
  groups[1].open = true; groups[1].listeners.toggle();
  tradeRows(container)[2].click();
  dashboard.renderGroupedRows(doc, container, trades.concat(trade({ timestamp: dayNow + 2000 })), 'B', saved, dayNow, false);
  dashboard.renderGroupedRows(doc, container, trades.concat(trade({ timestamp: dayNow + 2000 })), 'all', saved, dayNow, false);
  assert.deepEqual(dayGroups(container).map(group => group.open), [false, true]);
  const rows = tradeRows(container);
  assert.equal(rows.at(-1).attributes['aria-expanded'], 'true');
  assert.equal(nodes(container).filter(node => node.className === 'ledger-trade-detail').at(-1).hidden, false);
});

test('day completeness ignores open rows and marks missing close PNL', () => {
  const container = new TextNode('div');
  dashboard.renderGroupedRows(doc, container, [
    trade({ timestamp: dayNow - 86400000, event: 'close', pnl: null }),
    trade({ timestamp: dayNow, event: 'open', pnl: null }),
    trade({ timestamp: dayNow + 1000, event: 'close', pnl: 2 })
  ], 'all', state(), dayNow, false);
  assert.deepEqual(dayGroups(container).map(group => group.children[0].textContent), [
    '11/02（2 筆，淨 +2.0000 USDT）', '11/01（1 筆，淨 — USDT，資料不完整）'
  ]);
});

test('unknown currency is not added to the USDT day net', () => {
  const container = new TextNode('div');
  dashboard.renderGroupedRows(doc, container, [trade({ event: 'close', pnl: 5, pnlCurrency: 'BTC' })], 'all', state(), dayNow, false);
  assert.match(dayGroups(container)[0].children[0].textContent, /淨 — USDT/);
  assert.doesNotMatch(dayGroups(container)[0].children[0].textContent, /資料不完整/);
});
