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
  assert.equal(grouped[0].fees, '-0.08 USDT');
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
  assert.match(group.fees, /0.0001 BTC/);
  assert.match(group.fees, /-0.1 USDT/);
  assert.match(group.fees, /資料不完整/);
  assert.equal(dashboard.groupTrades([trade({ pnl: null })], 'trader')[0].pnl, '—（資料不完整）');
});

test('all mode preserves the original eight columns and reverse chronological order', () => {
  const container = new TextNode('tbody');
  const original = new TextNode('tbody');
  const trades = [trade({ note: '較舊' }), trade({ note: '較新' })];
  dashboard.renderRows(doc, original, trades);
  dashboard.renderGroupedRows(doc, container, trades, 'all');
  assert.equal(container.textContent, original.textContent);
  assert.equal(container.children[0].children.length, 8);
  assert.equal(container.children[0].children.at(-1).textContent, '較新');
  assert.equal(nodes(container).filter(node => node.tagName === 'button').length, 0);
});

test('group button expands fills, reports totals and retains expansion on refresh or mode changes', () => {
  const container = new TextNode('tbody');
  const opened = new Set();
  const trades = [trade(), trade({ pnl: 3 })];
  dashboard.renderGroupedRows(doc, container, trades, 'trader', opened);
  let button = nodes(container).find(node => node.tagName === 'button');
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.match(button.textContent, /2 筆・合計損益 \+5 USDT・合計手續費 -0.2 USDT/);
  assert.ok(container.children.slice(1).every(line => line.hidden));
  button.click();
  assert.equal(button.attributes['aria-expanded'], 'true');
  assert.ok(container.children.slice(1).every(line => !line.hidden));
  dashboard.renderGroupedRows(doc, container, trades, 'market', opened);
  assert.equal(nodes(container).find(node => node.tagName === 'button').attributes['aria-expanded'], 'false');
  dashboard.renderGroupedRows(doc, container, trades.concat(trade()), 'trader', opened);
  button = nodes(container).find(node => node.tagName === 'button');
  assert.equal(button.attributes['aria-expanded'], 'true');
  button.click();
  assert.equal(opened.size, 0);
});

test('empty grouping stays readable and untrusted group labels remain plain text', () => {
  const container = new TextNode('tbody');
  dashboard.renderGroupedRows(doc, container, [], 'trader');
  assert.match(container.textContent, /目前沒有可顯示的交易紀錄/);
  const attack = '<img src=x onerror=alert(1)>';
  dashboard.renderGroupedRows(doc, container, [trade({ trader: attack, note: attack })], 'trader');
  assert.ok(container.textContent.includes(attack));
  assert.equal(nodes(container).some(node => ['img', 'script'].includes(node.tagName)), false);
});


test('overflow in grouped finite monetary inputs is unavailable rather than Infinity', () => {
  const group = dashboard.groupTrades([trade({ pnl: 1e308, fee: -1e308 }), trade({ pnl: 1e308, fee: -1e308 })], 'trader')[0];
  assert.equal(group.pnl, '— USDT（資料不完整）');
  assert.equal(group.fees, '— USDT（資料不完整）');
});
