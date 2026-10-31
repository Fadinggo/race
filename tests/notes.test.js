'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notes = require('../dashboard.js').notes;

const now = Date.parse('2026-10-31T04:20:02.598+08:00');
const makeNote = (overrides = {}) => ({
  trader: 'Grok-Trader-A', ts: now / 1000, kind: 'daily',
  market_recap: '市場波動偏高。', trade_review: '保持觀察。',
  watch_next: '等待訊號。', strategy_adjustments: '維持風控。', ...overrides
});
const reasons = () => ({
  funding_rate: '資金費率 0.01%，空方支付。', open_interest: '未平倉量增加 8%。',
  key_levels: '壓力 79000，支撐 76000。', volume: '近一小時量低於均量。', events: '今晚無重大數據。'
});
const makeOpen = (overrides = {}) => ({
  trader: 'Grok-Trader-A', ts: now / 1000, kind: 'open', instrument: 'BTC-USDT-SWAP', direction: 'short',
  leverage: 5, entry_price: 77818.8, stop_loss: 79000, take_profit: 75000, max_loss_usdt: 0.4,
  reasons: reasons(), confidence: '中高，約七成。', invalidation: '站回 79000 則觀點失效。', ...overrides
});
const makeClose = (overrides = {}) => {
  const { trader, ts, kind, ...review } = makeOpen();
  return {
    trader, ts, kind: 'close', review, realized_pnl_usdt: -0.06,
    variance: { right: '停損沒有被放大。', wrong: '進場太早。', lesson: '等未平倉量回落再進。' },
    ...overrides
  };
};
const documentOf = items => ({ version: 1, notes: items });
const response = value => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(value) });

// Any use of HTML parsing for note content fails these tests.
class TextNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.dataset = {}; this.text = ''; this.open = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML parsing is forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  querySelector(selector) { return descendants(this).find(node => node.className.split(' ').includes(selector.slice(1))) || null; }
  querySelectorAll(selector) { return descendants(this).filter(node => node.className.split(' ').includes(selector.slice(1))); }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function makeDocument() {
  const nodes = { 'notes-a': new TextNode('aside'), 'notes-b': new TextNode('aside'), financial: new TextNode('main') };
  const listeners = {};
  return {
    nodes, listeners, hidden: false,
    createElement: tag => new TextNode(tag),
    getElementById: id => nodes[id] || null,
    addEventListener: (type, listener) => { listeners[type] = listener; }
  };
}
function options(fetcher, clock = () => now) {
  const intervals = [];
  const timeouts = [];
  const cleared = [];
  return {
    fetcher, now: clock, intervals, timeouts, cleared,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    setTimeout: (callback, ms) => { timeouts.push({ callback, ms }); return timeouts.length; },
    clearTimeout: id => cleared.push(id)
  };
}
function column(doc, trader = 'Grok-Trader-A') { return doc.nodes[trader.endsWith('-A') ? 'notes-a' : 'notes-b']; }

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'notes-cases.json'), 'utf8'));
for (const fixture of cases) {
  test(`shared notes validation: ${fixture.name}`, () => {
    assert.equal(notes.normalizeDocument(fixture.document).length, fixture.visible_count);
  });
}

test('notes are sorted newest first, isolated by trader, and keep equal-time source order', () => {
  const source = [makeNote({ ts: now / 1000 - 5, watch_next: '最早' }),
    makeNote({ trader: 'Grok-Trader-B', watch_next: '乙' }),
    makeNote({ watch_next: '同時一' }), makeNote({ watch_next: '同時二' })];
  const before = JSON.stringify(source);
  const normalized = notes.normalizeDocument(documentOf(source));
  assert.equal(JSON.stringify(source), before);
  const doc = makeDocument();
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', normalized, now);
  const cards = descendants(column(doc)).filter(node => node.tagName === 'article');
  assert.equal(cards.length, 3);
  assert.ok(cards[0].textContent.includes('同時一'));
  assert.ok(cards[1].textContent.includes('同時二'));
  assert.ok(cards[2].textContent.includes('最早'));
  assert.equal(column(doc).textContent.includes('乙'), false);
});

