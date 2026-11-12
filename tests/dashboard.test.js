'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');
const fs = require('node:fs');
const path = require('node:path');

const now = Date.parse('2026-10-30T03:00:00+08:00');
const makeData = (overrides = {}) => ({
  snapshot_id: 'batch-1', source: 'own-okx-readonly', updated: now / 1000,
  traders: {
    'Grok-Trader-A': {
      equity: '120.50', start: '100', currency: 'USDT', updated: now / 1000,
      status: 'ok', positions: [], fees_total: '-0.30', funding_total: null, fills_total: null
    },
    'Grok-Trader-B': {
      equity: '80', start: null, currency: 'USDT', updated: now / 1000,
      status: 'ok', positions: [], fees_total: null, funding_total: null, fills_total: null
    }
  }, trades: [], ...overrides
});
const makeHistory = (overrides = {}) => ({
  snapshot_id: 'batch-1', series: {
    'Grok-Trader-A': [[now - 60000, 120], [now, 120.5]],
    'Grok-Trader-B': [[now, 80]]
  }, ...overrides
});

test('numeric strings are accepted but missing values are not converted to zero', () => {
  for (const missing of [null, undefined, '', ' ', false, {}, 'NaN', Infinity]) {
    assert.equal(dashboard.number(missing), null);
  }
  assert.equal(dashboard.number('0'), 0);
  const snapshot = dashboard.pairSnapshot(makeData(), makeHistory());
  assert.equal(snapshot.traders[0].equity, 120.5);
  assert.equal(dashboard.traderView(snapshot.traders[0], [], now).roiText, '+20.50%');
  assert.equal(dashboard.traderView(snapshot.traders[1], [], now).roiText, '—（本金未確認）');
});

test('a failed bot retains its previous balance, positions and timestamp, while the other bot updates', () => {
  const previous = dashboard.pairSnapshot(makeData(), makeHistory());
  const data = makeData({ snapshot_id: 'batch-2', updated: (now + 60000) / 1000 });
  data.traders['Grok-Trader-A'] = { status: 'error', equity: 0, updated: (now + 60000) / 1000, positions: [] };
  data.traders['Grok-Trader-B'].equity = '81.25';
  data.traders['Grok-Trader-B'].updated = (now + 60000) / 1000;
  const next = dashboard.pairSnapshot(data, makeHistory({ snapshot_id: 'batch-2', series: {
    'Grok-Trader-A': [], 'Grok-Trader-B': [[now + 60000, 81.25]]
  } }), previous);
  assert.equal(next.traders[0].equity, 120.5);
  assert.equal(next.traders[0].updated, now);
  assert.equal(next.traders[1].equity, 81.25);
  assert.equal(next.series[0].points.length, 2);
  assert.match(dashboard.freshness(next.traders[0], now + 60000).text, /失敗/);
  assert.equal(previous.traders[1].equity, 80);
});

test('unknown equity is never reconstructed from trade PNL or shown as a zero balance', () => {
  const data = makeData();
  data.traders['Grok-Trader-A'].equity = null;
  data.traders['Grok-Trader-A'].updated = null;
  data.trades = [{ trader: 'Grok-Trader-A', ts: now, pnl: 200 }];
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const view = dashboard.traderView(snapshot.traders[0], snapshot.trades, now);
  assert.equal(snapshot.traders[0].equity, null);
  assert.equal(view.roi, null);
  assert.equal(view.today, '—');
  assert.equal(view.total, '—（partial／待補齊）');
});

