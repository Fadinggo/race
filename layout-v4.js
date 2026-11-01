(function (root) {
  'use strict';

  const TRADERS = ['Grok-Trader-A', 'Grok-Trader-B'];
  const MAX_BYTES = 1024 * 1024;
  const FILTERS = [['all', '全部'], ['instrument', '依幣種（分組）'], ['long', '做多'], ['short', '做空'], ['confidence', '信心度高→低']];
  const REASONS = { funding_rate: '資金費率', open_interest: '未平倉量', key_levels: '關鍵價位', volume: '成交量', events: '事件' };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const points = text => Array.from(text).length;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const text = (value, limit, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0) && points(value) <= limit;
  const epoch = value => finite(value) && value > 0 && value <= 253402300799;
  const direction = value => value === 'long' || value === 'short';
  const symbol = value => text(value, 64) && value.trim() === value && !/\s/u.test(value);
  const baseCoin = instrument => instrument.split('-')[0];

  function suspiciousText(value) {
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/[\t\r\n]/g, ''))) return true;
    const normalized = value.normalize('NFKC');
    return /(?:\b(?:api[ _-]?key|secret(?:[ _-]?key)?|(?:access[ _-]?)?token|uid|passphrase)\b|金鑰|私鑰)\s*[:=]\s*\S/iu.test(normalized) ||
      /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+\S+|-----BEGIN/iu.test(normalized) ||
      /[0-9]{8,}/u.test(normalized) || /[A-Za-z0-9_+/=-]{32,}/u.test(normalized);
  }

  function watchShape(item) {
    const keys = ['id', 'trader', 'instrument', 'direction', 'summary', 'detail', 'confidence', 'created_ts', 'expires_ts', 'ref_price', 'outcome'];
    if (!exact(item, Object.hasOwn(item || {}, 'status') ? [...keys, 'status'] : keys) ||
        !text(item.id, 80) || item.id.trim() !== item.id || /\s/u.test(item.id) ||
        !TRADERS.includes(item.trader) || !symbol(item.instrument) || !direction(item.direction) ||
        !text(item.summary, 60) || !exact(item.detail, ['reason', 'plan', 'invalidation']) ||
        !Object.values(item.detail).every(value => text(value, 1500, true)) ||
        !finite(item.confidence) || item.confidence < 0 || item.confidence > 100 ||
        !epoch(item.created_ts) || !epoch(item.expires_ts) || item.expires_ts <= item.created_ts ||
        !finite(item.ref_price) || item.ref_price <= 0 ||
        (Object.hasOwn(item, 'status') && !['active', 'expired'].includes(item.status))) return false;
    return item.outcome === null || (exact(item.outcome, ['price_at_expiry', 'change_pct', 'verdict', 'review']) &&
      finite(item.outcome.price_at_expiry) && item.outcome.price_at_expiry > 0 && finite(item.outcome.change_pct) &&
      ['hit', 'miss', 'unclear'].includes(item.outcome.verdict) && text(item.outcome.review, 300, true));
  }

  function safeWatch(item) {
    if (!record(item) || !watchShape(item)) return false;
    // Only a valid public YYYYMMDD-HHMM identifier gets a date exemption.
    // The original long-token check still applies to the complete identifier.
    let publicId = item.id;
    const match = /^([AB])-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})-([A-Za-z0-9-]+)$/.exec(item.id);
    if (match) {
      const date = `${match[2]}-${match[3]}-${match[4]}`;
      const parsed = new Date(`${date}T00:00:00Z`);
      if (!date.startsWith('0000') && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date &&
          Number(match[5]) < 24 && Number(match[6]) < 60 && !/[A-Za-z0-9_+/=-]{32,}/u.test(item.id)) {
        publicId = item.id.replace(`${match[2]}${match[3]}${match[4]}`, 'DATE');
      }
    }
    const narrative = [item.summary, ...Object.keys(item.detail).sort().map(key => item.detail[key]),
      ...(item.outcome ? [item.outcome.review] : [])];
    return !suspiciousText(publicId) && !suspiciousText(item.instrument) &&
      narrative.every(value => !suspiciousText(value)) && !suspiciousText(narrative.join('\n'));
  }

  function normalizeWatchlist(document) {
    if (!exact(document, ['version', 'items']) || document.version !== 1 || !Array.isArray(document.items) ||
        document.items.length > 1000 || !document.items.every(safeWatch)) return [];
    if (new Set(document.items.map(item => item.id)).size !== document.items.length) return [];
    return document.items.slice().sort((a, b) => b.created_ts - a.created_ts || a.id.localeCompare(b.id));
  }

  function parseWatchlistJSON(body) {
    const value = JSON.parse(body, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid watchlist number');
      return item;
    });
    const tokens = body.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:]/g) || [];
    const stack = [];
    tokens.forEach((token, index) => {
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[index + 1] === ':') {
        const keys = stack.at(-1);
        const key = JSON.parse(token);
        if (keys.has(key)) throw new Error('Duplicate watchlist key');
        keys.add(key);
      }
    });
    return value;
  }

  async function fetchWatchlist(fetcher, signal, nonce) {
    try {
      const response = await fetcher(`watchlist.json?v=${nonce}`, { cache: 'no-store', signal });
      if (!response.ok) return [];
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined && Number(length) > MAX_BYTES) return [];
      const body = await response.text();
      if (!body.trim() || new TextEncoder().encode(body).length > MAX_BYTES) return [];
      return normalizeWatchlist(parseWatchlistJSON(body));
    } catch (_) {
      return [];
    }
  }

  function latestOpen(notes, trader, instrument) {
    return notes.filter(note => record(note) && note.kind === 'open' && note.trader === trader && note.instrument === instrument && epoch(note.ts))
      .slice().sort((a, b) => b.ts - a.ts)[0] || null;
  }

  function reasonSummary(note) {
    if (!note || !record(note.reasons)) return '尚無說明';
    const values = [note.reasons.key_levels, ...Object.keys(REASONS).filter(key => key !== 'key_levels').map(key => note.reasons[key])];
    const reason = values.find(value => typeof value === 'string' && value.trim() && !value.includes('未取得資料'));
    if (!reason) return '尚無說明';
    const characters = Array.from(reason.trim());
    return characters.length > 60 ? characters.slice(0, 59).join('') + '…' : characters.join('');
  }

  function splitWatchlist(items, trader, mode = 'all', now = Date.now()) {
    let own = items.filter(item => item.trader === trader);
    if (mode === 'long' || mode === 'short') own = own.filter(item => item.direction === mode);
    own = own.slice().sort(mode === 'confidence' ? (a, b) => b.confidence - a.confidence || b.created_ts - a.created_ts
      : mode === 'instrument' ? (a, b) => baseCoin(a.instrument).localeCompare(baseCoin(b.instrument)) || b.created_ts - a.created_ts
        : (a, b) => b.created_ts - a.created_ts);
    const expired = item => item.status === 'expired' || now > item.expires_ts * 1000;
    return { active: own.filter(item => !expired(item)), expired: own.filter(expired) };
  }

  function element(doc, tag, value, className) {
    const node = doc.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  }

  function field(doc, parent, label, value) {
    const line = element(doc, 'div', undefined, 'layout-field');
    line.append(element(doc, 'strong', label), element(doc, 'p', value ?? '尚無說明'));
    parent.append(line);
  }

  function localTime(value) {
    return epoch(value) ? new Date(value * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + ' 台灣' : '未提供';
  }

  const sideLabel = side => ({ long: '做多', short: '做空', net: '淨持倉' }[side] || side || '未提供');
  const numeric = value => finite(value) ? String(+value.toPrecision(8)) : '未提供';
  const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${numeric(value)}` : '未提供';
  const confidence = value => '●'.repeat(Math.round(value / 20)) + '○'.repeat(5 - Math.round(value / 20)) + ` ${value}%`;

  function preserve(container) {
    const set = new Set();
    for (const node of container.querySelectorAll?.('details') || []) {
      if (node.open && node.dataset?.layoutKey) set.add(node.dataset.layoutKey);
    }
    return set;
  }

  function detailRow(doc, key, cells, preserved) {
    const details = element(doc, 'details', undefined, 'layout-details');
    details.dataset.layoutKey = key;
    details.open = preserved.has(key);
    const summary = element(doc, 'summary', undefined, 'layout-summary');
    for (const cell of cells) summary.append(element(doc, 'span', cell.text ?? cell, cell.className));
    const body = element(doc, 'div', undefined, 'layout-detail-body');
    details.append(summary, body);
    return { details, body };
  }

  function holdingTime(ts, now) {
    if (!epoch(ts) || ts * 1000 > now) return '未提供';
    const minutes = Math.floor((now - ts * 1000) / 60000);
    return (minutes < 60 ? `${minutes} 分鐘` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分鐘`
      : `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小時`) + '（依便利貼）';
  }

  function renderPositions(doc, container, snapshot, notes = [], now = Date.now()) {
    const preserved = preserve(container);
    const blocks = TRADERS.map(trader => {
      const block = element(doc, 'section', undefined, 'layout-trader-block');
      block.dataset.trader = trader;
      block.append(element(doc, 'h3', trader));
      const account = snapshot?.traders?.find(item => item.name === trader);
      if (!account || account.positions === null || !Array.isArray(account.positions)) {
        block.append(element(doc, 'p', '持倉資料尚未提供', 'muted'));
      } else if (!account.positions.length) {
        block.append(element(doc, 'p', '空手', 'muted'));
      } else {
        const header = element(doc, 'div', undefined, 'layout-summary position-head');
        ['標的與方向', '原因簡介', '數量', '進場價 → 現價', '未實現損益', '持有多久'].forEach(label => header.append(element(doc, 'span', label)));
        block.append(header);
        for (const position of account.positions) {
          const note = latestOpen(notes, trader, position.inst);
          const key = `position:${trader}:${position.inst}:${position.side}`;
          const pnl = finite(position.upl) ? `${signed(position.upl)} ${position.uplCurrency || account.currency || '幣別未提供'}` : '未提供';
          // shortcut: snapshots omit current price and entry time; use them when exports include them.
          const entryTs = note?.ts;
          const own = detailRow(doc, key, [
            `${position.inst} ${sideLabel(position.side)}`, reasonSummary(note),
            `${numeric(position.size)} ${position.unit || '單位未提供'}`,
            `${numeric(position.averagePrice)} → 未提供`,
            { text: pnl, className: finite(position.upl) ? position.upl >= 0 ? 'pos' : 'neg' : 'muted' },
            holdingTime(entryTs, now)
          ], preserved);
          if (note) {
            for (const [name, label] of Object.entries(REASONS)) field(doc, own.body, `進場理由・${label}`, note.reasons?.[name] || '尚無說明');
            field(doc, own.body, '停損', numeric(note.stop_loss));
            field(doc, own.body, '目標', numeric(note.take_profit));
            field(doc, own.body, '什麼情況出場', note.invalidation || '尚無說明');
            field(doc, own.body, '信心度', note.confidence || '尚無說明');
          } else {
            field(doc, own.body, '進場理由', '尚無說明');
            ['停損', '目標', '什麼情況出場', '信心度'].forEach(label => field(doc, own.body, label, '尚無說明'));
          }
          field(doc, own.body, '進場時間（依便利貼）', localTime(entryTs));
          block.append(own.details);
        }
      }
      return block;
    });
    container.replaceChildren(...blocks);
  }

  function appendWatchRows(doc, parent, items, expired, mode, preserved) {
    if (!items.length) {
      parent.append(element(doc, 'p', '尚無觀察', 'muted'));
      return;
    }
    const header = element(doc, 'div', undefined, `layout-summary ${expired ? 'watch-expired-head' : 'watch-head'}`);
    const labels = ['標的與方向', '原因簡介', '信心度', ...(expired ? ['實際結果', '準不準'] : ['有效到'])];
    labels.forEach(label => header.append(element(doc, 'span', label)));
    parent.append(header);
    let instrument = null;
    for (const item of items) {
      if (mode === 'instrument' && baseCoin(item.instrument) !== instrument) {
        instrument = baseCoin(item.instrument);
        parent.append(element(doc, 'h4', instrument, 'layout-group-title'));
      }
      const outcome = item.outcome;
      const verdict = { hit: ['✔ 準', 'pos'], miss: ['✘ 不準', 'neg'], unclear: ['– 無法判斷', 'muted'] }[outcome?.verdict] || ['– 無法判斷', 'muted'];
      const result = outcome ? `${numeric(outcome.price_at_expiry)}（${signed(outcome.change_pct)}%）` : '尚無結果';
      const cells = [`${item.instrument} ${sideLabel(item.direction)}`, item.summary, confidence(item.confidence)];
      if (expired) cells.push(result, { text: verdict[0], className: verdict[1] });
      else cells.push(localTime(item.expires_ts));
      const own = detailRow(doc, `watch:${item.id}`, cells, preserved);
      if (expired) {
        field(doc, own.body, '當時判斷', item.detail.reason || '尚無說明');
        field(doc, own.body, '打算怎麼做', item.detail.plan || '尚無說明');
        field(doc, own.body, '什麼情況算看錯', item.detail.invalidation || '尚無說明');
        field(doc, own.body, '實際走勢', result);
        field(doc, own.body, '檢討', outcome?.review || '尚無說明');
      } else {
        field(doc, own.body, '詳細理由', item.detail.reason || '尚無說明');
        field(doc, own.body, '打算怎麼做', item.detail.plan || '尚無說明');
        field(doc, own.body, '什麼情況算看錯', item.detail.invalidation || '尚無說明');
      }
      field(doc, own.body, '提出時間', localTime(item.created_ts));
      field(doc, own.body, '有效到', localTime(item.expires_ts));
      parent.append(own.details);
    }
  }

  function renderWatchlist(doc, container, items, modes = new Map(), now = Date.now(), rerender) {
    const preserved = preserve(container);
    const blocks = TRADERS.map(trader => {
      const block = element(doc, 'section', undefined, 'layout-trader-block');
      block.dataset.trader = trader;
      block.append(element(doc, 'h3', trader));
      const mode = modes.get(trader) || 'all';
      const toolbar = element(doc, 'div', undefined, 'layout-filters');
      toolbar.setAttribute('role', 'group');
      toolbar.setAttribute('aria-label', `${trader} 觀察分類`);
      FILTERS.forEach(([value, label]) => {
        const button = element(doc, 'button', label, mode === value ? 'active' : '');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(mode === value));
        button.addEventListener('click', () => {
          modes.set(trader, value);
          if (rerender) rerender();
          else renderWatchlist(doc, container, items, modes, now);
        });
        toolbar.append(button);
      });
      block.append(toolbar);
      const split = splitWatchlist(items, trader, mode, now);
      const active = element(doc, 'div', undefined, 'watch-active');
      appendWatchRows(doc, active, split.active, false, mode, preserved);
      block.append(active);
      if (split.expired.length) {
        const old = element(doc, 'details', undefined, 'watch-expired');
        old.dataset.layoutKey = `expired:${trader}`;
        old.open = preserved.has(old.dataset.layoutKey);
        old.append(element(doc, 'summary', `${split.expired.length} 已過期的觀察`));
        const content = element(doc, 'div', undefined, 'watch-expired-list');
        appendWatchRows(doc, content, split.expired, true, mode, preserved);
        old.append(content);
        block.append(old);
      }
      return block;
    });
    container.replaceChildren(...blocks);
  }

  function mount(doc, options = {}) {
    const positions = doc.getElementById('positions');
    const watchlist = doc.getElementById('watchlist');
    if (!positions || !watchlist) return null;
    const fetcher = options.fetcher || root.fetch.bind(root);
    const clock = options.now || Date.now;
    const schedule = options.setInterval || root.setInterval.bind(root);
    const delay = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    let snapshot = null;
    let notes = [];
    let items = [];
    let loading = false;
    const modes = new Map();
    const renderPositionsNow = () => renderPositions(doc, positions, snapshot, notes, clock());
    const renderWatchlistNow = () => renderWatchlist(doc, watchlist, items, modes, clock(), renderWatchlistNow);
    const render = () => { renderPositionsNow(); renderWatchlistNow(); };
    async function refresh() {
      if (loading) return;
      loading = true;
      const controller = new AbortController();
      const timeout = delay(() => controller.abort(), 10000);
      try { items = await fetchWatchlist(fetcher, controller.signal, clock()); }
      finally { cancel(timeout); loading = false; renderWatchlistNow(); }
    }
    render();
    const ready = refresh();
    schedule(refresh, 30000);
    schedule(render, 60000);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    return {
      ready, refresh, render,
      updateSnapshot: value => { snapshot = value; renderPositionsNow(); },
      updateNotes: value => { notes = Array.isArray(value) ? value : []; renderPositionsNow(); }
    };
  }

  const api = { suspiciousText, safeWatch, normalizeWatchlist, parseWatchlistJSON, fetchWatchlist,
    latestOpen, reasonSummary, splitWatchlist, renderPositions, renderWatchlist, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RaceLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
