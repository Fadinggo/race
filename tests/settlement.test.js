'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notes = require('../dashboard.js').notes;

const now = Date.parse('2026-10-31T23:59:59+08:00');
const traderA = 'Grok-Trader-A';
const traderB = 'Grok-Trader-B';
const totals = (overrides = {}) => ({
  realized_pnl: 5, unrealized_pnl: -1, fees: -0.2, funding: 0.1,
  api_cost_by_model: { 'gpt-4.1-mini': 0.03, 'gpt-4o-mini': null },
  api_cost_total: null, net_after_costs: null, ...overrides
});
const settlement = (overrides = {}) => ({
  trader: traderA, ts: now / 1000, kind: 'daily_settlement', date: '2026-10-31',
  table: { ...totals(), cum: totals({ realized_pnl: 50, api_cost_total: 0.9, net_after_costs: 48.12 }) },
  ...overrides
});
const narrative = (overrides = {}) => ({
  trader: traderA, ts: now / 1000, kind: 'daily', market_view: '等待市場資訊。',
  current_approach: '保持觀察。', plan: '稍後再評估。', ...overrides
});
const documentOf = items => ({ version: 1, notes: items });
const response = value => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(value) });

class TextNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.text = '';
    this.open = false;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Settlement content must never be parsed as HTML'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  querySelector(selector) {
    return descendants(this).find(node => node.className.split(' ').includes(selector.slice(1))) || null;
  }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function makeSummary(trader) {
  const node = new TextNode('div');
  node.className = 'settlement-summary';
  node.dataset.trader = trader;
  return node;
}
function makeDocument() {
  const nodes = { 'notes-a': new TextNode('aside'), 'notes-b': new TextNode('aside') };
  const listeners = {};
  return {
    nodes, listeners, hidden: false, summaries: [makeSummary(traderA), makeSummary(traderB)],
    createElement: tag => new TextNode(tag),
    getElementById: id => nodes[id] || null,
    querySelectorAll(selector) { return selector === '.settlement-summary' ? this.summaries : []; },
    addEventListener(type, listener) { listeners[type] = listener; }
  };
}
function options(fetcher) {
  return { fetcher, now: () => now, setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {} };
}
function rows(node) {
  return descendants(node).filter(child => child.tagName === 'tr' && child.children[0]?.tagName === 'th')
    .map(row => row.children.map(cell => cell.textContent));
}
function summaryCells(node) {
  return Object.fromEntries(node.children.filter(child => child.className === 'row')
    .map(row => row.children.map(cell => cell.textContent)));
}

test('latest settlement uses reporting date rather than submission time and is pinned above newer prose', () => {
  const current = settlement({ ts: now / 1000 - 3600 });
  const lateOld = settlement({ date: '2026-10-30', ts: now / 1000 + 5 });
  const prose = Array.from({ length: 11 }, (_, i) => narrative({ ts: now / 1000 - i, plan: `筆記 ${i}` }));
  const items = [lateOld, ...prose, current];
  assert.equal(notes.latestSettlement(items, traderA), current);
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, items, now);
  const list = doc.nodes['notes-a'].querySelector('.notes-list');
  const visible = list.children.filter(node => node.tagName === 'article');
  assert.equal(visible.length, 10);
  assert.match(visible[0].textContent, /2026-10-31 今日戰果明細表/);
  assert.match(visible[1].textContent, /2026-10-30 今日戰果明細表/);
  assert.equal(list.querySelector('.notes-more').children[0].textContent, '看更多（3）');
  assert.deepEqual(items, [lateOld, ...prose, current], 'Choosing and pinning a settlement must not mutate the input');
});

test('settlement table renders daily and cumulative inputs without inventing a USD conversion or arithmetic', () => {
  const note = settlement({ table: {
    ...totals({ realized_pnl: 1, unrealized_pnl: 2, fees: -0.2, funding: -0.03,
      api_cost_by_model: { 'gpt-4.1-mini': 0.07 }, api_cost_total: 0.07, net_after_costs: 123.456 }),
    cum: totals({ realized_pnl: 50, unrealized_pnl: -3, fees: -0.4, funding: 0,
      api_cost_by_model: { 'gpt-4o-mini': null }, api_cost_total: null, net_after_costs: -7 })
  } });
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, [note], now);
  const tableRows = rows(doc.nodes['notes-a']);
  for (const expected of [
    ['已實現損益（USDT）', '1', '50'], ['未實現損益（USDT）', '2', '-3'],
    ['手續費（USDT）', '-0.2', '-0.4'], ['資金費（USDT）', '-0.03', '0'],
    ['API gpt-4.1-mini（USD）', '0.07', '未知'], ['API gpt-4o-mini（USD）', '未知', '未知'],
    ['API 花費合計（USD）', '0.07', '未知'], ['扣除所有成本後淨損益（USDT）', '123.456', '-7']
  ]) assert.ok(tableRows.some(row => JSON.stringify(row) === JSON.stringify(expected)), JSON.stringify(expected));
  assert.match(doc.nodes['notes-a'].textContent, /依 token 用量自記估算/);
  assert.match(doc.nodes['notes-a'].textContent, /不自行換匯或重算/);
});

