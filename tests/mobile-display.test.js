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

test('refresh keeps the container height and restores the visible element offset', () => {
  const saved = { scrollTo: global.scrollTo, scrollX: global.scrollX, scrollY: global.scrollY, innerWidth: global.innerWidth };
  try {
    let scroll;
    global.scrollX = 0; global.scrollY = 500; global.innerWidth = 400;
    global.scrollTo = (x, y) => { scroll = [x, y]; };
    const doc = { elementFromPoint: () => container.children[0] };
    const container = { ownerDocument: doc, style: { minHeight: '' }, children: [], isConnected: true,
      getBoundingClientRect: () => ({ height: 200, top: -50 }), contains: node => container.children.includes(node) };
    const child = top => ({ parentElement: container, children: [], isConnected: true, getBoundingClientRect: () => ({ top }) });
    container.children = [child(-20)];
    dashboard.stableRender(container, () => {
      assert.equal(container.style.minHeight, '200px');
      container.children = [child(30)];
    });
    assert.equal(container.style.minHeight, '');
    assert.deepEqual(scroll, [0, 550]);
  } finally { Object.assign(global, saved); }
});