test('rejects mismatched batches, malformed values, foreign sources and legacy unversioned pairs', () => {
  assert.throws(() => dashboard.pairSnapshot(makeData(), makeHistory({ snapshot_id: 'batch-2' })), /same update/);
  assert.throws(() => dashboard.pairSnapshot(makeData(), { 'Grok-Trader-A': [] }), /same update/);
  assert.throws(() => dashboard.pairSnapshot(makeData(), makeHistory({ series: { 'Grok-Trader-A': [[now, 'bad']] } })), /history/);
  const data = makeData();
  delete data.snapshot_id;
  assert.throws(() => dashboard.pairSnapshot(data, makeHistory().series), /same update/);
  assert.throws(() => dashboard.pairSnapshot(makeData({ source: 'upstream-race' }), makeHistory()), /source/);
  const unlabelled = makeData();
  delete unlabelled.source;
  assert.throws(() => dashboard.pairSnapshot(unlabelled, makeHistory()), /source/);
  for (const id of ['', ' ', 1, null]) {
    assert.throws(() => dashboard.pairSnapshot(makeData({ snapshot_id: id }), makeHistory({ snapshot_id: id })), /same update/);
  }
});

test('recent window incompleteness never substitutes its counts for global totals', () => {
  const data = makeData({ trades: [
    { trader: 'Grok-Trader-A', ts: now - 60000 },
    { trader: 'Grok-Trader-A', ts: now - 2 * 3600000 }
  ] });
  data.traders['Grok-Trader-A'].fills_partial = true;
  data.traders['Grok-Trader-B'].fills_partial = true;
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const view = dashboard.traderView(snapshot.traders[0], snapshot.trades, now);
  assert.equal(view.total, '—（partial／待補齊）');
  assert.equal(view.today, '≥2');
  assert.equal(view.lastHour, '≥1');
  const emptyView = dashboard.traderView(snapshot.traders[1], snapshot.trades, now);
  assert.equal(emptyView.today, '≥0');
  assert.equal(emptyView.total, '—（partial／待補齊）');
  assert.equal(dashboard.traderView({ ...snapshot.traders[0], fillsTotal: 20 }, [], now).total, '≥20（partial／資料不完整）');
});

test('uses epoch ts before legacy Taiwan time and excludes future trades from counts', () => {
  const data = makeData({ trades: [
    { trader: 'Grok-Trader-A', ts: (now - 60000) / 1000, time: '2000-01-01 00:00:00' },
    { trader: 'Grok-Trader-A', time: '2026-10-30 02:30:00' },
    { trader: 'Grok-Trader-A', ts: now + 60000 }
  ] });
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const view = dashboard.traderView(snapshot.traders[0], snapshot.trades, now);
  assert.equal(view.lastHour, '2');
  assert.equal(view.today, '2');
  assert.equal(dashboard.timestamp('2026-10-30 03:00:00'), now);
  assert.equal(dashboard.timestamp('2026-10-29T19:00:00Z'), now);
});

test('freshness uses per-bot timestamps and detects expired or future-dated observations', () => {
  const trader = dashboard.pairSnapshot(makeData(), makeHistory()).traders[0];
  assert.equal(dashboard.freshness(trader, now).className, 'pos');
  assert.match(dashboard.freshness(trader, now + 900001).text, /過期/);
  assert.match(dashboard.freshness({ ...trader, updated: now + 120000 }, now).text, /異常/);
  assert.match(dashboard.freshness({ ...trader, updated: null }, now).text, /尚未/);
});

test('defaults to a 15-minute stale threshold and accepts bounded finite overrides', () => {
  const normal = dashboard.pairSnapshot(makeData(), makeHistory());
  assert.equal(normal.staleAfterMs, 900000);
  const configured = dashboard.pairSnapshot(makeData({ stale_after_seconds: 600 }), makeHistory());
  assert.equal(configured.staleAfterMs, 600000);
  assert.match(dashboard.freshness(configured.traders[0], now + 600001, configured.staleAfterMs).text, /過期/);
  for (const invalid of [0, -10, 3601, Infinity, 'bad']) {
    assert.equal(dashboard.pairSnapshot(makeData({ stale_after_seconds: invalid }), makeHistory()).staleAfterMs, 900000);
  }
});

// Minimal DOM sink: assignments to innerHTML would throw. Untrusted strings must
// only reach textContent, including account names, markets and position labels.
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