test('plain markup is displayed literally through textContent and cannot become elements', () => {
  const doc = makeDocument();
  const content = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', [makeNote({ market_recap: content })], now);
  assert.ok(column(doc).textContent.includes(content));
  assert.equal(descendants(column(doc)).some(node => ['img', 'script'].includes(node.tagName)), false);
  assert.ok(column(doc).textContent.includes('AI 交易員自述，非投資建議'));
});

test('unsafe content in any one field hides the entire note without hiding safe neighbours', () => {
  const bad = ['market_recap', 'trade_review', 'watch_next', 'strategy_adjustments'].map(field => makeNote({ [field]: 'token: FAKE_ONLY' }));
  const safe = makeNote({ watch_next: '可顯示' });
  const normalized = notes.normalizeDocument(documentOf([...bad, safe]));
  assert.deepEqual(normalized, [safe]);
  const doc = makeDocument();
  // renderColumn also checks safety when handed raw records directly.
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', [...bad, safe], now);
  assert.equal(descendants(column(doc)).filter(node => node.tagName === 'article').length, 1);
  assert.equal(column(doc).textContent.includes('FAKE_ONLY'), false);
});

test('each trader shows ten recent cards and a separate accessible more disclosure', () => {
  const doc = makeDocument();
  const source = Array.from({ length: 13 }, (_, index) => makeNote({ ts: (now - index * 1000) / 1000, watch_next: `筆記 ${index}` }));
  source.push(makeNote({ trader: 'Grok-Trader-B', watch_next: '乙便利貼' }));
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', source, now);
  const list = column(doc).querySelector('.notes-list');
  assert.equal(list.children.filter(node => node.tagName === 'article').length, 10);
  const more = list.querySelector('.notes-more');
  assert.equal(more.open, false);
  assert.equal(more.children[0].tagName, 'summary');
  assert.equal(more.children[0].textContent, '看更多（3）');
  assert.equal(more.children.filter(node => node.tagName === 'article').length, 3);
  more.open = true;
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', source, now + 60000);
  assert.equal(column(doc).querySelector('.notes-more').open, true);
  notes.renderColumn(doc, column(doc, 'Grok-Trader-B'), 'Grok-Trader-B', source, now);
  assert.equal(descendants(column(doc, 'Grok-Trader-B')).filter(node => node.tagName === 'article').length, 1);
  assert.equal(column(doc, 'Grok-Trader-B').querySelector('.notes-more'), null);
});

test('timestamps use Taipei and all note kinds have labels; stale starts strictly after 48 hours', () => {
  const doc = makeDocument();
  const timestamp = Date.parse('2026-10-30T04:20:02.598+08:00');
  const source = [makeOpen({ ts: timestamp / 1000 }), makeClose({ ts: timestamp / 1000 }), makeNote({ ts: timestamp / 1000 })];
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', source, timestamp + 48 * 3600000);
  let nodes = descendants(column(doc));
  assert.deepEqual(nodes.filter(node => node.className === 'note-kind').map(node => node.textContent), ['開倉', '平倉', '日報']);
  const time = nodes.find(node => node.tagName === 'time');
  assert.equal(time.dateTime, '2026-10-29T20:20:02.598Z');
  assert.match(time.textContent, /04:20:02.*台北/);
  assert.equal(nodes.some(node => node.className === 'note-stale'), false);
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', source, timestamp + 48 * 3600000 + 1);
  nodes = descendants(column(doc));
  assert.equal(nodes.filter(node => node.className === 'note-stale').length, 3);
});

