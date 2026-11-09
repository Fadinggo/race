'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');
const { botStatusView, start, update, fail } = dashboard.botStatus;

const UPDATED = Date.parse('2026-11-08T18:30:00Z') / 1000;
const bot = (name, state = 'ok', message_zh = '正常') => ({ bot: name, state, message_zh });
const file = (bots = [bot('A'), bot('B')], updated = UPDATED) => ({ schema_version: 1, updated, bots });
const down = '機器人狀態讀不到，無法確認 1 號機、2 號機能不能開新倉';
const missing = n => `${n} 號機狀態讀不到，無法確認能不能開新倉`;
const row = (level, text) => ({ level, text });

test('normal bots have no alerts', () => {
  assert.deepEqual(botStatusView(file(), UPDATED), []);
});

test('halted bots retain performance and equity messages in A/B order', () => {
  const a = bot('A', 'halted', '績效暫停');
  const b = bot('B', 'halted', '權益暫停');
  assert.deepEqual(botStatusView(file([a, bot('B')]), UPDATED), [row('red', '績效暫停')]);
  assert.deepEqual(botStatusView(file([bot('A'), b]), UPDATED), [row('red', '權益暫停')]);
  assert.deepEqual(botStatusView(file([b, a]), UPDATED), [row('red', '績效暫停'), row('red', '權益暫停')]);
});

test('unknown is amber and red comes first', () => {
  assert.deepEqual(botStatusView(file([bot('A', 'unknown', '未知原因'), bot('B', 'halted', '暫停')]), UPDATED),
    [row('red', '暫停'), row('amber', '未知原因')]);
});

test('invalid snapshots are unavailable', () => {
  for (const data of [null, [], 'x', {}, file([], '123'), file([], NaN), { ...file(), schema_version: 2 }, { ...file(), bots: null }]) {
    assert.deepEqual(botStatusView(data, UPDATED), [row('amber', down)]);
  }
});

test('stale boundary and Taipei time format', () => {
  assert.deepEqual(botStatusView(file(), UPDATED + 1499), []);
  assert.deepEqual(botStatusView(file(), UPDATED + 1500), [row('amber', '機器人狀態太舊（最後更新 11/9 02:30），無法確認 1 號機、2 號機能不能開新倉')]);
});

test('invalid state, empty message and missing bot are unavailable individually', () => {
  for (const a of [bot('A', 'other'), bot('A', 'halted', ''), bot('A', 'ok', '  ')]) {
    assert.deepEqual(botStatusView(file([a, bot('B')]), UPDATED), [row('amber', missing(1))]);
  }
  assert.deepEqual(botStatusView(file([bot('A')]), UPDATED), [row('amber', missing(2))]);
});

test('messages clip at 200 Unicode characters', () => {
  assert.deepEqual(botStatusView(file([bot('A', 'halted', '😀'.repeat(201)), bot('B')]), UPDATED), [row('red', '😀'.repeat(200))]);
});

test('future and unformattable timestamps are unavailable', () => {
  assert.deepEqual(botStatusView(file(undefined, UPDATED + 300), UPDATED), []);
  assert.deepEqual(botStatusView(file(undefined, UPDATED + 301), UPDATED), [row('amber', down)]);
  assert.deepEqual(botStatusView(file(undefined, -1e300), UPDATED), [row('amber', down)]);
});

test('start, updates, failure and timer render the latest status safely', () => {
  const oldInterval = global.setInterval;
  const oldTimeout = global.setTimeout;
  const oldNow = Date.now;
  let now = UPDATED * 1000;
  let tick;
  let timeout;
  global.setTimeout = (fn, delay) => { assert.equal(delay, 30000); timeout = fn; };
  global.setInterval = (fn, delay) => { assert.equal(delay, 30000); tick = fn; };
  Date.now = () => now;
  const block = {
    hidden: true, children: [], attributes: {}, draws: 0,
    replaceChildren(...children) { this.children = children; this.draws++; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  let visibility;
  const doc = {
    hidden: false,
    getElementById: () => block,
    createElement: () => ({ dataset: {}, textContent: '', children: [] }),
    addEventListener(name, fn) { if (name === 'visibilitychange') visibility = fn; }
  };
  try {
    start(doc);
    tick();
    assert.equal(visibility, undefined);
    assert.equal(block.hidden, true);
    timeout();
    assert.equal(block.children[0].textContent, down);
    update(file());
    assert.equal(block.hidden, true);
    const updatedDraws = block.draws;
    timeout();
    assert.equal(block.draws, updatedDraws);
    assert.equal(block.hidden, true);
    update(file([bot('A', 'halted', '<b>暫停</b>'), bot('B')]));
    assert.equal(block.hidden, false);
    assert.equal(block.attributes.role, 'alert');
    assert.equal(block.children[0].textContent, '<b>暫停</b>');
    assert.deepEqual(block.children[0].children, []);
    const draws = block.draws;
    fail();
    assert.equal(block.draws, draws);
    assert.equal(block.children[0].textContent, '<b>暫停</b>');
    now += 1500 * 1000;
    if (visibility) visibility();
    assert.equal(block.children[0].textContent, '<b>暫停</b>');
    assert.equal(block.draws, draws);
    tick();
    assert.match(block.children[0].textContent, /太舊/);
    update(undefined);
    assert.equal(block.children[0].textContent, down);
  } finally {
    global.setInterval = oldInterval;
    global.setTimeout = oldTimeout;
    Date.now = oldNow;
  }
});

test('fetchPair sends data.json status before rejecting a mismatched snapshot', async () => {
  const original = global.raceBotStatus;
  const status = file();
  const received = [];
  global.raceBotStatus = { update(value) { received.push(value); } };
  const fetcher = async url => ({ ok: true, json: async () => url.startsWith('data.json')
    ? { bot_status: status, updated: 1 } : { updated: 2 } });
  try {
    await assert.rejects(dashboard.fetchPair(fetcher, null, undefined, 'test'));
    assert.deepEqual(received, [status]);
  } finally {
    global.raceBotStatus = original;
  }
});