test('renders injection strings as text, signed fee rebates correctly, and unknown currency honestly', () => {
  const attack = '<img src=x onerror=alert(1)>';
  const data = makeData();
  data.traders = { [attack]: {
    equity: '100', start: null, updated: now / 1000, status: 'ok', fees_total: '0.123',
    positions: [{ inst: attack, side: 'long', sz: '2', avgPx: '1', upl: '3', qty_unit: '張', upl_ccy: 'USDT' }]
  } };
  data.trades = [{ trader: attack, ts: now, market: attack, note: attack, pnl: null }];
  const snapshot = dashboard.pairSnapshot(data, makeHistory({ series: { [attack]: [] } }));
  const card = dashboard.renderCard(documentSink, snapshot.traders[0], snapshot.trades, now);
  const container = new TextNode('tbody');
  dashboard.renderRows(documentSink, container, snapshot.trades);
  assert.ok(card.textContent.includes(attack));
  assert.ok(container.textContent.includes(attack));
  assert.equal(descendants(card).some(node => node.tagName === 'img' || node.tagName === 'script'), false);
  assert.ok(card.textContent.includes('幣別未提供'));
  assert.ok(descendants(card).some(node => node.textContent.includes('0.123') && node.className === 'pos'));
  assert.ok(card.textContent.includes('—（partial／待補齊）'));
});

test('renders each fill PNL in its own settlement currency and never assumes USDT', () => {
  const data = makeData({ trades: [
    { trader: 'Grok-Trader-A', ts: now - 2, pnl: 0, pnl_ccy: 'USDT' },
    { trader: 'Grok-Trader-A', ts: now - 1, pnl: 0.002, pnl_ccy: 'BTC' },
    { trader: 'Grok-Trader-B', ts: now, pnl: 5 }
  ] });
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const container = new TextNode('tbody');
  dashboard.renderRows(documentSink, container, snapshot.trades);
  const pnlCells = descendants(container).filter(node => node.tagName === 'td').map(node => node.textContent);
  assert.ok(pnlCells.includes('0.0000 USDT'));
  assert.ok(pnlCells.includes('0.0020 BTC'));
  assert.ok(pnlCells.includes('5.0000 幣別未提供'));
  assert.equal(pnlCells.includes('5.0000 USDT'), false);
});

test('a failed HTTP response or mixed pair cannot replace the previous snapshot', async () => {
  const previous = dashboard.pairSnapshot(makeData(), makeHistory());
  const before = JSON.stringify(previous);
  const failedFetcher = async url => ({ ok: !url.startsWith('history'), json: async () => makeData() });
  await assert.rejects(dashboard.fetchPair(failedFetcher, previous, undefined, 'test'), /HTTP/);
  const mixedFetcher = async url => ({ ok: true, json: async () => url.startsWith('data')
    ? makeData() : makeHistory({ snapshot_id: 'another-batch' }) });
  await assert.rejects(dashboard.fetchPair(mixedFetcher, previous, undefined, 'test'), /same update/);
  assert.equal(JSON.stringify(previous), before);
});

test('global totals include their own start and update times and survive an empty recent table', () => {
  const data = makeData();
  Object.assign(data.traders['Grok-Trader-A'], {
    totals_since: (now - 7 * 86400000) / 1000, totals_updated: (now - 30000) / 1000,
    totals_status: 'complete', fills_total: 120, fees_total: '-0.3', funding_total: '0.125',
    fills_total_partial: false, fees_total_partial: false, funding_total_partial: false,
    fills_partial: true
  });
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const trader = snapshot.traders[0];
  assert.equal(trader.totalsSince, now - 7 * 86400000);
  assert.equal(trader.totalsUpdated, now - 30000);
  assert.equal(dashboard.traderView(trader, [], now).total, '120');
  const card = dashboard.renderCard(documentSink, trader, [], now);
  const values = new Map(card.children.filter(node => node.className === 'row')
    .map(node => node.children.map(child => child.textContent)));
  assert.equal(values.get('全局累計總筆數'), '120');
  assert.equal(values.get('全局累計手續費'), '-0.300 USDT');
  assert.equal(values.get('全局累計資金費'), '0.125 USDT');
  assert.equal(values.get('累計資料'), 'complete／完整');
  assert.match(values.get('統計起點'), /2026\/10\/23.*台灣/);
  assert.match(values.get('累計更新'), /2026\/10\/30.*台灣/);
  assert.equal(card.textContent.includes('僅近期'), false);
});

