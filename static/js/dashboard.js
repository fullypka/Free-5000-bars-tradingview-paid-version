/**
 * dashboard.js
 * ─────────────────────────────────────────────────────────────────────────
 * Orchestrates grid layout, pane lifecycle, symbol/TF dropdowns, and
 * localStorage persistence.
 *
 * Depends on:  WsClient (ws-client.js), ChartPane (charts.js)
 */

// ── Constants ───────────────────────────────────────────────────────────────

const VALID_COUNTS = [1, 2, 4, 6, 8];

const LAYOUT_CLASS = {
  1: 'layout-1',
  2: 'layout-2',
  4: 'layout-4',
  6: 'layout-6',
  8: 'layout-8',
};

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

// Default symbol for each source (pane index → symbol)
const SOURCE_DEFAULTS = {
  hyperliquid: ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE', 'MATIC', 'ARB', 'OP'],
  yfinance:    [
    'RELIANCE.NS', 'TCS.NS', 'INFY.NS', 'HDFCBANK.NS',
    'ICICIBANK.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'ITC.NS',
  ],
};

const SOURCE_LABELS = {
  hyperliquid: '🌐 Hyperliquid',
  yfinance:    '📊 yFinance',
};

// ── State ───────────────────────────────────────────────────────────────────

/** Live ChartPane instances keyed by paneId */
const activePanes = {};

/** Cached symbol lists: { sourceName: string[] } */
const symbolsCache = {};

/**
 * Per-pane configuration persisted to localStorage.
 * { [paneId]: { source, symbol, tf } }
 */
let paneConfigs = {};

let chartCount = 4;
let availableSources = ['hyperliquid', 'yfinance'];

// ── Persistence helpers ──────────────────────────────────────────────────────
function loadState() {
  try {
    const saved = localStorage.getItem('td_chartCount');
    if (saved && VALID_COUNTS.includes(Number(saved))) chartCount = Number(saved);

    const cfg = localStorage.getItem('td_paneConfigs');
    if (cfg) paneConfigs = JSON.parse(cfg);
  } catch (_) { /* ignore */ }
}

