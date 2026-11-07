'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { quotaView } = require('../dashboard.js').quota;

const NOW = 1794052561;
const alert = (key, level, message_zh = key) => ({ key, level, message_zh, since: NOW });
const file = (alerts = [], extra = {}) => ({ updated_at: NOW - 60, codex: { used_percent: 87, resets_at: 1794397875, observed_at: NOW, source: 'app-server' }, alerts, ...extra });

test('normal state is neutral with usage detail', () => {
  const v = quotaView(file(), NOW);
  assert.equal(v.level, 'ok');
  assert.equal(v.status, 'AI 額度正常');
  assert.match(v.detail, /^Codex 每週 87%｜重置 \d\d\/\d\d \d\d:\d\d｜更新 \d\d\/\d\d \d\d:\d\d$/);
});

test('high alert is red, most severe first, with count of the rest', () => {
  const v = quotaView(file([alert('threshold_70', 'high', 'seventy'), alert('threshold_85', 'high', 'eighty-five'), alert('x', 'medium')]), NOW);
  assert.equal(v.level, 'red');
  assert.equal(v.status, 'eighty-five（另 1 則）');
  assert.equal(v.alerts.length, 3);
});

test('medium only is amber and prefers pace alerts over thresholds', () => {
  const v = quotaView(file([alert('threshold_50', 'medium', 'fifty'), alert('ahead_of_pace', 'medium', 'pace')]), NOW);
  assert.equal(v.level, 'amber');
  assert.equal(v.status, 'pace');
});

test('thresholds covered by a higher threshold are dropped', () => {
  const v = quotaView(file([alert('threshold_50', 'medium', 'fifty'), alert('threshold_70', 'medium', 'seventy')]), NOW);
  assert.equal(v.status, 'seventy');
  const covered = quotaView(file([alert('threshold_50', 'medium', 'fifty'), alert('threshold_85', 'high', 'h')]), NOW);
  assert.equal(covered.status, 'h');
});

test('unavailable snapshot is red with a dash', () => {
  const v = quotaView({ updated_at: null, codex: null, alerts: [], error: 'unavailable' }, NOW);
  assert.deepEqual([v.level, v.status, v.detail], ['red', 'AI 額度資料暫無', 'AI 額度：—']);
});

test('null codex with high alerts still shows the alerts', () => {
  const v = quotaView({ updated_at: NOW, codex: null, alerts: [alert('a', 'high', 'danger')] }, NOW);
  assert.deepEqual([v.level, v.status, v.detail], ['red', 'danger', 'AI 額度：—']);
});

test('stale data is red and shows MM/DD HH:mm', () => {
  const v = quotaView(file([], { updated_at: NOW - 4 * 3600 }), NOW);
  assert.equal(v.level, 'red');
  assert.match(v.status, /^AI 額度資料已過時（最後更新 \d\d\/\d\d \d\d:\d\d）$/);
});

test('missing or invalid file is red unavailable', () => {
  for (const bad of [null, [], 'x', {}, { alerts: 'no' }]) assert.equal(quotaView(bad, NOW).status, 'AI 額度資料暫無');
});

test('messages are clipped to 200 characters', () => {
  const v = quotaView(file([alert('a', 'high', '字'.repeat(300))]), NOW);
  assert.equal(Array.from(v.status).length, 200);
  assert.equal(Array.from(v.alerts[0]).length, 200);
});