test('global zero counts and signed amounts are rendered only from explicit values', () => {
  const data = makeData();
  Object.assign(data.traders['Grok-Trader-A'], {
    totals_since: now / 1000, totals_updated: now / 1000, totals_status: 'complete',
    fills_total: 0, fees_total: 0, funding_total: 0,
    fills_total_partial: false, fees_total_partial: false, funding_total_partial: false
  });
  const trader = dashboard.pairSnapshot(data, makeHistory()).traders[0];
  assert.equal(dashboard.traderView(trader, [], now).total, '0');
  const card = dashboard.renderCard(documentSink, trader, [], now);
  assert.equal(descendants(card).filter(node => node.tagName === 'span' && node.textContent === '0.000 USDT').length, 2);
  assert.equal(card.textContent.includes('partial'), false);
});

test('each cumulative field reports partial independently from recent pagination and other totals', () => {
  const data = makeData();
  Object.assign(data.traders['Grok-Trader-A'], {
    totals_since: now / 1000 - 86400, totals_updated: now / 1000, totals_status: 'partial',
    fills_total: 25, fees_total: '-0.02', funding_total: null,
    fills_total_partial: false, fees_total_partial: true, funding_total_partial: true,
    fills_partial: true
  });
  const trader = dashboard.pairSnapshot(data, makeHistory()).traders[0];
  assert.equal(dashboard.traderView(trader, [], now).total, '25');
  const card = dashboard.renderCard(documentSink, trader, [], now);
  const values = new Map(card.children.filter(node => node.className === 'row')
    .map(node => node.children.map(child => child.textContent)));
  assert.equal(values.get('全局累計手續費'), '-0.020 USDT（partial／資料不完整）');
  assert.equal(values.get('全局累計資金費'), '—（partial／待補齊）');
  assert.equal(values.get('累計資料'), 'partial／資料不完整');
  assert.equal(dashboard.traderView({ ...trader, fillsTotalPartial: true }, [], now).total,
    '≥25（partial／資料不完整）');
});

test('legacy snapshots and missing coverage metadata cannot claim complete global counts', () => {
  const data = makeData({ trades: [{ trader: 'Grok-Trader-A', ts: now }] });
  Object.assign(data.traders['Grok-Trader-A'], {
    fills_total: 99, fills_total_partial: false, fees_total_partial: false, funding_total_partial: false
  });
  const trader = dashboard.pairSnapshot(data, makeHistory()).traders[0];
  assert.equal(trader.fillsTotal, null);
  assert.equal(trader.feesTotalPartial, true);
  assert.equal(dashboard.traderView(trader, [], now).total, '—（partial／待補齊）');
  const card = dashboard.renderCard(documentSink, trader, [], now);
  assert.match(card.textContent, /-0\.300 USDT（partial／資料不完整）/);
  assert.match(card.textContent, /統計起點待確認/);
});

test('an account read failure preserves cumulative values and their last update timestamp', () => {
  const data = makeData();
  Object.assign(data.traders['Grok-Trader-A'], {
    totals_since: now / 1000 - 86400, totals_updated: now / 1000,
    totals_status: 'complete', fills_total: 4, fees_total: -0.04, funding_total: 0,
    fills_total_partial: false, fees_total_partial: false, funding_total_partial: false
  });
  const previous = dashboard.pairSnapshot(data, makeHistory());
  data.traders['Grok-Trader-A'] = { status: 'error', fills_total: 0, totals_updated: now / 1000 + 300 };
  const next = dashboard.pairSnapshot(data, makeHistory(), previous).traders[0];
  assert.equal(next.fillsTotal, 4);
  assert.equal(next.feesTotal, -0.04);
  assert.equal(next.fundingTotal, 0);
  assert.equal(next.totalsUpdated, now);
});