test('missing, malformed, or unreadable notes show an empty state without touching financial content', async () => {
  const fetchers = [async () => ({ ok: false }), async () => ({ ok: true, text: async () => '{bad' }),
    async () => response({ version: 2, notes: [] }), async () => { throw new Error('offline'); }];
  for (const fetcher of fetchers) {
    const doc = makeDocument();
    const marker = new TextNode('div'); marker.textContent = '已驗證帳戶資料';
    doc.nodes.financial.append(marker);
    const controller = notes.start(doc, options(fetcher));
    await controller.ready;
    assert.match(column(doc).textContent, /目前沒有可顯示的便利貼/);
    assert.match(column(doc, 'Grok-Trader-B').textContent, /目前沒有可顯示的便利貼/);
    assert.equal(doc.nodes.financial.children[0], marker);
    assert.equal(doc.nodes.financial.textContent, '已驗證帳戶資料');
  }
});

test('notes refresh uses its own request and timers, with cache bypass and timeout cleanup', async () => {
  const calls = [];
  const doc = makeDocument();
  const opts = options(async (url, request) => { calls.push({ url, request }); return response(documentOf([makeNote()])); });
  const controller = notes.start(doc, opts);
  await controller.ready;
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^notes\.json\?v=/);
  assert.equal(calls[0].request.cache, 'no-store');
  assert.ok(calls[0].request.signal instanceof AbortSignal);
  assert.deepEqual(opts.intervals.map(item => item.ms), [30000, 60000]);
  assert.deepEqual(opts.cleared, [1]);
  await controller.refresh();
  assert.equal(calls.length, 2);
  assert.ok(column(doc).textContent.includes('市場波動偏高。'));
});

test('a timed-out notes request is aborted and the controller remains usable', async () => {
  const doc = makeDocument();
  const opts = options((url, request) => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('timeout')))));
  const controller = notes.start(doc, opts);
  assert.equal(opts.timeouts[0].ms, 10000);
  opts.timeouts[0].callback();
  await controller.ready;
  assert.match(column(doc).textContent, /目前沒有可顯示的便利貼/);
  assert.deepEqual(opts.cleared, [1]);
});

test('age labels update with the clock even while the next fetch is still pending', async () => {
  let clock = now;
  let requests = 0;
  const doc = makeDocument();
  const source = makeNote({ ts: (now - 48 * 3600000) / 1000 });
  const opts = options(async () => ++requests === 1 ? response(documentOf([source])) : new Promise(() => {}), () => clock);
  const controller = notes.start(doc, opts);
  await controller.ready;
  assert.equal(column(doc).textContent.includes('已過時'), false);
  controller.refresh();
  clock += 1;
  opts.intervals.find(item => item.ms === 60000).callback();
  assert.ok(column(doc).textContent.includes('已過時'));
});

test('oversized UTF-8 responses and declared oversized bodies never get rendered', async () => {
  assert.deepEqual(await notes.fetchNotes(async () => ({ ok: true, text: async () => '中'.repeat(400000) }), undefined, 1), []);
  let read = false;
  const oversized = { ok: true, headers: { get: () => String(1024 * 1024 + 1) }, text: async () => { read = true; return ''; } };
  assert.deepEqual(await notes.fetchNotes(async () => oversized, undefined, 1), []);
  assert.equal(read, false);
});

test('duplicate document or note keys, including escaped names, empty the notes area', async () => {
  const original = JSON.stringify(documentOf([makeNote()]));
  const duplicateBodies = [
    original.replace('"version":1', '"version":1,"version":1'),
    original.replace('"version":1', '"vers\\u0069on":1,"version":1'),
    original.replace('"market_recap":', '"market_recap":"token: FAKE_ONLY","market_recap":'),
    original.replace('"watch_next":', '"watch_n\\u0065xt":"first","watch_next":')
  ];
  for (const body of duplicateBodies) {
    const fetcher = async () => ({ ok: true, text: async () => body });
    await assert.rejects(notes.fetchNotes(fetcher, undefined, 1), /Duplicate notes key/);
    const doc = makeDocument();
    await notes.start(doc, options(fetcher)).ready;
    assert.match(column(doc).textContent, /目前沒有可顯示的便利貼/);
    assert.equal(descendants(column(doc)).some(node => node.tagName === 'article'), false);
  }
});

