(function (root) {
  'use strict';

  const REFRESH_MS = 30000;
  const STALE_MS = 15 * 60000;
  const TIME_ZONE = 'Asia/Taipei';
  const FAILED_STATES = new Set(['error', 'failed', 'unavailable', 'not_connected', 'not_configured', 'pending']);
  const colors = ['#00f0ff', '#ff2bd6', '#39ff88', '#7a5cff'];

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function number(value) {
    if (value === null || value === undefined || typeof value === 'boolean' ||
        (typeof value === 'string' && !value.trim())) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function timestamp(value) {
    const numeric = number(value);
    if (numeric !== null) return numeric >= 0 ? (numeric < 1e11 ? numeric * 1000 : numeric) : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const input = value.trim().replace(' ', 'T');
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input) ? input : input + '+08:00';
    const parsed = Date.parse(zoned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function taipeiTime(value) {
    return value === null ? '尚無成功更新' : new Date(value).toLocaleString('zh-TW', {
      timeZone: TIME_ZONE, hour12: false
    });
  }

  function day(value) {
    return new Date(value).toLocaleDateString('sv-SE', { timeZone: TIME_ZONE });
  }

  function normalizeTrader(name, raw, previous, defaultUpdated) {
    if (!record(raw)) throw new Error('Invalid trader');
    const state = typeof raw.status === 'string' ? raw.status.toLowerCase() : 'ok';
    const totalsSince = timestamp(raw.totals_since);
    const totalsUpdated = timestamp(raw.totals_updated);
    const hasTotalsMetadata = totalsSince !== null && ['complete', 'partial'].includes(raw.totals_status);
    const normalized = {
      name,
      equity: number(raw.equity), start: number(raw.start), deposited: number(raw.deposited),
      currency: typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim() : null,
      updated: timestamp(Object.hasOwn(raw, 'updated') ? raw.updated : defaultUpdated), status: state,
      fillsTotal: hasTotalsMetadata ? number(raw.fills_total) : null,
      feesTotal: number(raw.fees_total), fundingTotal: number(raw.funding_total),
      totalsSince, totalsUpdated, totalsStatus: hasTotalsMetadata ? raw.totals_status : 'partial',
      fillsTotalPartial: !hasTotalsMetadata || raw.fills_total_partial !== false,
      feesTotalPartial: !hasTotalsMetadata || raw.fees_total_partial !== false,
      fundingTotalPartial: !hasTotalsMetadata || raw.funding_total_partial !== false,
      fillsPartial: raw.fills_partial === true,
      positions: Array.isArray(raw.positions) ? raw.positions.filter(record).map(position => ({
        inst: String(position.inst ?? ''), side: String(position.side ?? ''),
        size: number(position.sz), averagePrice: number(position.avgPx), upl: number(position.upl),
        unit: typeof (position.qty_unit ?? position.unit) === 'string' ? (position.qty_unit ?? position.unit) : null,
        uplCurrency: typeof (position.upl_ccy ?? position.currency) === 'string' ? (position.upl_ccy ?? position.currency) : null
      })) : null
    };
    // An API failure must not turn a previously known balance/position into zero.
    if (FAILED_STATES.has(state) && previous && previous.equity !== null) {
      return { ...previous, status: state };
    }
    return normalized;
  }

  function normalizeTrade(raw) {
    if (!record(raw)) throw new Error('Invalid trade');
    return {
      trader: String(raw.trader ?? ''), timestamp: timestamp(raw.ts) ?? timestamp(raw.time),
      time: String(raw.time ?? ''), market: String(raw.market ?? ''), side: String(raw.side ?? ''),
      price: raw.price === null || raw.price === undefined ? '—' : String(raw.price),
      qty: raw.qty === null || raw.qty === undefined ? '—' : String(raw.qty),
      pnl: number(raw.pnl),
      pnlCurrency: typeof raw.pnl_ccy === 'string' && raw.pnl_ccy.trim() ? raw.pnl_ccy.trim() : null,
      note: String(raw.note ?? '')
    };
  }

  function pairSnapshot(data, history, previous = null) {
    if (!record(data) || !record(data.traders) || !Array.isArray(data.trades) || !record(history)) {
      throw new Error('Invalid snapshot shape');
    }
    if (data.source !== 'own-okx-readonly') {
      throw new Error('Unsupported snapshot source');
    }
    const dataId = data.snapshot_id;
    const historyId = history.snapshot_id;
    // Only owned, paired exports are valid; never revive the fork's source data.
    if (typeof dataId !== 'string' || !dataId.trim() || dataId !== historyId || !record(history.series)) {
      throw new Error('Snapshot pair is not from the same update');
    }
    const sourceHistory = history.series;
    const traders = Object.entries(data.traders).map(([name, raw]) => normalizeTrader(
      name, raw, previous?.traders.find(trader => trader.name === name), data.updated
    ));
    if (!traders.length) throw new Error('No traders in snapshot');
    const names = new Set(traders.map(trader => trader.name));
    let trades = data.trades.map(normalizeTrade).filter(trade => names.has(trade.trader));
    const series = traders.map(trader => {
      const raw = sourceHistory[trader.name];
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('Invalid history series');
      let points = (raw || []).map(point => {
        if (!Array.isArray(point) || point.length < 2) throw new Error('Invalid history point');
        const x = timestamp(point[0]);
        const y = number(point[1]);
        if (x === null || y === null) throw new Error('Invalid history value');
        return [x, y];
      }).sort((a, b) => a[0] - b[0]);
      if (FAILED_STATES.has(trader.status) && previous) {
        const oldPoints = previous.series.find(item => item.name === trader.name)?.points;
        if (oldPoints?.length && (!points.length || points.at(-1)[0] < oldPoints.at(-1)[0])) {
          points = oldPoints;
        }
        const oldTrades = previous.trades.filter(trade => trade.trader === trader.name);
        if (!trades.some(trade => trade.trader === trader.name) && oldTrades.length) {
          trades = trades.concat(oldTrades);
        }
      }
      return { name: trader.name, points };
    });
    const configuredStaleSeconds = number(data.stale_after_seconds);
    const staleAfterMs = configuredStaleSeconds !== null && configuredStaleSeconds >= 60 && configuredStaleSeconds <= 3600
      ? configuredStaleSeconds * 1000 : STALE_MS;
    return {
      snapshotId: dataId, updated: timestamp(data.updated), source: String(data.source ?? ''),
      staleAfterMs, traders, trades: trades.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)), series
    };
  }

  function freshness(trader, now = Date.now(), staleAfterMs = STALE_MS) {
    if (trader.equity === null || trader.updated === null) {
      return { text: '尚未取得有效帳戶資料', className: 'muted' };
    }
    if (FAILED_STATES.has(trader.status)) {
      return { text: '更新失敗，顯示上次成功資料', className: 'neg' };
    }
    if (trader.status === 'stale' || now - trader.updated > staleAfterMs) {
      return { text: '資料已過期，等待更新', className: 'warning' };
    }
    if (trader.updated > now + 60000) {
      return { text: '資料時間異常，等待校正', className: 'warning' };
    }
    return { text: '資料已更新', className: 'pos' };
  }

  function signedClass(value) {
    return value === null ? 'muted' : value >= 0 ? 'pos' : 'neg';
  }

  function fixed(value, digits = 2) {
    return value === null ? '—' : value.toFixed(digits);
  }

  function currencyText(value) {
    return value || '幣別未提供';
  }

  function traderView(trader, trades, now = Date.now()) {
    const ownTrades = trades.filter(trade => trade.trader === trader.name);
    const known = trader.equity !== null && trader.updated !== null;
    const lowerBound = trader.fillsPartial ? '≥' : '';
    const roi = trader.equity !== null && trader.start !== null && trader.start > 0
      ? (trader.equity / trader.start - 1) * 100 : null;
    return {
      roi,
      roiText: roi === null ? (trader.start === null ? '—（本金未確認）'
        : trader.equity === null ? '—（資產未確認）' : '—（本金須大於 0）')
        : `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`,
      total: trader.fillsTotal === null ? '—（partial／待補齊）'
        : `${trader.fillsTotalPartial ? '≥' : ''}${trader.fillsTotal}${trader.fillsTotalPartial ? '（partial／資料不完整）' : ''}`,
      today: known ? lowerBound + String(ownTrades.filter(trade => trade.timestamp !== null &&
        trade.timestamp <= now && day(trade.timestamp) === day(now)).length) : '—',
      lastHour: known ? lowerBound + String(ownTrades.filter(trade => trade.timestamp !== null &&
        now - trade.timestamp >= 0 && now - trade.timestamp < 3600000).length) : '—'
    };
  }

  function element(doc, tag, text, className) {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function row(doc, card, label, value, className) {
    const line = element(doc, 'div', null, 'row');
    line.append(element(doc, 'span', label), element(doc, 'span', value, className));
    card.append(line);
  }

  function renderCard(doc, trader, trades, now = Date.now(), staleAfterMs = STALE_MS) {
    const view = traderView(trader, trades, now);
    const card = element(doc, 'div', null, 'card');
    card.append(element(doc, 'h2', trader.name));
    const balance = element(doc, 'div', fixed(trader.equity) + ' ', 'big');
    balance.append(element(doc, 'small', currencyText(trader.currency)));
    card.append(balance);
    row(doc, card, '報酬率', view.roiText, signedClass(view.roi));
    const start = trader.start === null ? '待確認' : `${fixed(trader.start)} ${currencyText(trader.currency)}`;
    row(doc, card, '起始資金', start + (trader.deposited ? `（含追加 ${fixed(trader.deposited)}）` : ''));
    row(doc, card, '全局累計總筆數', view.total);
    row(doc, card, '統計起點', trader.totalsSince === null ? '待確認' : taipeiTime(trader.totalsSince) + ' 台灣');
    row(doc, card, '累計更新', trader.totalsUpdated === null ? '尚無完整更新' : taipeiTime(trader.totalsUpdated) + ' 台灣');
    if (trader.positions === null) {
      row(doc, card, '持倉', '尚未提供', 'muted');
    } else {
      for (const position of trader.positions) {
        const side = { long: '多', short: '空', net: '淨持倉' }[position.side] || position.side;
        const unit = position.unit || '（單位未提供）';
        const average = position.averagePrice === null ? '—' : String(+position.averagePrice.toPrecision(6));
        const pnl = position.upl === null ? '—' : `${fixed(position.upl)} ${currencyText(position.uplCurrency || trader.currency)}`;
        row(doc, card, `持倉 ${position.inst} ${side} ${position.size ?? '—'}${unit} @${average}`,
          pnl, signedClass(position.upl));
      }
    }
    const amount = (value, partial) => value === null ? '—（partial／待補齊）'
      : `${fixed(value, 3)} ${currencyText(trader.currency)}${partial ? '（partial／資料不完整）' : ''}`;
    row(doc, card, '全局累計手續費', amount(trader.feesTotal, trader.feesTotalPartial), signedClass(trader.feesTotal));
    row(doc, card, '全局累計資金費', amount(trader.fundingTotal, trader.fundingTotalPartial), signedClass(trader.fundingTotal));
    row(doc, card, '累計資料', trader.totalsStatus === 'complete' ? 'complete／完整' : 'partial／資料不完整');
    const settlementSummary = element(doc, 'div', null, 'settlement-summary');
    settlementSummary.dataset.trader = trader.name;
    card.append(settlementSummary);
    row(doc, card, '今日筆數', view.today);
    row(doc, card, '近 1 小時', view.lastHour);
    const status = freshness(trader, now, staleAfterMs);
    const state = element(doc, 'div', status.text, `trader-status ${status.className}`);
    state.dataset.traderStatus = trader.name;
    card.append(state, element(doc, 'div', taipeiTime(trader.updated), 'trader-updated'));
    return card;
  }

  function renderRows(doc, container, trades) {
    const fragment = doc.createDocumentFragment();
    for (const [index, trade] of trades.slice().reverse().entries()) {
      const line = element(doc, 'tr');
      line.style.animationDelay = `${0.3 + Math.min(index, 12) * 0.08}s`;
      const time = trade.timestamp === null ? trade.time || '—' : new Date(trade.timestamp).toLocaleTimeString(
        'zh-TW', { timeZone: TIME_ZONE, hour12: false });
      const timeCell = element(doc, 'td', time);
      timeCell.title = taipeiTime(trade.timestamp);
      line.append(timeCell);
      for (const text of [trade.trader, trade.market, trade.side, trade.price, trade.qty]) {
        line.append(element(doc, 'td', text));
      }
      const pnl = trade.pnl === null ? '—' : `${trade.pnl} ${currencyText(trade.pnlCurrency)}`;
      line.append(element(doc, 'td', pnl, signedClass(trade.pnl)), element(doc, 'td', trade.note));
      fragment.append(line);
    }
    if (!trades.length) {
      const line = element(doc, 'tr');
      const cell = element(doc, 'td', '目前沒有可顯示的交易紀錄', 'muted');
      cell.colSpan = 8;
      line.append(cell);
      fragment.append(line);
    }
    container.replaceChildren(fragment);
  }

  async function fetchPair(fetcher, previous, signal, nonce) {
    const responses = await Promise.all(['data.json', 'history.json'].map(file => fetcher(
      `${file}?v=${nonce}`, { cache: 'no-store', signal }
    )));
    if (responses.some(response => !response.ok)) throw new Error('Snapshot HTTP error');
    const [data, history] = await Promise.all(responses.map(response => response.json()));
    return pairSnapshot(data, history, previous);
  }

  function start(doc) {
    const clock = doc.getElementById('clk');
    const status = doc.getElementById('data-status');
    const cards = doc.getElementById('cards');
    const rows = doc.getElementById('rows');
    const chartStatus = doc.getElementById('chart-status');
    const canvas = doc.getElementById('eqc');
    let current = null;
    let lastError = false;
    let loading = false;
    let chart = null;

    function updateStatus() {
      clock.textContent = taipeiTime(Date.now()) + ' 台灣';
      if (!current) {
        status.textContent = lastError ? '暫時無法讀取資料，將自動重試。' : '正在讀取資料…';
        status.className = `data-status ${lastError ? 'neg' : 'muted'}`;
        return;
      }
      const states = current.traders.map(trader => freshness(trader, Date.now(), current.staleAfterMs));
      const allFresh = states.every(state => state.className === 'pos');
      status.textContent = `${current.updated === null ? '尚無成功更新' : '資料更新：' + taipeiTime(current.updated) + ' 台灣'} ／ ` +
        (lastError ? '讀取失敗，保留上次資料並自動重試' : allFresh ? '每 30 秒檢查更新' : '部分資料尚未接通或已過期，請見各卡片');
      status.className = `data-status ${lastError ? 'neg' : allFresh ? 'muted' : 'warning'}`;
      for (const node of cards.querySelectorAll('[data-trader-status]')) {
        const trader = current.traders.find(item => item.name === node.dataset.traderStatus);
        const state = freshness(trader, Date.now(), current.staleAfterMs);
        node.textContent = state.text;
        node.className = `trader-status ${state.className}`;
      }
    }

    function updateChart(snapshot) {
      if (typeof root.Chart !== 'function') {
        chartStatus.textContent = '圖表元件暫時無法載入；帳戶與交易資料仍可更新。';
        return;
      }
      const visibility = new Map(chart ? chart.data.datasets.map((dataset, index) => [dataset.label, chart.isDatasetVisible(index)]) : []);
      const datasets = snapshot.series.map((item, index) => ({
        label: item.name, data: item.points.map(([x, y]) => ({ x, y })),
        hidden: visibility.has(item.name) ? !visibility.get(item.name) : false,
        segment: { borderDash: context => context.p1.parsed.x - context.p0.parsed.x > snapshot.staleAfterMs ? [4, 4] : undefined },
        borderColor: colors[index % colors.length], backgroundColor: colors[index % colors.length] + '22',
        fill: true, tension: 0.3, pointRadius: item.points.length === 1 ? 2 : 0, borderWidth: 2
      }));
      const hasHistory = snapshot.series.some(item => item.points.length);
      const currencies = new Set(snapshot.traders.map(trader => trader.currency));
      chartStatus.textContent = !hasHistory ? '尚無已驗證的資產歷史；成功更新後開始累積。'
        : currencies.size > 1 || currencies.has(null) ? '各曲線依對應帳戶幣別計價；幣別不同時請勿直接比較數值。' : '';
      if (chart) {
        chart.data.datasets = datasets;
        chart.update('none');
        return;
      }
      chart = new root.Chart(canvas, {
        type: 'line', data: { datasets },
        options: {
          animation: { duration: 1200 }, parsing: false,
          scales: {
            x: { type: 'linear', ticks: { color: '#9bb', callback: value => new Date(value).toLocaleTimeString('zh-TW', {
              timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false
            }) }, grid: { color: '#12222c' } },
            y: { ticks: { color: '#9bb' }, grid: { color: '#12222c' } }
          },
          plugins: { legend: { labels: { color: '#d8f6ff' } } }
        }
      });
    }

    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        let next;
        // A deployment may reach CDN edges between the two requests. Retry the pair once.
        for (let attempt = 0; attempt < 2; attempt++) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            next = await fetchPair(root.fetch.bind(root), current, controller.signal, `${Date.now()}-${attempt}`);
            break;
          } catch (error) {
            if (attempt === 1) throw error;
          } finally {
            clearTimeout(timeout);
          }
        }
        const hadPrevious = current !== null;
        current = next;
        lastError = false;
        const panels = current.traders.map(trader => {
          const panel = element(doc, 'section', null, 'trader-panel');
          panel.append(renderCard(doc, trader, current.trades, Date.now(), current.staleAfterMs));
          const notesId = { 'Grok-Trader-A': 'notes-a', 'Grok-Trader-B': 'notes-b' }[trader.name];
          const notes = notesId ? doc.getElementById(notesId) : null;
          if (notes) panel.append(notes);
          return panel;
        });
        cards.replaceChildren(...panels);
        doc.dispatchEvent(new Event('race:cards-updated'));
        if (hadPrevious) cards.classList.add('is-ready');
        renderRows(doc, rows, current.trades);
        try { updateChart(current); } catch (_) {
          chartStatus.textContent = '圖表更新失敗；帳戶與交易資料仍可更新。';
        }
      } catch (_) {
        lastError = true;
      } finally {
        loading = false;
        updateStatus();
      }
    }

    updateStatus();
    refresh();
    setInterval(updateStatus, 1000);
    setInterval(refresh, REFRESH_MS);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
  }

  const api = { number, timestamp, pairSnapshot, freshness, traderView, renderCard, renderRows, fetchPair };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(document));
    else start(document);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Notes refresh independently of the paired financial snapshots.