test('the top update line formats the snapshot time as MM/DD HH:mm in Asia/Taipei', () => {
  assert.equal(dashboard.shortTaipeiTime(Date.parse('2026-11-04T19:05:00+08:00')), '11/04 19:05');
  // 16:30 UTC is already 00:30 on the next day in Taipei: 24-hour clock, zero-padded.
  assert.equal(dashboard.shortTaipeiTime(Date.parse('2026-11-04T16:30:00Z')), '11/05 00:30');
  assert.equal(dashboard.shortTaipeiTime(Date.parse('2026-01-02T03:04:59+08:00')), '01/02 03:04');
});

test('the top update line turns red only when the snapshot is over 30 minutes old or has no time', () => {
  const line = {};
  dashboard.renderUpdated(line, now - 30 * 60000, now);
  assert.deepEqual([line.textContent, line.className], ['資料更新時間 10/30 02:30', 'data-updated']);
  dashboard.renderUpdated(line, now - 30 * 60000 - 1, now);
  assert.equal(line.className, 'data-updated neg');
  // Without generated_at the push time is unknown; the trader-based updated field is not a substitute.
  dashboard.renderUpdated(line, dashboard.pairSnapshot(makeData(), makeHistory()).generatedAt, now);
  assert.deepEqual([line.textContent, line.className], ['資料更新時間 —', 'data-updated neg']);
});

test('the top update line follows data.json generated_at, not the page-open time', () => {
  const line = {};
  const shown = generatedAt => {
    const snapshot = dashboard.pairSnapshot(makeData({ generated_at: generatedAt }), makeHistory());
    dashboard.renderUpdated(line, snapshot.generatedAt, now);
    return [line.textContent, line.className];
  };
  // The page opens at now (10/30 03:00), which is also updated in makeData; neither is shown.
  assert.deepEqual(shown('2026-10-30T02:48:00+08:00'), ['資料更新時間 10/30 02:48', 'data-updated']);
  // Editing generated_at and reloading changes the line; the collector's epoch seconds work too.
  assert.deepEqual(shown('2026-10-30T02:00:00+08:00'), ['資料更新時間 10/30 02:00', 'data-updated neg']);
  assert.deepEqual(shown((now - 60000) / 1000), ['資料更新時間 10/30 02:59', 'data-updated']);
});

test('notes shelf moves right after the trader cards in single-column layout and back below the ledger otherwise', () => {
  // .wrap children in index.html order, with only the sibling API placeNotesShelf uses.
  const wrap = [];
  let moves = 0;
  const block = id => ({
    id,
    get nextElementSibling() { return wrap[wrap.indexOf(this) + 1] || null; },
    after(node) {
      moves++;
      wrap.splice(wrap.indexOf(node), 1);
      wrap.splice(wrap.indexOf(this) + 1, 0, node);
    }
  });
  wrap.push(...['cards', 'positions', 'watchlist', 'chart', 'ledger', 'notes-shelf'].map(block));
  const [cards, ledger, shelf] = ['cards', 'ledger', 'notes-shelf'].map(id => wrap.find(node => node.id === id));
  const state = () => [wrap.map(node => node.id).join(' > '), moves];
  dashboard.placeNotesShelf(shelf, cards, ledger, false);
  assert.deepEqual(state(), ['cards > positions > watchlist > chart > ledger > notes-shelf', 0]);
  dashboard.placeNotesShelf(shelf, cards, ledger, true);
  // A second resize in the same layout must not re-insert the shelf.
  dashboard.placeNotesShelf(shelf, cards, ledger, true);
  assert.deepEqual(state(), ['cards > notes-shelf > positions > watchlist > chart > ledger', 1]);
  dashboard.placeNotesShelf(shelf, cards, ledger, false);
  assert.deepEqual(state(), ['cards > positions > watchlist > chart > ledger > notes-shelf', 2]);
});

