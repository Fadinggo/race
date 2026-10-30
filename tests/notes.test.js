'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notes = require('../dashboard.js').notes;

const now = Date.parse('2026-10-31T04:20:02.598+08:00');
const makeNote = (overrides = {}) => ({
  trader: 'Grok-Trader-A', ts: now / 1000, kind: 'daily',
  market_view: '市場波動偏高。', current_approach: '保持觀察。', plan: '等待訊號。', ...overrides
});
const documentOf = items => ({ version: 1, notes: items });
const response = value => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(value) });

// Any use of HTML parsing for note content fails these tests.
class TextNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.text = ''; this.open = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML parsing is forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  querySelector(selector) { return descendants(this).find(node => node.className.split(' ').includes(selector.slice(1))) || null; }
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
  const source = [makeNote({ ts: now / 1000 - 5, plan: '最早' }),
    makeNote({ trader: 'Grok-Trader-B', plan: '乙' }),
    makeNote({ plan: '同時一' }), makeNote({ plan: '同時二' })];
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
  notes.renderColumn(doc, column(doc), 'Grok-Trader-A', [makeNote({ market_view: content })], now);
  assert.ok(column(doc).textContent.includes(content));
  assert.equal(descendants(column(doc)).some(node => ['img', 'script'].includes(node.tagName)), false);
  assert.ok(column(doc).textContent.includes('AI 交易員自述，非投資建議'));
});

test('unsafe content in any one field hides the entire note without hiding safe neighbours', () => {
  const bad = ['market_view', 'current_approach', 'plan'].map(field => makeNote({ [field]: 'token: FAKE_ONLY' }));
  const safe = makeNote({ plan: '可顯示' });
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
  const source = Array.from({ length: 13 }, (_, index) => makeNote({ ts: (now - index * 1000) / 1000, plan: `筆記 ${index}` }));
  source.push(makeNote({ trader: 'Grok-Trader-B', plan: '乙便利貼' }));
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
  const source = ['open', 'close', 'daily'].map(kind => makeNote({ kind, ts: timestamp / 1000 }));
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
    original.replace('"market_view":', '"market_view":"token: FAKE_ONLY","market_view":'),
    original.replace('"plan":', '"pl\\u0061n":"first","plan":')
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
    makeNote({ market_view: '文字包含 "plan": 與 { 括號 }、反斜線 \\ 仍是純文字。' }),
    makeNote({ trader: 'Grok-Trader-B', plan: '另一張便利貼。' })
  ]);
  const normalized = await notes.fetchNotes(async () => response(source), undefined, 1);
  assert.deepEqual(normalized, source.notes);
});

test('unrepresentable numeric values are rejected before schema normalization', async () => {
  const body = JSON.stringify(documentOf([makeNote()])).replace('"version":1', '"version":1e9999');
  await assert.rejects(notes.fetchNotes(async () => ({ ok: true, text: async () => body }), undefined, 1), /Invalid notes number/);
});
