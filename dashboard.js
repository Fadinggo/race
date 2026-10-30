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
        cards.replaceChildren(...current.traders.map(trader => renderCard(doc, trader, current.trades, Date.now(), current.staleAfterMs)));
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
