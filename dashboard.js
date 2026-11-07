(function (root) {
  'use strict';

  const REFRESH_MS = 30000;
  const VERSION_CHECK_MS = 5 * 60000;
  const VERSION_RELOAD_COOLDOWN_MS = 10 * 60000;
  const VERSION_RELOAD_KEY = 'race-dashboard-version-reload-at';
  const VERSION_FILES = ['index.html', 'dashboard.js', 'layout-v4.js'];
  const STALE_MS = 15 * 60000;
  const SNAPSHOT_STALE_MS = 30 * 60000;
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

  // formatToParts keeps MM/DD HH:mm free of locale punctuation; h23 avoids "24:05" after midnight.
  const SHORT_TIME = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function shortTaipeiTime(value) {
    const parts = Object.fromEntries(SHORT_TIME.formatToParts(value).map(part => [part.type, part.value]));
    return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
  }

  // Top line: when data.json was generated; red once that is over 30 minutes ago or unknown.
  function renderUpdated(node, generatedAt, now = Date.now()) {
    node.textContent = '資料更新時間 ' + (generatedAt === null ? '—' : shortTaipeiTime(generatedAt));
    node.className = generatedAt === null || now - generatedAt > SNAPSHOT_STALE_MS ? 'data-updated neg' : 'data-updated';
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
      updated: timestamp(Object.hasOwn(raw, 'updated') ? raw.updated : defaultUpdated), dataTime: timestamp(defaultUpdated), status: state,
      fillsTotal: hasTotalsMetadata ? number(raw.fills_total) : null,
      feesTotal: number(raw.fees_total), fundingTotal: number(raw.funding_total),
      totalsSince, totalsUpdated, totalsStatus: hasTotalsMetadata ? raw.totals_status : 'partial',
      fillsTotalPartial: !hasTotalsMetadata || raw.fills_total_partial !== false,
      feesTotalPartial: !hasTotalsMetadata || raw.fees_total_partial !== false,
      fundingTotalPartial: !hasTotalsMetadata || raw.funding_total_partial !== false,
      fillsPartial: raw.fills_partial === true,
      openedToday: number(raw.opened_today), openedLastHour: number(raw.opened_last_hour),
      openedCountedAt: number(raw.opened_counted_at) > 0 && number(raw.opened_counted_at) <= 253402300799
        ? number(raw.opened_counted_at) * 1000 : null,
      hasApiCost: Object.hasOwn(raw, 'api_cost_total_usd'),
      apiCostTotal: number(raw.api_cost_total_usd), apiCostGpt: number(raw.api_cost_gpt_usd),
      apiCostClaude: number(raw.api_cost_claude_usd), apiCostUpdated: timestamp(raw.api_cost_updated),
      apiCostIsAccountDebit: raw.api_cost_is_account_debit,
      netPnl: number(raw.net_pnl_usdt),
      positions: Array.isArray(raw.positions) ? raw.positions.filter(record).map(position => ({
        inst: String(position.inst ?? ''), side: String(position.side ?? ''),
        size: number(position.sz), averagePrice: number(position.avgPx), upl: number(position.upl),
        markPrice: number(position.markPx), heldSeconds: number(position.held_seconds),
        reason: typeof position.reason === 'string' ? position.reason : '',
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
      time: String(raw.time ?? ''), timeLabel: typeof raw.time_label === 'string' ? raw.time_label : '',
      market: String(raw.market ?? '').trim() || '—', side: String(raw.side ?? ''), event: String(raw.event ?? ''),
      tradeId: typeof raw.trade_id === 'string' || typeof raw.trade_id === 'number' ? String(raw.trade_id) : '',
      heldSeconds: number(raw.held_seconds),
      openedTimestamp: timestamp(raw.opened_ts),
      openReason: typeof raw.open_reason === 'string' ? raw.open_reason : '',
      closeReason: typeof raw.close_reason === 'string' ? raw.close_reason : '',
      releaseReason: typeof raw.release_reason === 'string' ? raw.release_reason : '',
      price: raw.price === null || raw.price === undefined ? '—' : String(raw.price),
      qty: raw.qty === null || raw.qty === undefined ? '—' : String(raw.qty),
      pnl: number(raw.pnl),
      pnlCurrency: typeof raw.pnl_ccy === 'string' && raw.pnl_ccy.trim() ? raw.pnl_ccy.trim() : null,
      fee: number(raw.fee),
      feeCurrency: typeof raw.feeCcy === 'string' && raw.feeCcy.trim() ? raw.feeCcy.trim() : null,
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
      snapshotId: dataId, updated: timestamp(data.updated), generatedAt: timestamp(data.generated_at),
      source: String(data.source ?? ''),
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

  function price(value) {
    const parsed = number(value);
    return parsed === null ? '—' : String(+parsed.toPrecision(6));
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
    const days = trader.totalsSince != null && trader.dataTime != null ? (trader.dataTime - trader.totalsSince) / 86400000 : null;
    const annual = days >= 1 && roi !== null && trader.equity >= 0 ? (Math.pow(trader.equity / trader.start, 365 / days) - 1) * 100 : null;
    const countsCurrent = trader.openedCountedAt != null && day(trader.openedCountedAt) === day(now);
    return {
      roi,
      annual, days,
      annualText: annual === null ? '—' : annual > 9999 ? '>+9999%' : `${annual > 0 ? '+' : ''}${annual.toFixed(1)}%`,
      roiText: roi === null ? (trader.start === null ? '—（本金未確認）'
        : trader.equity === null ? '—（資產未確認）' : '—（本金須大於 0）')
        : `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`,
      total: trader.fillsTotal === null ? '—（partial／待補齊）'
        : `${trader.fillsTotalPartial ? '≥' : ''}${trader.fillsTotal}${trader.fillsTotalPartial ? '（partial／資料不完整）' : ''}`,
      today: countsCurrent && trader.openedToday != null ? String(trader.openedToday) : known ? lowerBound + String(ownTrades.filter(trade => trade.timestamp !== null &&
        trade.timestamp <= now && day(trade.timestamp) === day(now)).length) : '—',
      lastHour: countsCurrent && trader.openedLastHour != null ? String(trader.openedLastHour) : known ? lowerBound + String(ownTrades.filter(trade => trade.timestamp !== null &&
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
    return line;
  }

  function renderCard(doc, trader, trades, now = Date.now(), staleAfterMs = STALE_MS) {
    const view = traderView(trader, trades, now);
    const card = element(doc, 'div', null, 'card');
    card.append(element(doc, 'h2', trader.name));
    const balance = element(doc, 'div', fixed(trader.equity) + ' ', 'big');
    balance.append(element(doc, 'small', currencyText(trader.currency)));
    card.append(balance);
    row(doc, card, '報酬率', view.roiText, signedClass(view.roi));
    row(doc, card, '年化報酬率', view.annualText, view.annual === null || view.days < 7 ? 'muted' : signedClass(view.annual));
    if (view.annual !== null) card.append(element(doc, 'div', `開賽 ${Math.floor(view.days)} 天，天數太短時僅供參考`, 'api-cost-detail'));
    const start = trader.start === null ? '待確認' : `${fixed(trader.start)} ${currencyText(trader.currency)}`;
    row(doc, card, '起始資金', start + (trader.deposited ? `（含追加 ${fixed(trader.deposited)}）` : ''));
    row(doc, card, '全局累計總筆數', view.total);
    row(doc, card, '統計起點', trader.totalsSince === null ? '待確認' : taipeiTime(trader.totalsSince) + ' 台灣');
    row(doc, card, '累計更新', trader.totalsUpdated === null ? '尚無完整更新' : taipeiTime(trader.totalsUpdated) + ' 台灣');
    if (trader.positions === null) {
      row(doc, card, '持倉', '—', 'muted');
    } else {
      for (const position of trader.positions) {
        const side = { long: '多', short: '空', net: '淨持倉' }[position.side] || position.side;
        const unit = position.unit || '';
        const average = price(position.averagePrice);
        const pnl = position.upl === null ? '—' : `${position.upl > 0 ? '+' : ''}${+position.upl.toPrecision(8)} ${position.uplCurrency || trader.currency || '—'}`;
        row(doc, card, `持倉 ${position.inst} ${side} ${position.size ?? '—'}${unit} @${average}`,
          pnl, signedClass(position.upl)).className = 'row position-row';
      }
    }
    const amount = (value, partial) => value === null ? '—（partial／待補齊）'
      : `${fixed(value, 3)} ${currencyText(trader.currency)}${partial ? '（partial／資料不完整）' : ''}`;
    row(doc, card, '全局累計手續費', amount(trader.feesTotal, trader.feesTotalPartial), signedClass(trader.feesTotal));
    row(doc, card, '全局累計資金費', amount(trader.fundingTotal, trader.fundingTotalPartial), signedClass(trader.fundingTotal));
    row(doc, card, '累計資料', trader.totalsStatus === 'complete' ? 'complete／完整' : 'partial／資料不完整');
    if (trader.hasApiCost) {
      const usd = value => value === null ? '—' : `${fixed(value, 4)} USD`;
      row(doc, card, '交易損益', trader.netPnl === null ? '—' : `${trader.netPnl > 0 ? '+' : ''}${fixed(trader.netPnl, 4)} USDT`, signedClass(trader.netPnl));
      row(doc, card, 'AI 花費（另計）', usd(trader.apiCostTotal));
      card.append(element(doc, 'div', `GPT ${usd(trader.apiCostGpt)}／Claude ${usd(trader.apiCostClaude)}`, 'api-cost-detail'),
        element(doc, 'div', `資料時間 ${trader.apiCostUpdated === null ? '—' : taipeiTime(trader.apiCostUpdated) + ' 台灣'}`, 'api-cost-detail'));
      if (trader.apiCostIsAccountDebit === false) card.append(element(doc, 'div', 'AI 額度的花費，不從交易帳戶扣', 'api-cost-detail'));
    } else {
      const settlementSummary = element(doc, 'div', null, 'settlement-summary');
      settlementSummary.dataset.trader = trader.name;
      card.append(settlementSummary);
    }
    row(doc, card, '今日筆數', view.today);
    row(doc, card, '近 1 小時', view.lastHour);
    const status = freshness(trader, now, staleAfterMs);
    const state = element(doc, 'div', status.text, `trader-status ${status.className}`);
    state.dataset.traderStatus = trader.name;
    card.append(state, element(doc, 'div', taipeiTime(trader.updated), 'trader-updated'));
    return card;
  }

  function renderTradeRow(doc, trade, index) {
    const line = element(doc, 'tr');
    line.style.animationDelay = `${0.3 + Math.min(index, 12) * 0.08}s`;
    const time = trade.timeLabel || (trade.timestamp === null ? trade.time || '—' : new Date(trade.timestamp).toLocaleTimeString(
      'zh-TW', { timeZone: TIME_ZONE, hour12: false }));
    const timeCell = element(doc, 'td', time);
    timeCell.title = taipeiTime(trade.timestamp);
    line.append(timeCell);
    for (const text of [trade.trader, trade.market, trade.side, price(trade.price), trade.qty]) {
      line.append(element(doc, 'td', text));
    }
    const pnl = trade.pnl === null ? '—' : `${trade.pnl.toFixed(4)} ${currencyText(trade.pnlCurrency)}`;
    line.append(element(doc, 'td', pnl, signedClass(trade.pnl)), element(doc, 'td', trade.note));
    return line;
  }

  function renderRows(doc, container, trades) {
    const fragment = doc.createDocumentFragment();
    for (const [index, trade] of trades.slice().reverse().entries()) {
      fragment.append(renderTradeRow(doc, trade, index));
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

  function tradeGroupLabel(trade, mode) {
    if (mode === 'trader') return trade.trader || '交易員未提供';
    if (mode === 'market') return !trade.market || trade.market === '—' ? '幣種未提供' : trade.market.split('-')[0] || '幣種未提供';
    if (mode === 'action') {
      if (trade.event === 'open' || trade.event === 'close') return `${trade.event === 'open' ? '開倉' : '平倉'}${trade.side ? ' ' + trade.side : ''}`;
      if (['開多', '開空'].includes(trade.side)) return '開倉';
      if (['平多', '平空', '部分強平多', '部分強平空', '強平多', '強平空', '減倉平多', '減倉平空'].includes(trade.side)) return '平倉';
      return '其他';
    }
    if (mode === 'result') {
      return trade.pnl === null || !Number.isFinite(trade.pnl) ? '損益未提供'
        : trade.pnl > 0 ? '賺' : trade.pnl < 0 ? '賠' : '持平';
    }
    return '全部';
  }

  function groupedAmount(trades, field, currencyField) {
    const totals = new Map();
    let incomplete = false;
    for (const trade of trades) {
      const value = trade[field];
      const currency = trade[currencyField];
      if (!Number.isFinite(value) || !currency) {
        incomplete = true;
        continue;
      }
      totals.set(currency, (totals.get(currency) || 0) + (field === 'fee' ? -value : value));
    }
    const text = [...totals].map(([currency, value]) => {
      if (!Number.isFinite(value)) {
        incomplete = true;
        return `— ${currency}`;
      }
      const rounded = Number(value.toPrecision(12));
      return `${rounded > 0 ? '+' : ''}${rounded} ${currency}`;
    }).join('、') || '—';
    return text + (incomplete ? '（資料不完整）' : '');
  }

  function groupTrades(trades, mode) {
    const groups = new Map();
    // The first group and its fills follow the same newest-first order as 全部.
    for (const trade of trades.slice().reverse()) {
      const label = tradeGroupLabel(trade, mode);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(trade);
    }
    return [...groups].map(([label, items]) => ({
      label, key: `${mode}:${label}`, trades: items,
      pnl: groupedAmount(items, 'pnl', 'pnlCurrency'),
      fees: groupedAmount(items, 'fee', 'feeCurrency')
    }));
  }

  function renderGroupedRows(doc, container, trades, mode = 'all', state = { days: new Map(), rows: new Set() }, now = Date.now(), phone = root.matchMedia?.('(max-width: 600px)').matches === true) {
    for (const group of container.querySelectorAll?.('.ledger-day') || []) state.days.set(group.dataset.day, group.open);
    const days = new Map();
    const occurrences = new Map();
    for (const trade of trades.slice().reverse()) {
      const keyBase = JSON.stringify([trade.tradeId, trade.trader, trade.timestamp, trade.market, trade.side, trade.event, trade.price, trade.qty]);
      const occurrence = occurrences.get(keyBase) || 0;
      occurrences.set(keyBase, occurrence + 1);
      const key = keyBase + ':' + occurrence;
      const filters = typeof mode === 'string' ? {
        trader: new Set(['A', 'B'].includes(mode) ? [mode] : []),
        result: new Set(['profit', 'loss'].includes(mode) ? [mode] : []), action: new Set()
      } : mode;
      const action = trade.event === 'partial_close' ? 'partial_close' : trade.event === 'close' ? 'close' : trade.event === 'open' ? 'open' : '';
      if (filters.trader.size && !filters.trader.has(trade.trader.replace('Grok-Trader-', ''))) continue;
      if (filters.result.size && !((trade.pnl > 0 && filters.result.has('profit')) || (trade.pnl < 0 && filters.result.has('loss')))) continue;
      if (filters.action.size && !filters.action.has(action)) continue;
      const date = trade.timestamp == null ? '日期未提供' : day(trade.timestamp);
      if (!days.has(date)) days.set(date, []);
      days.get(date).push({ trade, key });
    }
    const groups = [];
    for (const [date, items] of days) {
      const group = element(doc, 'details', null, 'ledger-day');
      group.dataset.day = date;
      group.open = state.days.has(date) ? state.days.get(date) : date === day(now);
      group.addEventListener('toggle', () => { if (group.isConnected !== false) state.days.set(date, group.open); });
      const closes = items.map(({ trade }) => trade).filter(trade => trade.event === 'close' || trade.event === 'partial_close');
      const amounts = closes.filter(trade => Number.isFinite(trade.pnl));
      const total = amounts.filter(trade => trade.pnlCurrency === 'USDT').reduce((sum, trade) => sum + trade.pnl, 0);
      const incomplete = closes.some(trade => !Number.isFinite(trade.pnl));
      const net = amounts.some(trade => trade.pnlCurrency === 'USDT') && Number.isFinite(total)
        ? `${total >= 0 ? '+' : ''}${total.toFixed(4)}` : '—';
      const label = date === '日期未提供' ? date : date.slice(5).replace('-', '/');
      group.append(element(doc, 'summary', `${label}（${items.length} 筆，淨 ${net} USDT${incomplete ? '，資料不完整' : ''}）`));
      const scroll = element(doc, 'div', null, 'ledger-scroll');
      const table = element(doc, 'table');
      const head = element(doc, 'thead');
      const headings = element(doc, 'tr');
      for (const title of ['TIME', 'TRADER', 'MARKET', 'SIDE', 'PRICE', 'QTY', 'PNL']) headings.append(element(doc, 'th', title));
      head.append(headings);
      const body = element(doc, 'tbody');
      for (const { trade, key } of items) {
        const line = element(doc, 'tr', null, 'ledger-trade');
        const time = trade.timestamp == null ? '—' : new Intl.DateTimeFormat('en-GB', {
          timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).format(trade.timestamp);
        const trader = trade.trader === 'Grok-Trader-A' ? 'A' : trade.trader === 'Grok-Trader-B' ? 'B' : trade.trader;
        const pnl = trade.pnl == null ? '—' : `${trade.pnl.toFixed(4)} ${currencyText(trade.pnlCurrency)}`;
        for (const value of [time, trader, trade.market, trade.side, price(trade.price), trade.qty, pnl]) {
          const cell = element(doc, 'td', value);
          cell.title = value;
          line.append(cell);
        }
        const detail = element(doc, 'tr', null, 'ledger-trade-detail');
        const cell = element(doc, 'td');
        cell.colSpan = 7;
        for (const [label, value] of [['開倉理由', trade.openReason], ['平倉理由', trade.closeReason], ['NOTE', trade.note]]) {
          if (value) cell.append(element(doc, 'p', `${label}：${value}`));
        }
        if (!cell.children.length) cell.append(element(doc, 'p', '沒有提供說明'));
        detail.append(cell);
        line.dataset.morphKey = key + ':line';
        detail.dataset.morphKey = key + ':detail';
        line.tabIndex = 0;
        line.setAttribute('role', 'button');
        function update() {
          const open = state.rows.has(key);
          line.setAttribute('aria-expanded', String(open));
          detail.hidden = !open;
        }
        function toggle() {
          if (state.rows.has(key)) state.rows.delete(key); else state.rows.add(key);
          update();
        }
        line.addEventListener('click', toggle);
        line.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
        update();
        body.append(line, detail);
      }
      table.append(head, body);
      scroll.append(table);
      group.append(scroll);
      groups.push(group);
    }
    if (!groups.length) groups.push(element(doc, 'p', '目前沒有可顯示的交易紀錄', 'muted'));
    morph(container, groups);
  }

  async function fetchPair(fetcher, previous, signal, nonce) {
    const responses = await Promise.all(['data.json', 'history.json'].map(file => fetcher(
      `${file}?v=${nonce}`, { cache: 'no-store', signal }
    )));
    if (responses.some(response => !response.ok)) throw new Error('Snapshot HTTP error');
    const [data, history] = await Promise.all(responses.map(response => response.json()));
    return pairSnapshot(data, history, previous);
  }

  // Single-column layout lists the notes right after the trader cards; wider layouts keep them below the ledger.
  function placeNotesShelf(shelf, cards, ledger, afterCards) {
    const anchor = afterCards ? cards : ledger;
    // Mobile scrolling fires resize; re-inserting an unmoved shelf would drop focus inside the notes.
    if (shelf && anchor && anchor.nextElementSibling !== shelf) anchor.after(shelf);
  }

  // Keep existing nodes (and their focus, scroll and open state) when data changes.
  function morph(container, nodes) {
    if (!container.childNodes || !container.insertBefore) { container.replaceChildren(...nodes); return; }
    const key = node => node.nodeType === 1 && (node.dataset?.morphKey || node.dataset?.layoutKey || node.dataset?.noteKey || node.dataset?.day || node.dataset?.trader);
    function sync(parent, desired) {
      const keyed = new Map();
      for (const node of parent.childNodes) {
        const id = key(node);
        if (id && !keyed.has(id)) keyed.set(id, node);
      }
      let cursor = parent.firstChild;
      for (const fresh of desired) {
        const id = key(fresh);
        let old = id ? keyed.get(id) : cursor;
        if (id) keyed.delete(id);
        if (old && (old.nodeName !== fresh.nodeName || (!id && key(old)))) old = null;
        if (!old) { parent.insertBefore(fresh, cursor); continue; }
        if (old !== cursor) parent.insertBefore(old, cursor);
        if (old.nodeType === 3) {
          if (old.textContent !== fresh.textContent) old.textContent = fresh.textContent;
        } else if (old.nodeType === 1) {
          for (const attr of Array.from(old.attributes)) if (!fresh.hasAttribute(attr.name)) old.removeAttribute(attr.name);
          for (const attr of Array.from(fresh.attributes)) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
          if (!old.classList.contains('settlement-summary')) sync(old, Array.from(fresh.childNodes));
        }
        cursor = old.nextSibling;
      }
      while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    }
    sync(container, nodes);
  }
  root.RaceMorph = morph;

  function createRenderScheduler(doc, options = {}) {
    const clock = options.now || Date.now;
    const delay = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    let lastActivity = -Infinity;
    let timer;
    const pending = new Map();
    function flush() {
      const remaining = 2000 - (clock() - lastActivity);
      if (remaining > 0) { timer = delay(flush, remaining); return; }
      timer = undefined;
      const work = [...pending.values()];
      pending.clear();
      work.forEach(render => { try { render(); } catch (error) { root.console.error(error); } });
    }
    for (const type of ['touchstart', 'touchmove', 'wheel', 'scroll', 'pointerdown']) {
      doc.addEventListener(type, () => {
        lastActivity = clock();
        if (pending.size) { cancel(timer); timer = delay(flush, 2000); }
      }, { passive: true, capture: type === 'scroll' });
    }
    const schedule = (container, render) => {
      pending.set(container, render);
      if (timer !== undefined) cancel(timer);
      flush();
    };
    schedule.now = (container, render) => { pending.delete(container); render(); };
    return schedule;
  }
  let scheduleRender = (_container, render) => render();
  function stableRender(container, render) { scheduleRender(container, render); }
  stableRender.now = (container, render) => scheduleRender.now ? scheduleRender.now(container, render) : render();
  root.RaceStable = stableRender;

  function restoreSavedScroll(doc, page = root) {
    const key = 'race-dashboard-scroll';
    try {
      const saved = JSON.parse(page.sessionStorage.getItem(key) || 'null');
      if (!saved || !Number.isFinite(saved.y)) return () => {};
      page.history.scrollRestoration = 'manual';
      let pending = true;
      let timer, deadline, visibleSince;
      let remaining = 3000;
      let started = false;
      const events = ['touchstart', 'touchmove', 'wheel', 'scroll', 'pointerdown'];
      function finish() {
        if (!pending) return;
        pending = false;
        page.clearTimeout(timer);
        page.clearTimeout(deadline);
        events.forEach(type => doc.removeEventListener(type, finish, true));
        doc.removeEventListener('visibilitychange', visibilityChanged);
        page.history.scrollRestoration = 'auto';
        try { page.sessionStorage.removeItem(key); } catch (_) {}
      }
      events.forEach(type => doc.addEventListener(type, finish, { passive: true, capture: true }));
      const now = () => (page.Date || Date).now();
      function attempt(giveUp = false) {
        if (!pending || doc.visibilityState === 'hidden') return;
        if (!doc.querySelector('.wrap')?.classList.contains('is-loading')) {
          const section = saved.id && doc.getElementById(saved.id);
          const target = Math.max(0, section && Number.isFinite(saved.offset) ? page.scrollY + section.getBoundingClientRect().top - saved.offset : saved.y);
          const max = Math.max(0, doc.documentElement.scrollHeight - page.innerHeight);
          if (max >= target || giveUp) {
            finish();
            page.scrollTo(0, Math.min(target, max));
            return;
          }
        }
        if (giveUp) finish();
        else timer = page.setTimeout(attempt, 50);
      }
      function visibilityChanged() {
        if (!pending || !started) return;
        if (doc.visibilityState === 'hidden') {
          remaining = Math.max(0, remaining - (now() - visibleSince));
          page.clearTimeout(timer);
          page.clearTimeout(deadline);
        } else {
          visibleSince = now();
          deadline = page.setTimeout(() => attempt(true), remaining);
          attempt();
        }
      }
      doc.addEventListener('visibilitychange', visibilityChanged);
      return () => {
        if (!pending || started) return;
        started = true;
        if (doc.visibilityState !== 'hidden') visibilityChanged();
      };
    } catch (_) { return () => {}; }
  }

  // shortcut: 32-bit collisions are possible; use a stronger hash if missed deploys justify it.
  function versionFingerprint(texts) {
    let hash = 2166136261;
    const text = texts.join('\n');
    for (let index = 0; index < text.length; index++) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  async function fetchVersionFingerprint(fetcher, signal, cache = 'reload') {
    const responses = await Promise.all(VERSION_FILES.map(file => fetcher(file, { cache, signal })));
    if (responses.some(response => response.status !== 200)) throw new Error('Version check HTTP error');
    return versionFingerprint(await Promise.all(responses.map(response => response.text())));
  }

  function startVersionCheck(doc, options = {}) {
    const fetcher = options.fetcher || (typeof root.fetch === 'function' ? root.fetch.bind(root) : () => Promise.reject(new Error('Fetch unavailable')));
    const clock = options.now || Date.now;
    const delay = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    const schedule = options.setInterval || root.setInterval.bind(root);
    const page = options.location || root.location;
    let initialFingerprint = null;
    let checking = false;
    let reloadPending = false;
    let lastActivity = clock();
    let reloadTimer;
    const pointers = new Set();
    let touching = false;
    const activity = () => { lastActivity = clock(); };
    for (const type of ['touchmove', 'scroll', 'pointermove', 'wheel']) doc.addEventListener(type, activity, { passive: true });
    doc.addEventListener('touchstart', () => { touching = true; activity(); }, { passive: true });
    for (const type of ['touchend', 'touchcancel']) doc.addEventListener(type, event => { touching = !!event.touches?.length; activity(); }, { passive: true });
    doc.addEventListener('pointerdown', event => { pointers.add(event.pointerId); activity(); }, { passive: true });
    for (const type of ['pointerup', 'pointercancel']) doc.addEventListener(type, event => { pointers.delete(event.pointerId); activity(); }, { passive: true });

    function reloadWhenSafe() {
      if (!reloadPending) return;
      const remaining = 30000 - (clock() - lastActivity);
      if (doc.visibilityState !== 'hidden' && (remaining > 0 || touching || pointers.size)) {
        reloadTimer = delay(reloadWhenSafe, Math.max(remaining, 1000));
        return;
      }
      try {
        const storage = options.sessionStorage === undefined ? root.sessionStorage : options.sessionStorage;
        const visible = doc.elementFromPoint?.(20, 1);
        const ids = ['cards', 'notes-shelf', 'positions', 'watchlist', 'rows'];
        const found = visible?.closest?.('[id]');
        let section = ids.includes(found?.id) ? found : visible?.closest?.(ids.map(id => `#${id}`).join(','));
        if (!section) {
          section = ids.map(id => doc.getElementById(id)).filter(Boolean).map(node => ({ node, rect: node.getBoundingClientRect() }))
            .filter(({ rect }) => rect.bottom > rect.top)
            .sort((a, b) => Math.max(a.rect.top - 1, 1 - a.rect.bottom, 0) - Math.max(b.rect.top - 1, 1 - b.rect.bottom, 0))[0]?.node;
        }
        storage?.setItem('race-dashboard-scroll', JSON.stringify({ y: root.scrollY || 0, id: section?.id || '', offset: section?.getBoundingClientRect().top }));
        storage?.setItem(VERSION_RELOAD_KEY, String(clock()));
      } catch (_) {}
      page.reload();
    }

    async function check() {
      if (doc.visibilityState === 'hidden' || checking || reloadPending) return false;
      checking = true;
      let timeout;
      try {
        const controller = new root.AbortController();
        const timedOut = new Promise((_, reject) => {
          timeout = delay(() => {
            controller.abort();
            reject(new Error('Version check timed out'));
          }, 10000);
        });
        const versionCheck = initialFingerprint === null
          ? fetchVersionFingerprint(fetcher, controller.signal, 'force-cache')
            .catch(() => null)
            .then(cached => fetchVersionFingerprint(fetcher, controller.signal)
              .then(current => ({ current, baseline: cached || current })))
          : fetchVersionFingerprint(fetcher, controller.signal).then(current => ({ current, baseline: null }));
        const { current, baseline } = await Promise.race([versionCheck, timedOut]);
        if (doc.visibilityState === 'hidden') return false;
        if (initialFingerprint === null) {
          initialFingerprint = baseline;
        }
        if (current === initialFingerprint) return false;

        let storage;
        try { storage = options.sessionStorage === undefined ? root.sessionStorage : options.sessionStorage; } catch (_) {}
        try {
          const saved = storage?.getItem(VERSION_RELOAD_KEY);
          const lastReload = saved === null || saved === undefined ? null : Number(saved);
          if (lastReload !== null && Number.isFinite(lastReload) && clock() - lastReload < VERSION_RELOAD_COOLDOWN_MS) return false;
        } catch (_) {}

        reloadPending = true;
        const status = doc.getElementById('data-status');
        if (status) {
          status.textContent = '網頁有新版本，重新載入中…';
          status.className = 'data-status muted';
        }
        reloadTimer = delay(reloadWhenSafe, 100);
        return true;
      } catch (_) {
        return false;
      } finally {
        if (timeout !== undefined) cancel(timeout);
        checking = false;
      }
    }

    const ready = check();
    schedule(check, VERSION_CHECK_MS);
    doc.addEventListener('visibilitychange', () => {
      if (reloadPending && doc.visibilityState === 'hidden') { cancel(reloadTimer); reloadWhenSafe(); }
      else if (doc.visibilityState !== 'hidden') return check();
    });
    return { check, ready };
  }

  function start(doc, restoreScroll = restoreSavedScroll(doc)) {
    scheduleRender = createRenderScheduler(doc);
    const clock = doc.getElementById('clk');
    const status = doc.getElementById('data-status');
    const updatedLine = doc.getElementById('data-updated');
    const cards = doc.getElementById('cards');
    const rows = doc.getElementById('rows');
    const chartStatus = doc.getElementById('chart-status');
    const canvas = doc.getElementById('eqc');
    const layout = root.RaceLayout?.mount(doc);
    const ledgerFilters = doc.getElementById('ledger-filters');
    const ledgerOpenGroups = { days: new Map(), rows: new Set() };
    const ledgerMode = { trader: new Set(), result: new Set(), action: new Set() };
    let filterHeight = 0;
    const rememberFilterHeight = () => {
      if (!Object.values(ledgerMode).some(group => group.size) || !ledger) return;
      const height = ledger.getBoundingClientRect().height;
      if (height > filterHeight) { filterHeight = height; ledger.style.minHeight = `${height}px`; }
    };
    const noteColumns = ['notes-a', 'notes-b'].map(id => doc.getElementById(id));
    const ledger = doc.querySelector('.ledger-section');
    if (ledger && root.ResizeObserver) new root.ResizeObserver(rememberFilterHeight).observe(ledger);
    function placeNotes() {
      const shelf = doc.getElementById('notes-shelf');
      const style = root.getComputedStyle(cards);
      const wideNotes = style.getPropertyValue('--notes-sides').trim() === '1';
      placeNotesShelf(shelf, cards, ledger, style.getPropertyValue('--notes-after-cards').trim() === '1');
      noteColumns.forEach((node, index) => {
        const trader = index === 0 ? 'Grok-Trader-A' : 'Grok-Trader-B';
        const panel = Array.from(cards.children).find(item => item.dataset.trader === trader);
        const target = wideNotes && panel ? panel : shelf;
        if (node && target && node.parentElement !== target) target.append(node);
      });
    }
    root.addEventListener('resize', () => stableRender(doc.getElementById('notes-shelf'), placeNotes));
    // Notes load independently of the snapshot, so place them before the first refresh too.
    placeNotes();
    doc.addEventListener('race:notes-updated', event => layout?.updateNotes(event.detail));
    ledgerFilters?.addEventListener('click', event => {
      const button = event.target.closest('button[data-ledger-mode]');
      if (!button || !ledgerFilters.contains(button)) return;
      const selected = ledgerMode[button.dataset.ledgerGroup];
      if (!selected) return;
      const value = button.dataset.ledgerMode;
      const wasFiltering = Object.values(ledgerMode).some(group => group.size);
      if (!wasFiltering) filterHeight = ledger?.getBoundingClientRect().height || 0;
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      const filtering = Object.values(ledgerMode).some(group => group.size);
      if (filtering) {
        filterHeight = Math.max(filterHeight, ledger?.getBoundingClientRect().height || 0);
        if (ledger) ledger.style.minHeight = `${filterHeight}px`;
      } else { filterHeight = 0; if (ledger) ledger.style.minHeight = ''; }
      button.setAttribute('aria-pressed', String(selected.has(value)));
      if (current) stableRender.now(rows, () => renderGroupedRows(doc, rows, current.trades, ledgerMode, ledgerOpenGroups));
    });
    let current = null;
    let lastError = false;
    let loading = false;
    let chart = null;
    let initialPaintPending = true;
    let ledgerAges = '';
    const ledgerAgeState = () => day(Date.now());
    const visibleData = value => JSON.stringify(value, (key, item) => key === 'heldSeconds' ? undefined : item);

    function updateStatus() {
      clock.textContent = taipeiTime(Date.now()) + ' 台灣';
      if (!current) {
        status.textContent = lastError ? '暫時無法讀取資料，將自動重試。' : '正在讀取資料…';
        status.className = `data-status ${lastError ? 'neg' : 'muted'}`;
        return;
      }
      // Runs every second, so the line turns red after 30 minutes even if refreshes keep failing.
      if (updatedLine) renderUpdated(updatedLine, current.generatedAt);
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
        const previous = current;
        const hadPrevious = previous !== null;
        current = next;
        lastError = false;
        if (!previous || visibleData([previous.traders, previous.trades, previous.staleAfterMs]) !== visibleData([current.traders, current.trades, current.staleAfterMs])) stableRender(cards, () => {
        for (const trader of current.traders) {
          let panel = Array.from(cards.children).find(item => item.dataset.trader === trader.name);
          if (!panel) {
            panel = element(doc, 'section', null, 'trader-panel');
            panel.dataset.trader = trader.name;
            cards.append(panel);
          }
          const card = renderCard(doc, trader, current.trades, Date.now(), current.staleAfterMs);
          if (panel.firstElementChild) morph(panel.firstElementChild, Array.from(card.childNodes));
          else panel.append(card);
        }
        placeNotes();
        doc.dispatchEvent(new Event('race:cards-updated'));
        if (hadPrevious) cards.classList.add('is-ready');
        });
        layout?.updateSnapshot(current);
        if (!previous || visibleData(previous.trades) !== visibleData(current.trades)) {
          ledgerAges = ledgerAgeState(current.trades);
          stableRender(rows, () => renderGroupedRows(doc, rows, current.trades, ledgerMode, ledgerOpenGroups));
        }
        if (!previous || JSON.stringify([previous.series, previous.traders.map(t => t.currency), previous.staleAfterMs]) !== JSON.stringify([current.series, current.traders.map(t => t.currency), current.staleAfterMs])) stableRender(canvas, () => {
          try { updateChart(current); } catch (_) {
          chartStatus.textContent = '圖表更新失敗；帳戶與交易資料仍可更新。';
          }
        });
      } catch (_) {
        lastError = true;
      } finally {
        loading = false;
        updateStatus();
        if (initialPaintPending) {
          initialPaintPending = false;
          Promise.resolve().then(() => Promise.allSettled([layout?.ready, root.RaceNotesReady])).then(() => stableRender(doc, () => {
            doc.querySelector('.wrap')?.classList.remove('is-loading');
            restoreScroll();
          }));
        }
      }
    }

    updateStatus();
    refresh();
    setInterval(updateStatus, 1000);
    setInterval(refresh, REFRESH_MS);
    setInterval(() => {
      if (current && ledgerAgeState(current.trades) !== ledgerAges) {
        ledgerAges = ledgerAgeState(current.trades);
        stableRender(rows, () => renderGroupedRows(doc, rows, current.trades, ledgerMode, ledgerOpenGroups));
      }
    }, 60000);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    return { refresh };
  }

  const api = { start, morph, number, timestamp, price, shortTaipeiTime, renderUpdated, pairSnapshot, freshness, traderView, renderCard, renderRows, groupTrades, renderGroupedRows, fetchPair, placeNotesShelf, stableRender, createRenderScheduler, restoreSavedScroll, startVersionCheck };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    const begin = () => {
      const restoreScroll = restoreSavedScroll(document);
      root.setTimeout(() => {
        document.querySelector('.wrap')?.classList.remove('is-loading');
        restoreScroll();
      }, 15000);
      try { start(document, restoreScroll); } catch (error) { root.console.error(error); }
    };
    try { startVersionCheck(document); } catch (error) { root.console.error(error); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
    else begin();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Notes refresh independently of the paired financial snapshots.
(function (root) {
  'use strict';

  const TRADERS = ['Grok-Trader-A', 'Grok-Trader-B'];
  const KINDS = { open: '開倉', close: '平倉', daily: '日報', daily_settlement: '每日結算' };
  const DAILY_TEXT = ['market_recap', 'trade_review', 'watch_next', 'strategy_adjustments'];
  const REASON_FIELDS = ['funding_rate', 'open_interest', 'key_levels', 'volume', 'events'];
  const VARIANCE_FIELDS = ['right', 'wrong', 'lesson'];
  const POSITION_FIELDS = ['instrument', 'direction', 'leverage', 'entry_price', 'stop_loss', 'take_profit',
    'max_loss_usdt', 'reasons', 'confidence', 'invalidation'];
  const OPEN_KEYS = ['trader', 'ts', 'kind', ...POSITION_FIELDS];
  const CLOSE_KEYS = ['trader', 'ts', 'kind', 'review', 'realized_pnl_usdt', 'variance'];
  const DAILY_KEYS = ['trader', 'ts', 'kind', ...DAILY_TEXT];
  const SETTLEMENT_KEYS = ['trader', 'ts', 'kind', 'date', 'trades', 'table'];
  const NUMBER_FIELDS = ['realized_pnl', 'unrealized_pnl', 'fees', 'funding', 'api_cost_total', 'net_after_costs'];
  const TABLE_KEYS = [...NUMBER_FIELDS, 'api_cost_by_model'];
  const TRADE_KEYS = ['instrument', 'direction', 'pnl'];
  const OPENAI_MODEL = /^(?:gpt|chatgpt|o[1-9]|text-embedding|whisper|tts|dall-e)(?:[-.][A-Za-z0-9]{1,16})+$/;
  const MAX_BYTES = 1024 * 1024;
  const MAX_TEXT = 1500;
  const STALE_MS = 48 * 60 * 60 * 1000;
  const REFRESH_MS = 30000;
  const HIGHLIGHT = 32;

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, keys) {
    return record(value) && Object.keys(value).length === keys.length &&
      keys.every(key => Object.hasOwn(value, key));
  }

  function codePoints(text) {
    return Array.from(text).length;
  }

  function blank(value) {
    return typeof value !== 'string' || value.trim() === '';
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function symbolOk(value) {
    return typeof value === 'string' && value.trim() === value && value.length > 0 &&
      codePoints(value) <= 64 && !/[\s]/u.test(value);
  }

  function positionShape(body) {
    if (!symbolOk(body.instrument) ||
        (body.direction !== 'long' && body.direction !== 'short')) return false;
    if (['leverage', 'entry_price', 'stop_loss', 'take_profit'].some(field => !finiteNumber(body[field]) || body[field] <= 0)) return false;
    if (!finiteNumber(body.max_loss_usdt) || body.max_loss_usdt < 0) return false;
    if (!exactKeys(body.reasons, REASON_FIELDS) || REASON_FIELDS.some(field => blank(body.reasons[field]))) return false;
    if (blank(body.confidence) || codePoints(body.confidence) > 80 || blank(body.invalidation)) return false;
    return true;
  }

  function positionStrings(body) {
    return [body.instrument, body.confidence, body.invalidation, ...REASON_FIELDS.map(field => body.reasons[field])];
  }

  function noteStrings(note) {
    if (note.kind === 'daily') return DAILY_TEXT.map(field => note[field]);
    if (note.kind === 'open') return positionStrings(note);
    if (note.kind === 'close') return [...positionStrings(note.review), ...VARIANCE_FIELDS.map(field => note.variance[field])];
    return [];
  }

  function textWithinLimit(note) {
    const values = noteStrings(note);
    return values.every(value => typeof value === 'string') &&
      values.reduce((length, value) => length + codePoints(value), 0) <= MAX_TEXT;
  }

  function noteShape(note) {
    if (!record(note) || !TRADERS.includes(note.trader) ||
        typeof note.ts !== 'number' || !Number.isFinite(note.ts) || note.ts <= 0 || note.ts > 253402300799) return false;
    if (note.kind === 'daily_settlement') {
      return exactKeys(note, SETTLEMENT_KEYS) && validDate(note.date) && tableShape(note.table, true) && tradesShape(note.trades);
    }
    if (note.kind === 'open') return exactKeys(note, OPEN_KEYS) && positionShape(note) && textWithinLimit(note);
    if (note.kind === 'close') {
      return exactKeys(note, CLOSE_KEYS) && exactKeys(note.review, POSITION_FIELDS) && positionShape(note.review) &&
        finiteNumber(note.realized_pnl_usdt) && exactKeys(note.variance, VARIANCE_FIELDS) &&
        VARIANCE_FIELDS.every(field => !blank(note.variance[field])) && textWithinLimit(note);
    }
    return exactKeys(note, DAILY_KEYS) && note.kind === 'daily' &&
      DAILY_TEXT.every(field => !blank(note[field])) && textWithinLimit(note);
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function nullableNumber(value) {
    return value === null || finiteNumber(value);
  }

  function tableShape(table, withCumulative = false) {
    if (!exactKeys(table, withCumulative ? [...TABLE_KEYS, 'cum'] : TABLE_KEYS) ||
        !NUMBER_FIELDS.every(field => nullableNumber(table[field])) ||
        (table.api_cost_total !== null && table.api_cost_total < 0) || !record(table.api_cost_by_model)) return false;
    const models = Object.entries(table.api_cost_by_model);
    if (models.length > 50 || !models.every(([model, cost]) => model.trim() === model && codePoints(model) > 0 &&
        codePoints(model) <= 80 && nullableNumber(cost) && (cost === null || cost >= 0))) return false;
    return !withCumulative || tableShape(table.cum);
  }

  function tradesShape(trades) {
    if (!Array.isArray(trades) || trades.length > 100) return false;
    return trades.every(trade => exactKeys(trade, TRADE_KEYS) && symbolOk(trade.instrument) &&
      (trade.direction === 'long' || trade.direction === 'short') && finiteNumber(trade.pnl));
  }

  function suspiciousText(text, modelName = false) {
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text.replace(/[\t\r\n]/g, ''))) return true;
    const normalized = text.normalize('NFKC');
    return /(?:\b(?:api[ _-]?key|secret(?:[ _-]?key)?|(?:access[ _-]?)?token|uid|passphrase)\b|金鑰|私鑰)\s*[:=]\s*\S/iu.test(normalized) ||
      /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+\S+|-----BEGIN/iu.test(normalized) ||
      /[0-9]{8,}/u.test(normalized) ||
      (!(modelName && codePoints(normalized) <= 80 && OPENAI_MODEL.test(normalized)) && /[A-Za-z0-9_+/=-]{32,}/u.test(normalized));
  }

  function safeNote(note) {
    if (!noteShape(note)) return false;
    if (note.kind === 'daily_settlement') {
      const instruments = note.trades.map(trade => trade.instrument);
      return [note.table, note.table.cum].every(table =>
        Object.keys(table.api_cost_by_model).every(model => !suspiciousText(model, true))) &&
        instruments.every(text => !suspiciousText(text));
    }
    const values = noteStrings(note);
    return values.every(value => !suspiciousText(value)) && !suspiciousText(values.join(''));
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

  function decimal(value) {
    if (!finiteNumber(value)) return '未知';
    if (value !== 0 && (Math.abs(value) < 1e-8 || Math.abs(value) >= 1e12)) return value.toExponential(3);
    return String(value);
  }

  function sideLabel(direction) {
    return direction === 'long' ? '多' : '空';
  }

  function clip(text) {
    const points = Array.from(text);
    return points.length <= HIGHLIGHT ? text : points.slice(0, HIGHLIGHT).join('') + '…';
  }

  function highlight(note) {
    if (note.kind === 'open') {
      return `${note.instrument} ${sideLabel(note.direction)} ${decimal(note.leverage)}x 進場 ${decimal(note.entry_price)}`;
    }
    if (note.kind === 'close') {
      return `${note.review.instrument} ${sideLabel(note.review.direction)} 已實現 ${decimal(note.realized_pnl_usdt)} USDT`;
    }
    if (note.kind === 'daily_settlement') {
      return `${note.date} ${note.trades.length} 筆 交易損益減 AI 花費（對照用；AI 花費不從交易帳戶扣） ${amount(note.table.net_after_costs)} USDT`;
    }
    return clip(note.market_recap);
  }

  function noteKey(note) {
    if (note.kind === 'daily_settlement') return `${note.trader}|settlement|${note.date}`;
    if (note.kind === 'open') return `${note.trader}|open|${note.ts}|${note.instrument}|${note.invalidation}`;
    if (note.kind === 'close') return `${note.trader}|close|${note.ts}|${note.review.instrument}|${note.variance.lesson}`;
    return `${note.trader}|daily|${note.ts}|${note.market_recap}|${note.watch_next}`;
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
    line('交易損益減 AI 花費（對照用；AI 花費不從交易帳戶扣）（USDT）', note.table.net_after_costs, note.table.cum.net_after_costs);
    table.append(head, body);
    return table;
  }

  function renderTrades(doc, note) {
    const wrap = element(doc, 'div', undefined, 'settlement-trades-wrap');
    if (!note.trades.length) {
      wrap.append(element(doc, 'p', '當日沒有列示成交', 'settlement-empty-trades'));
      return wrap;
    }
    const table = element(doc, 'table', undefined, 'settlement-trades');
    const head = element(doc, 'thead');
    const header = element(doc, 'tr');
    ['標的', '方向', '損益（USDT）'].forEach(label => header.append(element(doc, 'th', label)));
    head.append(header);
    const body = element(doc, 'tbody');
    for (const trade of note.trades) {
      const row = element(doc, 'tr');
      row.append(element(doc, 'th', trade.instrument), element(doc, 'td', sideLabel(trade.direction)),
        element(doc, 'td', amount(trade.pnl)));
      body.append(row);
    }
    const sum = note.trades.reduce((total, trade) => total + trade.pnl, 0);
    const total = element(doc, 'tr', undefined, 'settlement-trade-total');
    total.append(element(doc, 'th', '列示交易損益合計（USDT）'), element(doc, 'td', String(note.trades.length) + ' 筆'),
      element(doc, 'td', amount(sum)));
    body.append(total);
    table.append(head, body);
    wrap.append(table, element(doc, 'p', '列示交易損益合計由頁面加總，不呼叫模型。', 'settlement-computed'));
    return wrap;
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

  function appendField(doc, parent, label, value) {
    const section = element(doc, 'div', undefined, 'note-field');
    section.append(element(doc, 'strong', label), element(doc, 'p', value));
    parent.append(section);
  }

  function appendPosition(doc, parent, source) {
    appendField(doc, parent, '標的', source.instrument);
    appendField(doc, parent, '方向', sideLabel(source.direction));
    appendField(doc, parent, '槓桿', decimal(source.leverage) + 'x');
    appendField(doc, parent, '進場價', decimal(source.entry_price));
    appendField(doc, parent, '最大虧損（USDT）', decimal(source.max_loss_usdt));
    parent.append(element(doc, 'p', '數據理由', 'note-section'));
    appendField(doc, parent, '資金費率', source.reasons.funding_rate);
    appendField(doc, parent, '未平倉量', source.reasons.open_interest);
    appendField(doc, parent, '關鍵價位', source.reasons.key_levels);
    appendField(doc, parent, '成交量', source.reasons.volume);
    appendField(doc, parent, '事件', source.reasons.events);
    appendField(doc, parent, '信心', source.confidence);
    appendField(doc, parent, '失效條件', source.invalidation);
  }

  function fillBody(doc, body, note) {
    if (note.kind === 'daily_settlement') {
      body.append(element(doc, 'h4', note.date + ' 今日戰果明細表'), renderTrades(doc, note), renderSettlementTable(doc, note),
        element(doc, 'p', 'API 花費為交易員依 token 用量自記估算（USD）。頁面只組裝這張明細，不呼叫模型、不新增 API 費用。淨損益採交易員填報值，不自行換匯或重算。', 'settlement-estimate'));
      return;
    }
    if (note.kind === 'open') {
      appendPosition(doc, body, note);
      return;
    }
    if (note.kind === 'close') {
      body.append(element(doc, 'p', '開倉覆盤', 'note-section'));
      appendPosition(doc, body, note.review);
      appendField(doc, body, '已實現損益（USDT）', decimal(note.realized_pnl_usdt));
      body.append(element(doc, 'p', '與原計畫的差異', 'note-section'));
      appendField(doc, body, '做對的部分', note.variance.right);
      appendField(doc, body, '做錯的部分', note.variance.wrong);
      appendField(doc, body, '教訓', note.variance.lesson);
      return;
    }
    [['市場回顧', note.market_recap], ['當日逐筆覆盤', note.trade_review],
      ['明日觀察', note.watch_next], ['策略調整', note.strategy_adjustments]]
      .forEach(([label, value]) => appendField(doc, body, label, value));
  }

  function renderNote(doc, note, now, preserved) {
    const settlement = note.kind === 'daily_settlement';
    const card = element(doc, 'article', undefined, settlement ? 'note note-settlement' : 'note');
    card.dataset.morphKey = noteKey(note);
    const header = element(doc, 'div', undefined, 'note-meta');
    header.append(element(doc, 'span', KINDS[note.kind], 'note-kind'));
    const time = element(doc, 'time', new Date(note.ts * 1000).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', hour12: false
    }) + ' 台北', 'note-time');
    time.dateTime = new Date(note.ts * 1000).toISOString();
    header.append(time);
    if (now - note.ts * 1000 > STALE_MS) header.append(element(doc, 'span', '已過時', 'note-stale'));
    const details = element(doc, 'details', undefined, 'note-details');
    const key = noteKey(note);
    details.dataset.noteKey = key;
    details.open = preserved.has(key);
    details.append(element(doc, 'summary', highlight(note) + '（展開全文）', 'note-summary'));
    const body = element(doc, 'div', undefined, 'note-body');
    fillBody(doc, body, note);
    details.append(body);
    card.append(header, details);
    return card;
  }

  function preservedKeys(container) {
    const keys = new Set();
    const nodes = typeof container.querySelectorAll === 'function' ? container.querySelectorAll('.note-details') : [];
    for (const node of nodes) {
      if (node.open && node.dataset && node.dataset.noteKey) keys.add(node.dataset.noteKey);
    }
    return keys;
  }

  function renderColumn(doc, container, trader, notes, now = Date.now()) {
    const moreOpen = container.querySelector?.('.notes-more')?.open || false;
    const preserved = preservedKeys(container);
    const own = notes.filter(note => safeNote(note) && note.trader === trader).slice().sort((a, b) => b.ts - a.ts);
    const pinned = latestSettlement(own, trader);
    const ordinary = own.filter(note => note.kind !== 'daily_settlement');
    const visible = pinned ? [pinned, ...ordinary.slice(0, 4)] : ordinary.slice(0, 5);
    const remaining = own.filter(note => !visible.includes(note));
    const heading = element(doc, 'h3', trader + ' \u4ea4\u6613\u54e1\u4fbf\u5229\u8cbc');
    const disclaimer = element(doc, 'p', 'AI \u4ea4\u6613\u54e1\u81ea\u8ff0\uff0c\u975e\u6295\u8cc7\u5efa\u8b70', 'notes-disclaimer');
    const content = element(doc, 'div', undefined, 'notes-list');
    if (!own.length) content.append(element(doc, 'p', '\u76ee\u524d\u6c92\u6709\u53ef\u986f\u793a\u7684\u4fbf\u5229\u8cbc', 'notes-empty'));
    visible.forEach(note => content.append(renderNote(doc, note, now, preserved)));
    if (remaining.length) {
      const more = element(doc, 'details', undefined, 'notes-more');
      more.dataset.morphKey = 'notes-more:' + trader;
      more.open = moreOpen;
      more.append(element(doc, 'summary', `\u66f4\u65e9\u7684\u4fbf\u5229\u8cbc\uff08${remaining.length} \u5247\uff09`));
      const list = element(doc, 'div', undefined, 'notes-list');
      remaining.forEach(note => list.append(renderNote(doc, note, now, preserved)));
      more.append(list);
      content.append(more);
    }
    (root.RaceMorph || ((node, children) => node.replaceChildren(...children)))(container, [heading, disclaimer, content]);
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
    let ageState = '';
    function render() {
      ageState = JSON.stringify(notes.map(note => [clock() - note.ts * 1000 > 86400000, clock() - note.ts * 1000 > STALE_MS]));
      (root.RaceStable || ((_node, fn) => fn()))(columns, () => {
        columns.forEach(column => renderColumn(doc, column.node, column.trader, notes, clock()));
        renderSummaries(doc, notes, clock());
        if (typeof root.CustomEvent === 'function' && typeof doc.dispatchEvent === 'function') {
          doc.dispatchEvent(new root.CustomEvent('race:notes-updated', { detail: notes }));
        }
      });
    }
    async function refresh() {
      if (loading) return;
      loading = true;
      const controller = new AbortController();
      const timeout = delay(() => controller.abort(), 10000);
      try {
        const next = await fetchNotes(fetcher, controller.signal, clock());
        if (JSON.stringify(next) !== JSON.stringify(notes)) { notes = next; render(); }
      } catch (_) {
        if (notes.length) { notes = []; render(); }
      } finally {
        cancel(timeout);
        loading = false;
      }
    }
    render();
    const ready = refresh();
    schedule(refresh, REFRESH_MS);
    // Age labels continue to update without a successful network request.
    schedule(() => {
      const next = JSON.stringify(notes.map(note => [clock() - note.ts * 1000 > 86400000, clock() - note.ts * 1000 > STALE_MS]));
      if (next !== ageState) render();
    }, 60000);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    doc.addEventListener('race:cards-updated', () => renderSummaries(doc, notes, clock()));
    return { refresh, render, ready };
  }

  const api = { normalizeDocument, suspiciousText, safeNote, renderColumn, latestSettlement, renderSummaries, fetchNotes, start };
  if (typeof module === 'object' && module.exports) module.exports.notes = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { root.RaceNotesReady = start(document)?.ready; });
    else root.RaceNotesReady = start(document)?.ready;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// AI quota block: one fixed-height box (2 lines) fed by ai_quota.json. Every value goes through textContent.
(function (root) {
  'use strict';

  const REFRESH_MS = 30000;
  const STALE_AFTER_S = 3 * 3600;
  const CLIP = 200;
  const DOWN = 'AI 額度資料暫無';
  const clip = value => Array.from(String(value)).slice(0, CLIP).join('');
  const taipei = (seconds, options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hourCycle: 'h23', ...options }).format(new Date(seconds * 1000));
  const hhmm = seconds => taipei(seconds, { hour: '2-digit', minute: '2-digit' });
  const mmdd = seconds => taipei(seconds, { month: '2-digit', day: '2-digit' }).replace(/^(\d+)\/(\d+)$/, (_, d, m) => `${m}/${d}`);
  const when = seconds => `${mmdd(seconds)} ${hhmm(seconds)}`;
  const num = value => typeof value === 'number' && Number.isFinite(value);
  const threshold = alert => { const m = /^threshold_(\d+)$/.exec(String(alert.key)); return m ? Number(m[1]) : null; };

  // Pure: parsed file (or null when missing/invalid) -> { level: 'red'|'amber'|'ok', status, detail, alerts }.
  function quotaView(data, nowSeconds) {
    const down = { level: 'red', status: DOWN, detail: 'AI 額度：—', alerts: [] };
    if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.alerts)) return down;
    const alerts = data.alerts.filter(a => a && typeof a === 'object' && typeof a.message_zh === 'string');
    const text = a => clip(a.message_zh);
    const high = alerts.filter(a => a.level === 'high').sort((a, b) => (threshold(b) ?? 100) - (threshold(a) ?? 100));
    const codex = data.codex;
    const usable = !data.error && codex !== null && typeof codex === 'object' && num(codex.used_percent);
    const view = { ...down, alerts: alerts.map(text) };
    if (usable) {
      const parts = [`Codex 每週 ${Math.round(codex.used_percent)}%`];
      if (num(codex.resets_at)) parts.push(`重置 ${when(codex.resets_at)}`);
      if (num(data.updated_at)) parts.push(`更新 ${when(data.updated_at)}`);
      view.detail = parts.join('｜');
    }
    if (high.length) return { ...view, level: 'red', status: text(high[0]) + (high.length > 1 ? `（另 ${high.length - 1} 則）` : '') };
    if (!usable || !num(data.updated_at)) return { ...view, level: 'red', status: DOWN };
    if (nowSeconds - data.updated_at > STALE_AFTER_S) return { ...view, level: 'red', status: `AI 額度資料已過時（最後更新 ${when(data.updated_at)}）` };
    const top = Math.max(-1, ...alerts.map(a => threshold(a) ?? -1));
    // A low threshold is redundant once a higher one fired; pace/spike alerts outrank the remaining thresholds.
    const medium = alerts.filter(a => a.level === 'medium' && (threshold(a) === null || threshold(a) === top))
      .sort((a, b) => (threshold(a) === null ? 0 : 1) - (threshold(b) === null ? 0 : 1));
    if (medium.length) return { ...view, level: 'amber', status: text(medium[0]) };
    return { ...view, level: 'ok', status: 'AI 額度正常' };
  }

  async function load(fetcher) {
    try {
      const response = await fetcher(`ai_quota.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return null;
      return JSON.parse(await response.text());
    } catch (error) { return null; }
  }

  function start(doc, options = {}) {
    const fetcher = options.fetcher || root.fetch.bind(root);
    const block = doc.getElementById('quota-block');
    const list = doc.getElementById('quota-list');
    if (!block || !list) return { refresh: async () => {} };
    const [statusLine, detailLine] = block.children;
    let shown = null;
    let open = false;
    function draw(view) {
      const key = JSON.stringify([view, open]);
      if (key === shown) return;
      const alertNow = view.level === 'red' && (!shown || JSON.parse(shown)[0].status !== view.status || JSON.parse(shown)[0].level !== 'red');
      shown = key;
      block.dataset.level = view.level;
      block.setAttribute('role', alertNow ? 'alert' : 'status');
      statusLine.textContent = view.status;
      detailLine.textContent = view.detail;
      list.hidden = !open || view.alerts.length === 0;
      list.replaceChildren(...view.alerts.map(t => { const li = doc.createElement('li'); li.textContent = t; return li; }));
    }
    let latest = quotaView(null, 0);
    async function refresh() {
      latest = quotaView(await load(fetcher), Date.now() / 1000);
      const view = latest;
      (root.RaceStable || ((_node, fn) => fn()))(block, () => draw(view));
    }
    const toggle = () => { open = !open; draw(latest); block.setAttribute('aria-expanded', String(open)); };
    block.addEventListener('click', toggle);
    block.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    refresh();
    root.setInterval(refresh, REFRESH_MS);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    return { refresh };
  }

  const api = { quotaView, start };
  root.raceQuota = api;
  if (typeof module === 'object' && module.exports) module.exports.quota = api;
  if (typeof document !== 'undefined') {
    const begin = () => { try { start(document); } catch (error) { root.console.error(error); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin); else begin();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