(function (root) {
  'use strict';

  const TRADERS = ['Grok-Trader-A', 'Grok-Trader-B'];
  const KINDS = { open: '開倉', close: '平倉', daily: '日報', daily_settlement: '每日結算' };
  const TEXT_FIELDS = ['market_view', 'current_approach', 'plan'];
  const NOTE_KEYS = ['trader', 'ts', 'kind', ...TEXT_FIELDS];
  const SETTLEMENT_KEYS = ['trader', 'ts', 'kind', 'date', 'table'];
  const NUMBER_FIELDS = ['realized_pnl', 'unrealized_pnl', 'fees', 'funding', 'api_cost_total', 'net_after_costs'];
  const TABLE_KEYS = [...NUMBER_FIELDS, 'api_cost_by_model'];
  const OPENAI_MODEL = /^(?:gpt|chatgpt|o[1-9]|text-embedding|whisper|tts|dall-e)(?:[-.][A-Za-z0-9]{1,16})+$/;
  const MAX_BYTES = 1024 * 1024;
  const STALE_MS = 48 * 60 * 60 * 1000;
  const REFRESH_MS = 30000;

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, keys) {
    return record(value) && Object.keys(value).length === keys.length &&
      keys.every(key => Object.hasOwn(value, key));
  }

  function noteShape(note) {
    if (!record(note) || !TRADERS.includes(note.trader) ||
        typeof note.ts !== 'number' || !Number.isFinite(note.ts) || note.ts <= 0 || note.ts > 253402300799) return false;
    if (note.kind === 'daily_settlement') {
      return exactKeys(note, SETTLEMENT_KEYS) && validDate(note.date) && tableShape(note.table, true);
    }
    return exactKeys(note, NOTE_KEYS) && TRADERS.includes(note.trader) &&
      typeof note.ts === 'number' && Number.isFinite(note.ts) && note.ts > 0 && note.ts <= 253402300799 &&
      typeof note.kind === 'string' && Object.hasOwn(KINDS, note.kind) && TEXT_FIELDS.every(field => typeof note[field] === 'string') &&
      TEXT_FIELDS.reduce((length, field) => length + Array.from(note[field]).length, 0) <= 300;
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function nullableNumber(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
  }

  function tableShape(table, withCumulative = false) {
    if (!exactKeys(table, withCumulative ? [...TABLE_KEYS, 'cum'] : TABLE_KEYS) ||
        !NUMBER_FIELDS.every(field => nullableNumber(table[field])) ||
        (table.api_cost_total !== null && table.api_cost_total < 0) || !record(table.api_cost_by_model)) return false;
    const models = Object.entries(table.api_cost_by_model);
    if (models.length > 50 || !models.every(([model, cost]) => model.trim() === model && Array.from(model).length > 0 &&
        Array.from(model).length <= 80 && nullableNumber(cost) && (cost === null || cost >= 0))) return false;
    return !withCumulative || tableShape(table.cum);
  }

  function suspiciousText(text, modelName = false) {
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text.replace(/[\t\r\n]/g, ''))) return true;
    const normalized = text.normalize('NFKC');
    return /(?:\b(?:api[ _-]?key|secret(?:[ _-]?key)?|(?:access[ _-]?)?token|uid|passphrase)\b|金鑰|私鑰)\s*[:=]\s*\S/iu.test(normalized) ||
      /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+\S+|-----BEGIN/iu.test(normalized) ||
      /[0-9]{8,}/u.test(normalized) ||
      (!(modelName && Array.from(normalized).length <= 80 && OPENAI_MODEL.test(normalized)) && /[A-Za-z0-9_+/=-]{32,}/u.test(normalized));
  }

  function safeNote(note) {
    if (note?.kind === 'daily_settlement') {
      return noteShape(note) && [note.table, note.table.cum].every(table =>
        Object.keys(table.api_cost_by_model).every(model => !suspiciousText(model, true)));
    }
    return noteShape(note) && !TEXT_FIELDS.some(field => suspiciousText(note[field])) &&
      !suspiciousText(TEXT_FIELDS.map(field => note[field]).join(''));
  }

  function normalizeDocument(document) {
    if (!exactKeys(document, ['version', 'notes']) || document.version !== 1 ||
        !Array.isArray(document.notes) || document.notes.length > 1000 || !document.notes.every(noteShape)) return [];
    const dates = new Set();
    for (const note of document.notes) {
      if (note.kind !== 'daily_settlement') continue;
      const key = note.trader + ':' + note.date;
      if (dates.has(key)) return [];
      dates.add(key);
    }
    return document.notes.filter(safeNote).slice().sort((a, b) => b.ts - a.ts);
  }

  function latestSettlement(notes, trader) {
    return notes.filter(note => note.kind === 'daily_settlement' && note.trader === trader && safeNote(note))
      .sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts)[0] || null;
  }

  function amount(value) {
    if (value === null || value === undefined) return '未知';
    return value !== 0 && (Math.abs(value) < 1e-8 || Math.abs(value) >= 1e12) ? value.toExponential(3)
      : value.toLocaleString('zh-TW', { maximumFractionDigits: 10 });
  }

  function renderSettlementTable(doc, note) {
    const table = element(doc, 'table', undefined, 'settlement-table');
    const head = element(doc, 'thead');
    const header = element(doc, 'tr');
    ['項目', '當日', '比賽累計'].forEach(label => header.append(element(doc, 'th', label)));
    head.append(header);
    const body = element(doc, 'tbody');
    function line(label, daily, cumulative) {
      const row = element(doc, 'tr');
      row.append(element(doc, 'th', label), element(doc, 'td', amount(daily)), element(doc, 'td', amount(cumulative)));
      body.append(row);
    }
    const labels = { realized_pnl: '已實現損益', unrealized_pnl: '未實現損益', fees: '手續費', funding: '資金費' };
    Object.entries(labels).forEach(([field, label]) => line(label + '（USDT）', note.table[field], note.table.cum[field]));
    const models = new Set([...Object.keys(note.table.api_cost_by_model), ...Object.keys(note.table.cum.api_cost_by_model)]);
    [...models].sort().forEach(model => line('API ' + model + '（USD）',
      Object.hasOwn(note.table.api_cost_by_model, model) ? note.table.api_cost_by_model[model] : null,
      Object.hasOwn(note.table.cum.api_cost_by_model, model) ? note.table.cum.api_cost_by_model[model] : null));
    line('API 花費合計（USD）', note.table.api_cost_total, note.table.cum.api_cost_total);
    line('扣除所有成本後淨損益（USDT）', note.table.net_after_costs, note.table.cum.net_after_costs);
    table.append(head, body);
    return table;
  }

  function renderSummaries(doc, notes, now = Date.now()) {
    for (const node of doc.querySelectorAll?.('.settlement-summary') || []) {
      const latest = latestSettlement(notes, node.dataset.trader);
      const cumulative = latest?.table.cum;
      function line(label, value, unit) {
        const row = element(doc, 'div', undefined, 'row');
        row.append(element(doc, 'span', label), element(doc, 'span', amount(value) + (value === null || value === undefined ? '' : ' ' + unit)));
        return row;
      }
      node.replaceChildren(line('累計 API 花費', cumulative?.api_cost_total, 'USD'),
        line('扣除 API 後淨損益', cumulative?.net_after_costs, 'USDT'),
        element(doc, 'div', latest ? `交易員填報／${latest.date}${now - latest.ts * 1000 > STALE_MS ? '／已過時' : ''}` : '尚無每日結算資料', 'settlement-source'));
    }
  }

  function element(doc, tag, text, className) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderNote(doc, note, now) {
    const settlement = note.kind === 'daily_settlement';
    const card = element(doc, 'article', undefined, settlement ? 'note note-settlement' : 'note');
    const header = element(doc, 'div', undefined, 'note-meta');
    header.append(element(doc, 'span', KINDS[note.kind], 'note-kind'));
    const time = element(doc, 'time', new Date(note.ts * 1000).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', hour12: false
    }) + ' 台北', 'note-time');
    time.dateTime = new Date(note.ts * 1000).toISOString();
    header.append(time);
    if (now - note.ts * 1000 > STALE_MS) header.append(element(doc, 'span', '已過時', 'note-stale'));
    card.append(header);
    if (settlement) {
      card.append(element(doc, 'h4', note.date + ' 今日戰果明細表'), renderSettlementTable(doc, note),
        element(doc, 'p', 'API 花費為交易員依 token 用量自記估算（USD）。淨損益採交易員填報值，不自行換匯或重算。', 'settlement-estimate'));
      return card;
    }
    const labels = ['市場觀點', '目前做法', '接下來計畫'];
    TEXT_FIELDS.forEach((field, index) => {
      const section = element(doc, 'div', undefined, 'note-field');
      section.append(element(doc, 'strong', labels[index]), element(doc, 'p', note[field]));
      card.append(section);
    });
    return card;
  }

  function renderColumn(doc, container, trader, notes, now = Date.now()) {
    const expanded = container.querySelector?.('.notes-more')?.open === true;
    const own = notes.filter(note => safeNote(note) && note.trader === trader).slice().sort((a, b) => b.ts - a.ts);
    const pinned = latestSettlement(own, trader);
    if (pinned) own.unshift(own.splice(own.indexOf(pinned), 1)[0]);
    const heading = element(doc, 'h3', trader + ' 交易員便利貼');
    const disclaimer = element(doc, 'p', 'AI 交易員自述，非投資建議', 'notes-disclaimer');
    const content = element(doc, 'div', undefined, 'notes-list');
    if (!own.length) content.append(element(doc, 'p', '目前沒有可顯示的便利貼', 'notes-empty'));
    own.slice(0, 10).forEach(note => content.append(renderNote(doc, note, now)));
    if (own.length > 10) {
      const more = element(doc, 'details', undefined, 'notes-more');
      more.open = expanded;
      more.append(element(doc, 'summary', `看更多（${own.length - 10}）`));
      own.slice(10).forEach(note => more.append(renderNote(doc, note, now)));
      content.append(more);
    }
    container.replaceChildren(heading, disclaimer, content);
  }

  function parseNotesJSON(body) {
    const value = JSON.parse(body, (key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid notes number');
      return item;
    });
    // Native JSON.parse overwrites duplicate keys. Check decoded key names in
    // each object so even Unicode-escaped duplicates invalidate the document.
    const tokens = body.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:]/g) || [];
    const stack = [];
    tokens.forEach((token, index) => {
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[index + 1] === ':') {
        const keys = stack.at(-1);
        const name = JSON.parse(token);
        if (keys.has(name)) throw new Error('Duplicate notes key');
        keys.add(name);
      }
    });
    return value;
  }

  async function fetchNotes(fetcher, signal, nonce) {
    const response = await fetcher(`notes.json?v=${nonce}`, { cache: 'no-store', signal });
    if (!response.ok) return [];
    const length = response.headers?.get('content-length');
    if (length !== null && length !== undefined && Number(length) > MAX_BYTES) return [];
    const body = await response.text();
    if (new TextEncoder().encode(body).length > MAX_BYTES) return [];
    return normalizeDocument(parseNotesJSON(body));
  }

  function start(doc, options = {}) {
    const columns = TRADERS.map((trader, index) => ({ trader, node: doc.getElementById(index === 0 ? 'notes-a' : 'notes-b') }));
    if (columns.some(column => !column.node)) return null;
    const fetcher = options.fetcher || root.fetch.bind(root);
    const clock = options.now || Date.now;
    const schedule = options.setInterval || root.setInterval.bind(root);
    const delay = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    let notes = [];
    let loading = false;
    function render() {
      columns.forEach(column => renderColumn(doc, column.node, column.trader, notes, clock()));
      renderSummaries(doc, notes, clock());
    }
    async function refresh() {
      if (loading) return;
      loading = true;
      const controller = new AbortController();
      const timeout = delay(() => controller.abort(), 10000);
      try {
        notes = await fetchNotes(fetcher, controller.signal, clock());
      } catch (_) {
        notes = [];
      } finally {
        cancel(timeout);
        loading = false;
        render();
      }
    }
    render();
    const ready = refresh();
    schedule(refresh, REFRESH_MS);
    // Age labels continue to update without a successful network request.
    schedule(render, 60000);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    doc.addEventListener('race:cards-updated', () => renderSummaries(doc, notes, clock()));
    return { refresh, render, ready };
  }

  const api = { normalizeDocument, suspiciousText, safeNote, renderColumn, latestSettlement, renderSummaries, fetchNotes, start };
  if (typeof module === 'object' && module.exports) module.exports.notes = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(document));
    else start(document);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