test('index.html sets notes-after-cards only in the one-column rule and lists the notes shelf after the ledger', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const flagged = html.split('\n').filter(line => line.includes('--notes-after-cards'));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /^@media\(max-width:760px\)\{.*\.cards,\.notes-shelf\{grid-template-columns:1fr;/);
  // Multi-column layouts keep this static order: trader cards, ..., ledger, then the notes shelf.
  const [cards, ledger, shelf] = ['id="cards"', 'class="ledger-section"', 'id="notes-shelf"'].map(marker => html.indexOf(marker));
  assert.ok(cards >= 0 && cards < ledger && ledger < shelf);
  assert.match(html, /data-ledger-mode="A"[^>]*>1 號機（A0 回踩）<\/button>/);
  assert.match(html, /data-ledger-mode="B"[^>]*>2 號機（B0 突破）<\/button>/);
});

test('new account fields display separate trading PNL and AI costs for both traders', () => {
  const data = makeData();
  for (const [index, trader] of Object.values(data.traders).entries()) Object.assign(trader, {
    net_pnl_usdt: index ? -0.1234 : 0.25, net_after_api_usd: -10.5,
    api_cost_total_usd: index ? 0 : 10.51256, api_cost_gpt_usd: index ? 0 : 10.5,
    api_cost_claude_usd: index ? 0 : 0.01256, api_cost_updated: Date.parse('2026-11-04T16:05:06Z') / 1000,
    api_cost_note: '過時的淨損益說明', api_cost_is_account_debit: index ? true : false, fees_total: index ? -0.2 : -0.3,
    totals_since: now / 1000, totals_status: 'complete', fees_total_partial: false
  });
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  for (const [index, trader] of snapshot.traders.entries()) {
    const card = dashboard.renderCard(documentSink, trader, [], now);
    const values = new Map(card.children.filter(node => node.className === 'row')
      .map(node => node.children.map(child => child.textContent)));
    assert.equal(values.get('交易損益'), index ? '-0.1234 USDT' : '+0.2500 USDT');
    assert.equal(values.get('AI 花費（另計）'), index ? '0.0000 USD' : '10.5126 USD');
    assert.ok([...values.keys()].indexOf('交易損益') < [...values.keys()].indexOf('AI 花費（另計）'));
    assert.match(card.textContent, index ? /GPT 0\.0000 USD／Claude 0\.0000 USD/ : /GPT 10\.5000 USD／Claude 0\.0126 USD/);
    assert.match(card.textContent, /資料時間 2026\/11\/5.*00:05:06.*台灣/);
    assert.equal(card.textContent.includes('AI 額度的花費，不從交易帳戶扣'), !index);
    assert.doesNotMatch(card.textContent, /過時的淨損益說明|累計 API 花費/);
    assert.match(values.get('全局累計手續費'), /^-0\.[23]00 USDT/);
    assert.equal(card.children.find(node => node.className === 'settlement-summary'), undefined);
    assert.doesNotMatch(card.textContent, /未知|交易員填報|扣除 API 後淨損益|-10\.5 USDT/);
  }
  data.traders['Grok-Trader-A'].api_cost_total_usd = null;
  const missing = dashboard.renderCard(documentSink, dashboard.pairSnapshot(data, makeHistory()).traders[0], [], now);
  assert.ok(missing.textContent.includes('AI 花費（另計）—'));
  assert.equal(missing.children.some(node => node.className === 'settlement-summary'), false);
});

