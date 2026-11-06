'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');
const now = Date.parse('2026-10-30T03:00:00+08:00');
const makeData = () => ({ snapshot_id: 'batch-1', source: 'own-okx-readonly', updated: now / 1000,
  traders: { 'Grok-Trader-A': { equity: 110, start: 100, updated: now / 1000, positions: [] } }, trades: [] });
const makeHistory = () => ({ snapshot_id: 'batch-1', series: {} });
class TextNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.text = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
const documentSink = { createElement: tag => new TextNode(tag), createDocumentFragment: () => new TextNode('#fragment') };
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('annualized return uses snapshot time, requires a day and marks short runs', () => {
  const data = makeData();
  const account = data.traders['Grok-Trader-A'];
  account.equity = 110;
  account.totals_since = now / 1000 - 365 * 86400;
  let trader = dashboard.pairSnapshot(data, makeHistory()).traders[0];
  assert.equal(dashboard.traderView(trader, []).annualText, '+10.0%');
  account.equity = 90;
  trader = dashboard.pairSnapshot(data, makeHistory()).traders[0];
  assert.equal(dashboard.traderView(trader, []).annualText, '-10.0%');
  account.equity = 200;
  account.totals_since = now / 1000 - 2 * 86400;
  trader = dashboard.pairSnapshot(data, makeHistory()).traders[0];
  const card = dashboard.renderCard(documentSink, trader, [], now);
  const annual = card.children.find(node => node.children[0]?.textContent === '年化報酬率');
  assert.equal(annual.children[1].textContent, '>+9999%');
  assert.equal(annual.children[1].className, 'muted');
  assert.match(card.textContent, /開賽 2 天，天數太短時僅供參考/);
  account.totals_since = now / 1000 - 100;
  assert.equal(dashboard.traderView(dashboard.pairSnapshot(data, makeHistory()).traders[0], []).annualText, '—');
  account.totals_since = null;
  assert.equal(dashboard.traderView(dashboard.pairSnapshot(data, makeHistory()).traders[0], []).annualText, '—');
});

test('prices use six significant digits in ledger rows', () => {
  assert.equal(dashboard.price(1.735390909), '1.73539');
  assert.equal(dashboard.price('0.001230000'), '0.00123');
  assert.equal(dashboard.price(null), '—');
  const container = new TextNode('tbody');
  dashboard.renderRows(documentSink, container, [{ trader: '', market: '', side: '', price: '1.735390909', qty: '', timestamp: null, time: '', pnl: null }]);
  assert.equal(descendants(container).filter(node => node.tagName === 'td')[4].textContent, '1.73539');
});

test('render waits for two seconds after the last interaction', () => {
  let now = 10000, timer, count = 0;
  const listeners = {};
  const doc = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const render = dashboard.createRenderScheduler(doc, { now: () => now,
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => {} });
  listeners.touchstart();
  render({}, () => count++);
  assert.equal(count, 0);
  now += 1500; listeners.scroll();
  now += 1999; timer();
  assert.equal(count, 0);
  now++; timer();
  assert.equal(count, 1);
});