function saveState() {
  localStorage.setItem('td_chartCount', chartCount);
  localStorage.setItem('td_paneConfigs', JSON.stringify(paneConfigs));
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getSymbols(source) {
  if (symbolsCache[source]) return symbolsCache[source];
  try {
    const syms = await fetchJSON(`/api/symbols?source=${source}`);
    symbolsCache[source] = syms;
    return syms;
  } catch (e) {
    console.error(`[Dashboard] symbols fetch failed for ${source}:`, e);
    return SOURCE_DEFAULTS[source] || [];
  }
}

async function getHistory(source, symbol, tf) {
  try {
    return await fetchJSON(
      `/api/history?source=${source}&symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=20000`
    );
  } catch (e) {
    console.error(`[Dashboard] history fetch failed:`, e);
    return [];
  }
}

// ── Pane default config ──────────────────────────────────────────────────────
function defaultConfig(paneId) {
  const src = paneId % 2 === 0 ? 'hyperliquid' : 'yfinance';
  const syms = SOURCE_DEFAULTS[src] || [];
  const sym = syms[Math.floor(paneId / 2) % syms.length] || syms[0] || '';
  return {
    source: src,
    symbol: sym,
    tf: '1m',
    indicators: {
      supertrend: false,
      ichimoku:   false,
      pivots:     false,
      ema20:      false,
      ema50:      false,
      sma200:     false,
      vwap:       false,
      bollinger:  false,
      fvg:        false,
      volprofile: false,
      volume:     true,
      obv:        false,
      rsi:        false,
      macd:       false,
      stoch:      false,
      atr:        false,
      adx:        false,
      cci:        false,
      mfi:        false,
      williamsr:  false,
    },
  };
}

// ── Pane DOM builder ─────────────────────────────────────────────────────────
function buildPaneDOM(paneId, config) {
  const pane = document.createElement('div');
  pane.className = 'chart-pane';
  pane.id        = `pane-${paneId}`;

  // Ticker bar
  pane.innerHTML = `
    <div class="ticker-bar">
      <span class="ticker-symbol">${config.symbol || '…'}</span>
      <span class="ticker-price">──</span>
      <span class="ticker-change flat">──</span>
      <span class="ticker-badge">${config.source}</span>
    </div>
    <div class="pane-body">
      <div class="drawing-toolbar">
        <button type="button" class="draw-btn active" data-tool="cursor" title="Cursor / Pointer">
          <svg viewBox="0 0 24 24" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="trendline" title="Trend Line">
          <svg viewBox="0 0 24 24" stroke-width="2"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><line x1="6.5" y1="17.5" x2="17.5" y2="6.5"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="horizline" title="Horizontal Price Line">
          <svg viewBox="0 0 24 24" stroke-width="2"><line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="fib" title="Fibonacci Retracement">
          <svg viewBox="0 0 24 24" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="rectangle" title="Rectangle Zone Box">
          <svg viewBox="0 0 24 24" stroke-width="2"><rect x="4" y="5" width="16" height="14" rx="1"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="brush" title="Brush / Freehand">
          <svg viewBox="0 0 24 24" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3l6 6L9 21H3v-6L15 3z"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="text" title="Text Note">
          <svg viewBox="0 0 24 24" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
        </button>
        <button type="button" class="draw-btn" data-tool="ruler" title="Measure Ruler">
          <svg viewBox="0 0 24 24" stroke-width="2"><rect x="3" y="7" width="18" height="10" rx="1"/><line x1="7" y1="7" x2="7" y2="11"/><line x1="11" y1="7" x2="11" y2="13"/><line x1="15" y1="7" x2="15" y2="11"/><line x1="19" y1="7" x2="19" y2="13"/></svg>
        </button>

        <div class="draw-sep"></div>

        <button type="button" class="draw-btn" data-action="toggle_visible" title="Hide/Show Drawings">
          <svg viewBox="0 0 24 24" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button type="button" class="draw-btn" data-action="clear_all" title="Clear All Drawings">
          <svg viewBox="0 0 24 24" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>

      <div class="pane-chart-area">
        <div class="chart-container" id="chart-container-${paneId}"></div>
        <canvas class="drawing-canvas" id="drawing-canvas-${paneId}"></canvas>
      </div>
    </div>
    <div class="pane-controls">
      <select class="control-select source-select" title="Data source"></select>
      <select class="control-select symbol-select" title="Symbol"></select>
      
      <div class="indicators-wrapper">
        <button type="button" class="indicators-btn" title="Technical Indicators">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline>
            <polyline points="16 7 22 7 22 13"></polyline>
          </svg>
          <span>Indicators</span>
          <span class="indicators-badge"></span>
        </button>
        <div class="indicators-menu hidden">
          <div class="indicators-menu-header">Trend & Overlays</div>
          <label class="ind-option">
            <input type="checkbox" data-ind="supertrend">
            <span class="ind-color-pill" style="background: #8b5cf6;"></span>
            <span class="ind-label">Supertrend (10, 3)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="ichimoku">
            <span class="ind-color-pill" style="background: #06b6d4;"></span>
            <span class="ind-label">Ichimoku Cloud</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="pivots">
            <span class="ind-color-pill" style="background: #64748b;"></span>
            <span class="ind-label">Pivot Points</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="ema20">
            <span class="ind-color-pill" style="background: #f59e0b;"></span>
            <span class="ind-label">EMA (20)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="ema50">
            <span class="ind-color-pill" style="background: #06b6d4;"></span>
            <span class="ind-label">EMA (50)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="sma200">
            <span class="ind-color-pill" style="background: #a855f7;"></span>
            <span class="ind-label">SMA (200)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="vwap">
            <span class="ind-color-pill" style="background: #ec4899;"></span>
            <span class="ind-label">VWAP</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="bollinger">
            <span class="ind-color-pill" style="background: #3b82f6;"></span>
            <span class="ind-label">Bollinger Bands (20, 2)</span>
          </label>

          <div class="indicators-menu-header">Price Action</div>
          <label class="ind-option">
            <input type="checkbox" data-ind="fvg">
            <span class="ind-color-pill" style="background: #eab308;"></span>
            <span class="ind-label">Fair Value Gaps</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="volprofile">
            <span class="ind-color-pill" style="background: #84cc16;"></span>
            <span class="ind-label">Volume Profile (POC/VA)</span>
          </label>

          <div class="indicators-menu-header">Volume</div>
          <label class="ind-option">
            <input type="checkbox" data-ind="volume">
            <span class="ind-color-pill" style="background: #64748b;"></span>
            <span class="ind-label">Volume</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="obv">
            <span class="ind-color-pill" style="background: #3b82f6;"></span>
            <span class="ind-label">OBV</span>
          </label>

          <div class="indicators-menu-header">Oscillators</div>
          <label class="ind-option">
            <input type="checkbox" data-ind="rsi">
            <span class="ind-color-pill" style="background: #a855f7;"></span>
            <span class="ind-label">RSI (14)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="macd">
            <span class="ind-color-pill" style="background: #06b6d4;"></span>
            <span class="ind-label">MACD (12, 26, 9)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="stoch">
            <span class="ind-color-pill" style="background: #eab308;"></span>
            <span class="ind-label">Stochastic (14, 3, 3)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="atr">
            <span class="ind-color-pill" style="background: #10b981;"></span>
            <span class="ind-label">ATR (14)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="adx">
            <span class="ind-color-pill" style="background: #ec4899;"></span>
            <span class="ind-label">ADX (14)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="cci">
            <span class="ind-color-pill" style="background: #f97316;"></span>
            <span class="ind-label">CCI (20)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="mfi">
            <span class="ind-color-pill" style="background: #ef4444;"></span>
            <span class="ind-label">MFI (14)</span>
          </label>
          <label class="ind-option">
            <input type="checkbox" data-ind="williamsr">
            <span class="ind-color-pill" style="background: #84cc16;"></span>
            <span class="ind-label">Williams %R</span>
          </label>
        </div>
      </div>

      <select class="control-select tf-select" title="Timeframe"></select>
    </div>
  `;

  return pane;
}

// ── Populate selects ─────────────────────────────────────────────────────────
function populateSourceSelect(sel, currentSource) {
  sel.innerHTML = '';
  availableSources.forEach(src => {
    const opt = document.createElement('option');
    opt.value = src;
    opt.textContent = SOURCE_LABELS[src] || src;
    if (src === currentSource) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function populateSymbolSelect(sel, source, currentSymbol) {
  const symbols = await getSymbols(source);
  sel.innerHTML = '';

  // If user's symbol isn't in the list, prepend it
  const list = symbols.includes(currentSymbol)
    ? symbols
    : [currentSymbol, ...symbols];

  list.forEach(sym => {
    const opt = document.createElement('option');
    opt.value = sym;
    opt.textContent = sym;
    if (sym === currentSymbol) opt.selected = true;
    sel.appendChild(opt);
  });
}

function populateTfSelect(sel, currentTf) {
  sel.innerHTML = '';
  TIMEFRAMES.forEach(tf => {
    const opt = document.createElement('option');
    opt.value = tf;
    opt.textContent = tf;
    if (tf === currentTf) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ── Subscribe a pane to its configured stream ────────────────────────────────
async function subscribePane(paneId, config) {
  const chartPane = activePanes[paneId];
  if (!chartPane) return;

  // Save config while preserving existing indicators
  paneConfigs[paneId] = {
    indicators: { volume: true },
    ...(paneConfigs[paneId] || {}),
    ...config,
  };
  saveState();

  // Update ticker badge and symbol label
  const paneEl = document.getElementById(`pane-${paneId}`);
  if (paneEl) {
    const sym  = paneEl.querySelector('.ticker-symbol');
    const badge = paneEl.querySelector('.ticker-badge');
    if (sym)   sym.textContent   = config.symbol;
    if (badge) badge.textContent = config.source;
  }

  chartPane.resetOpenPrice();
  chartPane.showLoading();

  // Cancel previous live stream
  WsClient.unsubscribe(paneId);

  // Load history, then start live stream
  const bars = await getHistory(config.source, config.symbol, config.tf);
  chartPane.loadHistory(bars);
  chartPane.hideLoading();

  WsClient.subscribe(paneId, config.symbol, config.tf, config.source);
}

// ── Create a single pane ─────────────────────────────────────────────────────
async function createPane(paneId) {
  const grid   = document.getElementById('chart-grid');
  const config = paneConfigs[paneId] || defaultConfig(paneId);

  const pane = buildPaneDOM(paneId, config);
  grid.appendChild(pane);

  // Init chart
  const chartPane = new ChartPane(paneId, `chart-container-${paneId}`, `drawing-canvas-${paneId}`);
  activePanes[paneId] = chartPane;
  WsClient.registerPane(paneId, chartPane);

  // Restore saved drawings if present
  if (config.drawings) {
    chartPane.setDrawings(config.drawings);
  }

  chartPane.onDrawingsChanged = (drawings) => {
    if (!paneConfigs[paneId]) paneConfigs[paneId] = { ...config };
    paneConfigs[paneId].drawings = drawings;
    saveState();
  };

  

  // Wire Drawing Toolbar
const drawBtns = pane.querySelectorAll('.drawing-toolbar .draw-btn');
chartPane.onToolChanged = (activeTool) => {
  drawBtns.forEach(b => {
    if (b.dataset.tool) {
      b.classList.toggle('active', b.dataset.tool === activeTool);
    }
  });
};

  drawBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tool = btn.dataset.tool;
      const action = btn.dataset.action;

      if (tool) {
        drawBtns.forEach(b => {
          if (b.dataset.tool) b.classList.remove('active');
        });
        btn.classList.add('active');
        chartPane.setDrawingTool(tool);
      } else if (action === 'toggle_visible') {
        const isVisible = chartPane.toggleDrawingsVisibility();
        btn.classList.toggle('active', !isVisible);
      } else if (action === 'clear_all') {
        if (confirm('Clear all drawings on this pane?')) {
          chartPane.clearAllDrawings();
        }
      }
    });
  });

  // Wire controls
  const sourceSelect = pane.querySelector('.source-select');
  const symbolSelect = pane.querySelector('.symbol-select');
  const tfSelect     = pane.querySelector('.tf-select');

  populateSourceSelect(sourceSelect, config.source);
  await populateSymbolSelect(symbolSelect, config.source, config.symbol);
  populateTfSelect(tfSelect, config.tf);

  // Event listeners
  sourceSelect.addEventListener('change', async () => {
    const newSource = sourceSelect.value;
    const newSymbol = (SOURCE_DEFAULTS[newSource] || [])[0] || '';
    await populateSymbolSelect(symbolSelect, newSource, newSymbol);
    await subscribePane(paneId, {
      source: newSource,
      symbol: symbolSelect.value,
      tf:     tfSelect.value,
    });
  });

  symbolSelect.addEventListener('change', () => {
    subscribePane(paneId, {
      source: sourceSelect.value,
      symbol: symbolSelect.value,
      tf:     tfSelect.value,
    });
  });

  tfSelect.addEventListener('change', () => {
    subscribePane(paneId, {
      source: sourceSelect.value,
      symbol: symbolSelect.value,
      tf:     tfSelect.value,
    });
  });

  // Wire Indicators
  const indBtn   = pane.querySelector('.indicators-btn');
  const indMenu  = pane.querySelector('.indicators-menu');
  const indBadge = pane.querySelector('.indicators-badge');

  const savedInds = config.indicators || { volume: true };
  const checkboxes = indMenu.querySelectorAll('input[type="checkbox"]');

  function updateBadge() {
    let activeCount = 0;
    checkboxes.forEach(cb => {
      const name = cb.dataset.ind;
      if (cb.checked && name !== 'volume') activeCount++;
    });
    if (activeCount > 0) {
      indBadge.textContent = activeCount;
      indBadge.style.display = 'inline-block';
      indBtn.classList.add('active');
    } else {
      indBadge.style.display = 'none';
      indBtn.classList.remove('active');
    }
  }

  checkboxes.forEach(cb => {
    const name = cb.dataset.ind;
    const isChecked = savedInds[name] !== undefined ? !!savedInds[name] : (name === 'volume');
    cb.checked = isChecked;
    chartPane.setIndicator(name, isChecked);

    cb.addEventListener('change', () => {
      chartPane.setIndicator(name, cb.checked);
      if (!paneConfigs[paneId]) paneConfigs[paneId] = { ...config };
      if (!paneConfigs[paneId].indicators) paneConfigs[paneId].indicators = {};
      paneConfigs[paneId].indicators[name] = cb.checked;
      saveState();
      updateBadge();
    });
  });
  updateBadge();

  indBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.indicators-menu').forEach(m => {
      if (m !== indMenu) m.classList.add('hidden');
    });
    indMenu.classList.toggle('hidden');
  });

  indMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Initial data load + subscribe
  await subscribePane(paneId, config);
}