test('new opening counts override recent event counts and partial markers, including zero', () => {
  const data = makeData({ trades: Array.from({ length: 12 }, (_, i) => ({
    trader: 'Grok-Trader-A', ts: (now - i * 60000) / 1000, event: i % 2 ? 'close' : 'open'
  })) });
  Object.assign(data.traders['Grok-Trader-A'], { opened_today: 6, opened_last_hour: 0, opened_counted_at: now / 1000, fills_partial: true });
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const view = dashboard.traderView(snapshot.traders[0], snapshot.trades, now);
  assert.equal(view.today, '6');
  assert.equal(view.lastHour, '0');
  const card = dashboard.renderCard(documentSink, snapshot.traders[0], snapshot.trades, now);
  assert.match(card.textContent, /今日筆數6近 1 小時0/);
});

test('opening counts expire at Taipei midnight and require a valid epoch-seconds timestamp', () => {
  const midnight = Date.parse('2026-10-30T00:00:00+08:00');
  const data = makeData({ trades: [{ trader: 'Grok-Trader-A', ts: (midnight - 60000) / 1000 }] });
  const trader = data.traders['Grok-Trader-A'];
  Object.assign(trader, { opened_today: 9, opened_last_hour: 8, opened_counted_at: (midnight - 1000) / 1000 });
  let snapshot = dashboard.pairSnapshot(data, makeHistory());
  assert.equal(dashboard.traderView(snapshot.traders[0], snapshot.trades, midnight - 1).today, '9');
  assert.equal(dashboard.traderView(snapshot.traders[0], snapshot.trades, midnight).today, '0');
  assert.equal(dashboard.traderView(snapshot.traders[0], snapshot.trades, midnight).lastHour, '1');
  for (const invalid of [null, 'bad', 253402300800, midnight]) {
    trader.opened_counted_at = invalid;
    snapshot = dashboard.pairSnapshot(data, makeHistory());
    assert.equal(dashboard.traderView(snapshot.traders[0], snapshot.trades, midnight).today, '0');
  }
});

test('position card uses the position section precision and avoids missing-unit wording', () => {
  const data = makeData();
  Object.assign(data.traders['Grok-Trader-A'], { currency: null, positions: [
    { inst: 'ETH', side: 'long', sz: 1, avgPx: 2, upl: -0.12345678 }
  ] });
  const card = dashboard.renderCard(documentSink, dashboard.pairSnapshot(data, makeHistory()).traders[0], [], now);
  const line = card.children.find(node => node.className === 'row position-row');
  assert.equal(line.children[1].textContent, '-0.12345678 —');
  assert.doesNotMatch(line.textContent, /未提供|（—）/);
});

test('new ledger rows use Taipei labels, four decimals, close price and quantity, and a nonempty market', () => {
  const data = makeData({ trades: [{ trader: 'Grok-Trader-A', ts: now / 1000, time_label: '10/30 03:00:00',
    event: 'close', market: '', side: '平多', price: 123.45, qty: '2 張', pnl: -0.123456, pnl_ccy: 'USDT' }] });
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  const container = new TextNode('tbody');
  dashboard.renderRows(documentSink, container, snapshot.trades);
  const cells = descendants(container).filter(node => node.tagName === 'td').map(node => node.textContent);
  assert.deepEqual(cells.slice(0, 7), ['10/30 03:00:00', '1 號機（A0 回踩）', '—', '平多', '123.45', '2 張', '-0.1235 USDT']);
});

test('legacy account and ledger fields retain their existing fallback paths', () => {
  const data = makeData({ trades: [{ trader: 'Grok-Trader-A', ts: now / 1000, time: '2026-10-30 03:00:00', market: 'ETH-USDT-SWAP' }] });
  data.traders['Grok-Trader-A'].fills_partial = true;
  const snapshot = dashboard.pairSnapshot(data, makeHistory());
  assert.equal(dashboard.traderView(snapshot.traders[0], snapshot.trades, now).today, '≥1');
  const card = dashboard.renderCard(documentSink, snapshot.traders[0], snapshot.trades, now);
  assert.ok(card.children.some(node => node.className === 'settlement-summary'));
  const container = new TextNode('tbody');
  dashboard.renderRows(documentSink, container, snapshot.trades);
  assert.match(container.textContent, /03:00:00/);
});