test('absent model costs stay unknown even when model names match inherited object properties', () => {
  const models = Object.fromEntries([['toString', 0.1], ['constructor', null], ['__proto__', 0.2]]);
  const note = settlement({ table: { ...totals({ api_cost_by_model: {} }), cum: totals({ api_cost_by_model: models }) } });
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, [note], now);
  const modelRows = rows(doc.nodes['notes-a']).filter(row => row[0].startsWith('API '));
  assert.ok(modelRows.some(row => row.join('|') === 'API toString（USD）|未知|0.1'));
  assert.ok(modelRows.some(row => row.join('|') === 'API constructor（USD）|未知|未知'));
  assert.ok(modelRows.some(row => row.join('|') === 'API __proto__（USD）|未知|0.2'));
  assert.equal(doc.nodes['notes-a'].textContent.includes('[object Object]'), false);
  assert.equal(doc.nodes['notes-a'].textContent.includes('function'), false);
});

test('the latest unknown cumulative values replace older known values and do not leak between traders', () => {
  const unknown = totals(Object.fromEntries(['realized_pnl', 'unrealized_pnl', 'fees', 'funding', 'api_cost_total', 'net_after_costs']
    .map(field => [field, null])));
  unknown.api_cost_by_model = {};
  const older = settlement({ date: '2026-10-30', table: { ...totals(), cum: totals({ api_cost_total: 99, net_after_costs: 88 }) } });
  const current = settlement({ table: { ...unknown, cum: { ...unknown } } });
  const beta = settlement({ trader: traderB, table: { ...totals(), cum: totals({ api_cost_total: 0, net_after_costs: -2 }) } });
  const doc = makeDocument();
  notes.renderSummaries(doc, [older, current, beta], now);
  assert.deepEqual(summaryCells(doc.summaries[0]), { '累計 API 花費': '未知', '扣除 API 後淨損益': '未知' });
  assert.deepEqual(summaryCells(doc.summaries[1]), { '累計 API 花費': '0 USD', '扣除 API 後淨損益': '-2 USDT' });
  assert.match(doc.summaries[0].textContent, /2026-10-31/);
  assert.equal(doc.summaries[0].textContent.includes('99'), false);
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, [current], now);
  const dataCells = descendants(doc.nodes['notes-a']).filter(node => node.tagName === 'td');
  assert.equal(dataCells.length, 12);
  assert.ok(dataCells.every(cell => cell.textContent === '未知'));
});

test('settlement model markup remains text and unsafe model names withhold the entire settlement', () => {
  const markup = '<b>x</b>';
  const source = settlement({ table: { ...totals({ api_cost_by_model: { [markup]: 0.1 } }), cum: totals() } });
  const unsafe = settlement({ trader: traderB,
    table: { ...totals(), cum: totals({ api_cost_by_model: { 'token: FAKE_ONLY': 0.1 } }) } });
  const normalized = notes.normalizeDocument(documentOf([source, unsafe]));
  assert.deepEqual(normalized, [source]);
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, normalized, now);
  assert.ok(doc.nodes['notes-a'].textContent.includes(markup));
  assert.equal(descendants(doc.nodes['notes-a']).some(node => node.tagName === 'b'), false);
  notes.renderSummaries(doc, [unsafe], now);
  assert.equal(doc.summaries[1].textContent.includes('FAKE_ONLY'), false);
  assert.equal(summaryCells(doc.summaries[1])['累計 API 花費'], '未知');
});

test('settlement age markings follow the same strict 48-hour boundary in notes and financial summaries', () => {
  const source = settlement({ ts: now / 1000 - 48 * 3600 });
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, [source], now);
  notes.renderSummaries(doc, [source], now);
  assert.equal(doc.nodes['notes-a'].textContent.includes('已過時'), false);
  assert.equal(doc.summaries[0].textContent.includes('已過時'), false);
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, [source], now + 1);
  notes.renderSummaries(doc, [source], now + 1);
  assert.ok(doc.nodes['notes-a'].textContent.includes('已過時'));
  assert.ok(doc.summaries[0].textContent.includes('已過時'));
});

test('new financial cards receive existing settlement summaries without another notes fetch', async () => {
  const doc = makeDocument();
  let calls = 0;
  const source = settlement();
  const controller = notes.start(doc, options(async () => { calls++; return response(documentOf([source])); }));
  await controller.ready;
  assert.equal(summaryCells(doc.summaries[0])['累計 API 花費'], '0.9 USD');
  doc.summaries = [makeSummary(traderA), makeSummary(traderB)];
  doc.listeners['race:cards-updated']();
  assert.equal(summaryCells(doc.summaries[0])['扣除 API 後淨損益'], '48.12 USDT');
  assert.equal(summaryCells(doc.summaries[1])['扣除 API 後淨損益'], '未知');
  assert.equal(calls, 1);
});