// ── Destroy a single pane ────────────────────────────────────────────────────
function destroyPane(paneId) {
  WsClient.unsubscribe(paneId);
  WsClient.unregisterPane(paneId);

  if (activePanes[paneId]) {
    activePanes[paneId].destroy();
    delete activePanes[paneId];
  }

  const el = document.getElementById(`pane-${paneId}`);
  if (el) el.remove();
}

// ── Set grid layout and pane count ───────────────────────────────────────────
async function setChartCount(count) {
  if (!VALID_COUNTS.includes(count)) return;
  chartCount = count;
  saveState();

  // Update active pill
  document.querySelectorAll('.count-pill').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.count) === count);
  });

  const grid = document.getElementById('chart-grid');

  // Swap layout class
  VALID_COUNTS.forEach(n => grid.classList.remove(LAYOUT_CLASS[n]));
  grid.classList.add(LAYOUT_CLASS[count]);

  // Destroy panes no longer needed
  const existingIds = Object.keys(activePanes).map(Number);
  for (const id of existingIds) {
    if (id >= count) destroyPane(id);
  }

  // Create missing panes (sequentially to preserve order)
    for (let i = 0; i < count; i++) {
    if (!activePanes[i]) {
      await createPane(i);
    }
  }

  // Trigger resize event after grid layout settles so Lightweight Charts adapts
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
    Object.values(activePanes).forEach(pane => {
      if (pane && pane.chart) {
        pane.chart.timeScale().fitContent();
      }
    });
  });
}

// ── Re-subscribe all panes (called on WS reconnect) ─────────────────────────
function resubscribeAll() {
  for (const [paneId, chartPane] of Object.entries(activePanes)) {
    const cfg = paneConfigs[Number(paneId)];
    if (cfg) {
      WsClient.subscribe(Number(paneId), cfg.symbol, cfg.tf, cfg.source);
    }
  }
}

// ── Wire count-pill buttons ──────────────────────────────────────────────────
function wirePills() {
  document.querySelectorAll('.count-pill').forEach(btn => {
    const n = Number(btn.dataset.count);
    btn.addEventListener('click', () => setChartCount(n));
    if (n === chartCount) btn.classList.add('active');
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
const Dashboard = {
  async init() {
    loadState();

    // Fetch available sources from server
    try {
      availableSources = await fetchJSON('/api/sources');
    } catch (_) { /* use defaults */ }

    wirePills();
    WsClient.connect();

    // Close indicators menu when clicking outside
    document.addEventListener('click', () => {
      document.querySelectorAll('.indicators-menu').forEach(m => m.classList.add('hidden'));
    });

    await setChartCount(chartCount);
  },

  resubscribeAll,
};

document.addEventListener('DOMContentLoaded', () => Dashboard.init());