test('JSON key scanning does not confuse quoted prose, braces, escaped slashes, or repeated keys in distinct notes', async () => {
  const source = documentOf([
    makeNote({ market_recap: '文字包含 "plan": 與 { 括號 }、反斜線 \\ 仍是純文字。' }),
    makeNote({ trader: 'Grok-Trader-B', watch_next: '另一張便利貼。' })
  ]);
  const normalized = await notes.fetchNotes(async () => response(source), undefined, 1);
  assert.deepEqual(normalized, source.notes);
});

test('a note stays collapsed on a short highlight and expands to the full text without parsing HTML', () => {
  const doc = makeDocument();
  const recap = '市場'.repeat(100);
  const note = makeNote({ market_recap: recap, trade_review: '逐筆：BTC 空單先虧後平。', watch_next: '守 76000。', strategy_adjustments: '降低槓桿。' });
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', [note], now);
  const details = column(doc).querySelector('.note-details');
  assert.equal(details.tagName, 'details');
  assert.equal(details.open, false);
  assert.equal(details.children[0].tagName, 'summary');
  assert.ok(details.children[0].textContent.endsWith('（展開全文）'));
  assert.ok(details.children[0].textContent.length < recap.length);
  assert.ok(details.textContent.includes(recap));
  assert.ok(details.textContent.includes('降低槓桿。'));
  assert.equal(descendants(column(doc)).some(node => node.tagName === 'script'), false);
  details.open = true;
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', [note], now);
  assert.equal(column(doc).querySelector('.note-details').open, true);
});

test('open and close notes render every required review field from text nodes', () => {
  const doc = makeDocument();
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', [makeOpen(), makeClose({ ts: now / 1000 - 10 })], now);
  const text = column(doc).textContent;
  for (const label of ['標的', '方向', '槓桿', '進場價', '停損', '停利', '最大虧損（USDT）', '資金費率', '未平倉量', '關鍵價位', '成交量', '事件', '信心', '失效條件']) {
    assert.ok(text.includes(label), label);
  }
  assert.ok(text.includes('BTC-USDT-SWAP'));
  assert.ok(text.includes('空'));
  assert.ok(text.includes('5x'));
  assert.ok(text.includes('開倉覆盤'));
  assert.ok(text.includes('已實現損益（USDT）'));
  assert.ok(text.includes('做對的部分'));
  assert.ok(text.includes('做錯的部分'));
  assert.ok(text.includes('教訓'));
  assert.ok(text.includes('-0.06'));
});

test('shallow legacy notes and incomplete position notes are withheld', () => {
  const legacy = { trader: 'Grok-Trader-A', ts: now / 1000, kind: 'daily', market_view: '淺', current_approach: '淺', plan: '淺' };
  const opened = makeOpen();
  delete opened.stop_loss;
  const closed = makeClose();
  delete closed.variance.lesson;
  const daily = makeNote();
  delete daily.trade_review;
  for (const bad of [legacy, opened, closed, daily]) {
    assert.deepEqual(notes.normalizeDocument(documentOf([bad])), []);
  }
  const kept = makeNote({ watch_next: '留下' });
  assert.deepEqual(notes.normalizeDocument(documentOf([kept])), [kept]);
});

test('unrepresentable numeric values are rejected before schema normalization', async () => {
  const body = JSON.stringify(documentOf([makeNote()])).replace('"version":1', '"version":1e9999');
  await assert.rejects(notes.fetchNotes(async () => ({ ok: true, text: async () => body }), undefined, 1), /Invalid notes number/);
});