test('missing or malformed refreshed notes clear old monetary summaries rather than retaining stale known amounts', async () => {
  for (const failedResponse of [{ ok: false }, response({ version: 1, notes: [settlement({ date: '2026-02-30' })] })]) {
    const doc = makeDocument();
    let current = response(documentOf([settlement()]));
    const controller = notes.start(doc, options(async () => current));
    await controller.ready;
    assert.equal(summaryCells(doc.summaries[0])['累計 API 花費'], '0.9 USD');
    current = failedResponse;
    await controller.refresh();
    assert.deepEqual(summaryCells(doc.summaries[0]), { '累計 API 花費': '未知', '扣除 API 後淨損益': '未知' });
    assert.match(doc.summaries[0].textContent, /尚無每日結算資料/);
    assert.match(doc.nodes['notes-a'].textContent, /目前沒有可顯示的便利貼/);
  }
});

test('a small supplied API expense stays nonzero when rendered on the trader card', () => {
  const source = settlement({ table: { ...totals(), cum: totals({ api_cost_total: 1e-12 }) } });
  const doc = makeDocument();
  notes.renderSummaries(doc, [source], now);
  assert.equal(summaryCells(doc.summaries[0])['累計 API 花費'], '1.000e-12 USD');
});

test('a legitimate long OpenAI model identifier is accepted and rendered as the full model row label', () => {
  const model = 'gpt-4o-mini-audio-preview-2024-12-17';
  const source = settlement({ table: {
    ...totals({ api_cost_by_model: { [model]: 0.02 } }),
    cum: totals({ api_cost_by_model: { [model]: 0.08 } })
  } });
  const normalized = notes.normalizeDocument(documentOf([source]));
  assert.deepEqual(normalized, [source]);
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, normalized, now);
  assert.ok(rows(doc.nodes['notes-a']).some(row =>
    row.join('|') === `API ${model}（USD）|0.02|0.08`));
});

test('OpenAI-like names cannot conceal a secret prefix or a long random model suffix', () => {
  for (const model of ['gpt-4o-sk-fake', 'gpt-4o-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']) {
    const source = settlement({ table: {
      ...totals({ api_cost_by_model: { [model]: 0.02 } }), cum: totals()
    } });
    assert.deepEqual(notes.normalizeDocument(documentOf([source])), []);
    const doc = makeDocument();
    notes.renderColumn(doc, doc.nodes['notes-a'], traderA, [source], now);
    assert.equal(descendants(doc.nodes['notes-a']).some(node => node.tagName === 'article'), false);
    assert.equal(doc.nodes['notes-a'].textContent.includes(model), false);
    notes.renderSummaries(doc, [source], now);
    assert.deepEqual(summaryCells(doc.summaries[0]), { '累計 API 花費': '未知', '扣除 API 後淨損益': '未知' });
  }
});

test('finite extreme money stays concise and signed in settlement tables and card summaries', () => {
  const source = settlement({ table: {
    ...totals({ realized_pnl: 1e308, unrealized_pnl: -1e308,
      api_cost_by_model: { 'gpt-4.1-mini': 1e308 }, api_cost_total: 1e308, net_after_costs: -1e308 }),
    cum: totals({ realized_pnl: -1e308, unrealized_pnl: 1e308,
      api_cost_by_model: { 'gpt-4.1-mini': 1e308 }, api_cost_total: 1e308, net_after_costs: -1e308 })
  } });
  const normalized = notes.normalizeDocument(documentOf([source]));
  assert.deepEqual(normalized, [source]);
  const doc = makeDocument();
  notes.renderColumn(doc, doc.nodes['notes-a'], traderA, normalized, now);
  const tableRows = rows(doc.nodes['notes-a']);
  assert.ok(tableRows.some(row => row.join('|') === '已實現損益（USDT）|1.000e+308|-1.000e+308'));
  assert.ok(tableRows.some(row => row.join('|') === '未實現損益（USDT）|-1.000e+308|1.000e+308'));
  assert.ok(tableRows.some(row => row.join('|') === 'API 花費合計（USD）|1.000e+308|1.000e+308'));
  const cells = descendants(doc.nodes['notes-a']).filter(node => node.tagName === 'td');
  assert.ok(cells.every(cell => cell.textContent.length < 24));
  notes.renderSummaries(doc, normalized, now);
  assert.deepEqual(summaryCells(doc.summaries[0]), {
    '累計 API 花費': '1.000e+308 USD', '扣除 API 後淨損益': '-1.000e+308 USDT'
  });
});
