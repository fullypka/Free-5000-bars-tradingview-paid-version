/**
 * charts.js
 * ─────────────────────────────────────────────────────────────────────────
 * ChartPane — wraps a Lightweight Charts v4 candlestick + volume pane.
 *
 * Usage
 * ─────
 *   const pane = new ChartPane(0, 'chart-container-0');
 *   pane.loadHistory(bars);          // seed from REST
 *   pane.onTick(bar);                // update from live WebSocket
 *   pane.showLoading() / hideLoading()
 *   pane.destroy()
 */

class ChartPane {
  /**
   * @param {number} paneId       — numeric index of the pane (0-based)
   * @param {string} containerId  — id of the div to mount the chart into
   * @param {string} [canvasId]   — optional id of the drawing canvas element
   */
  constructor(paneId, containerId, canvasId) {
    this.paneId      = paneId;
    this.containerId = containerId;
    this.canvasId    = canvasId || `drawing-canvas-${paneId}`;
    this.chart       = null;
    this.candleSeries = null;
    this.volSeries   = null;
    this.lastBar     = null;
    this.openPrice   = null;
    this.bars        = [];
    this.activeIndicators = {
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
    };
    this.indSeries   = {};
    this.priceLines  = [];

    // Drawing state
    this.activeTool      = 'cursor';
    this.drawings        = [];
    this.drawingsVisible = true;
    this.currentDrawing  = null;
    this.isDrawing       = false;
    this.onDrawingsChanged = null;

    this._init();
    this._initDrawingCanvas();
  }

  // ── Initialise Lightweight Charts ────────────────────────────────────────
  _init() {
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.error(`[Chart] Container #${this.containerId} not found`);
      return;
    }

    this.chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#787b86',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#2a2e39' },
        horzLines: { color: '#2a2e39' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: {
          color: '#758696',
          width: 1,
          style: LightweightCharts.LineStyle.Dashed,
          labelBackgroundColor: '#2962ff',
        },
        horzLine: {
          color: '#758696',
          width: 1,
          style: LightweightCharts.LineStyle.Dashed,
          labelBackgroundColor: '#2962ff',
        },
      },
      rightPriceScale: {
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
        fixLeftEdge: true,
      },
    });

    // Candlestick series
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor:        '#26a69a',
      downColor:      '#ef5350',
      borderVisible:  false,
      wickUpColor:    '#26a69a',
      wickDownColor:  '#ef5350',
    });

    // Volume histogram (bottom 25 % of pane)
    this.volSeries = this.chart.addHistogramSeries({
      color:       '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });

    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.76, bottom: 0 },
    });
  }

  // ── Load historical bars ─────────────────────────────────────────────────
  /**
   * @param {Array<{time,open,high,low,close,volume}>} bars
   */
  loadHistory(bars) {
    if (!this.candleSeries || !bars || bars.length === 0) return;

    // Ensure ascending order + deduplicate by time using Map
    const map = new Map();
    bars.forEach(b => {
      if (b && b.time != null) {
        map.set(b.time, b);
      }
    });
    const unique = Array.from(map.values()).sort((a, b) => a.time - b.time);

    this.bars = unique;
    this.candleSeries.setData(unique);
    if (this.volSeries) {
      this.volSeries.setData(
        unique.map(b => ({
          time:  b.time,
          value: b.volume || 0,
          color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
        }))
      );
    }

    this.lastBar   = unique[unique.length - 1] || null;
    this.openPrice = this.lastBar?.open ?? null;

    this.recalculateIndicators();
    if (this.chart) {
      this.chart.priceScale('right').applyOptions({ autoScale: true });
      this.chart.timeScale().fitContent();
    }
    this._updateTickerBar(this.lastBar, false);
  }

  // ── Live tick from WebSocket ─────────────────────────────────────────────
  /**
   * @param {{time,open,high,low,close,volume}} bar
   */
  onTick(bar) {
    if (!this.candleSeries) return;

    const isUp = bar.close >= bar.open;

    this.candleSeries.update(bar);
    this.volSeries.update({
      time:  bar.time,
      value: bar.volume,
      color: isUp ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
    });

    if (this.bars.length > 0) {
      const last = this.bars[this.bars.length - 1];
      if (last.time === bar.time) {
        this.bars[this.bars.length - 1] = bar;
      } else if (bar.time > last.time) {
        this.bars.push(bar);
      }
    } else {
      this.bars.push(bar);
    }

    this.recalculateIndicators();

    const prev = this.lastBar;
    this.lastBar = bar;

    // Track open of first bar received (for session % change)
    if (this.openPrice === null) this.openPrice = bar.open;

    this._updateTickerBar(bar, true, prev);
  }

  // ── Ticker bar update ────────────────────────────────────────────────────
  _updateTickerBar(bar, flash = false, prevBar = null) {
    if (!bar) return;

    const paneEl = document.getElementById(`pane-${this.paneId}`);
    if (!paneEl) return;

    const tickerBar   = paneEl.querySelector('.ticker-bar');
    const priceEl     = paneEl.querySelector('.ticker-price');
    const changeEl    = paneEl.querySelector('.ticker-change');

    if (!tickerBar || !priceEl || !changeEl) return;

    // Format price (auto decimal places based on magnitude)
    const price = bar.close;
    const decimals = price >= 1000 ? 2 : price >= 10 ? 3 : price >= 1 ? 4 : 6;
    priceEl.textContent = price.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

    // Percent change vs open of current bar
    const ref    = this.openPrice ?? bar.open;
    const pct    = ref > 0 ? ((price - ref) / ref) * 100 : 0;
    const sign   = pct >= 0 ? '+' : '';
    const isUp   = bar.close >= bar.open;

    changeEl.textContent = `${sign}${pct.toFixed(2)}%`;
    changeEl.className   = `ticker-change ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}`;

    // Flash animation on every new tick
    if (flash) {
      tickerBar.classList.remove('flash-green', 'flash-red');
      // Force reflow so the animation re-triggers even for consecutive same-direction ticks
      void tickerBar.offsetWidth;
      tickerBar.classList.add(isUp ? 'flash-green' : 'flash-red');
    }
  }

  // ── Loading / error overlay ──────────────────────────────────────────────
  showLoading() {
    const paneEl = document.getElementById(`pane-${this.paneId}`);
    if (!paneEl) return;
    let overlay = paneEl.querySelector('.pane-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pane-overlay';
      overlay.innerHTML = `
        <div class="big-spinner"></div>
        <span>Loading…</span>
      `;
      paneEl.querySelector('.chart-container')?.appendChild(overlay);
    }
    overlay.classList.remove('hidden');
  }

  hideLoading() {
    const overlay = document.querySelector(`#pane-${this.paneId} .pane-overlay`);
    if (overlay) overlay.classList.add('hidden');
  }

  showError(message) {
    this.hideLoading();
    const paneEl = document.getElementById(`pane-${this.paneId}`);
    if (!paneEl) return;
    let overlay = paneEl.querySelector('.pane-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pane-overlay';
      paneEl.querySelector('.chart-container')?.appendChild(overlay);
    }
    overlay.innerHTML = `<span style="color:#ef5350">⚠ ${message}</span>`;
    overlay.classList.remove('hidden');
    setTimeout(() => overlay.classList.add('hidden'), 4000);
  }

  // ── Reset open price on symbol change ───────────────────────────────────
  resetOpenPrice() {
    this.openPrice = null;
    this.lastBar   = null;
  }

  _clearPriceLines() {
    if (this.candleSeries && this.priceLines && this.priceLines.length > 0) {
      this.priceLines.forEach(l => {
        try { this.candleSeries.removePriceLine(l); } catch (_) {}
      });
      this.priceLines = [];
    }
  }

  // ── Indicators Management ────────────────────────────────────────────────
  setIndicator(name, isEnabled) {
    this.activeIndicators[name] = isEnabled;
    this._syncIndicatorSeries(name);
    this.recalculateIndicators();
  }

  _syncIndicatorSeries(name) {
    const isEnabled = this.activeIndicators[name];

    // Volume
    if (name === 'volume') {
      if (this.volSeries) {
        this.volSeries.applyOptions({ visible: isEnabled });
      }
      return;
    }

    // Supertrend (10, 3)
    if (name === 'supertrend') {
      if (isEnabled && !this.indSeries.supertrend) {
        this.indSeries.supertrend = this.chart.addLineSeries({
          color: '#8b5cf6',
          lineWidth: 2,
          priceLineVisible: false,
          title: 'Supertrend',
        });
      } else if (!isEnabled && this.indSeries.supertrend) {
        this.chart.removeSeries(this.indSeries.supertrend);
        delete this.indSeries.supertrend;
      }
    }

    // Ichimoku Cloud
    if (name === 'ichimoku') {
      if (isEnabled && !this.indSeries.tenkan) {
        this.indSeries.tenkan = this.chart.addLineSeries({ color: '#06b6d4', lineWidth: 1, priceLineVisible: false, title: 'Tenkan' });
        this.indSeries.kijun  = this.chart.addLineSeries({ color: '#ef4444', lineWidth: 1, priceLineVisible: false, title: 'Kijun' });
        this.indSeries.spanA  = this.chart.addLineSeries({ color: '#22c55e', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, title: 'Span A' });
        this.indSeries.spanB  = this.chart.addLineSeries({ color: '#f97316', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, title: 'Span B' });
      } else if (!isEnabled && this.indSeries.tenkan) {
        ['tenkan', 'kijun', 'spanA', 'spanB'].forEach(k => {
          if (this.indSeries[k]) { this.chart.removeSeries(this.indSeries[k]); delete this.indSeries[k]; }
        });
      }
    }

    // EMA (20)
    if (name === 'ema20') {
      if (isEnabled && !this.indSeries.ema20) {
        this.indSeries.ema20 = this.chart.addLineSeries({ color: '#f59e0b', lineWidth: 2, priceLineVisible: false, title: 'EMA 20' });
      } else if (!isEnabled && this.indSeries.ema20) {
        this.chart.removeSeries(this.indSeries.ema20);
        delete this.indSeries.ema20;
      }
    }

    // EMA (50)
    if (name === 'ema50') {
      if (isEnabled && !this.indSeries.ema50) {
        this.indSeries.ema50 = this.chart.addLineSeries({ color: '#06b6d4', lineWidth: 2, priceLineVisible: false, title: 'EMA 50' });
      } else if (!isEnabled && this.indSeries.ema50) {
        this.chart.removeSeries(this.indSeries.ema50);
        delete this.indSeries.ema50;
      }
    }

    // SMA (200)
    if (name === 'sma200') {
      if (isEnabled && !this.indSeries.sma200) {
        this.indSeries.sma200 = this.chart.addLineSeries({ color: '#a855f7', lineWidth: 2, priceLineVisible: false, title: 'SMA 200' });
      } else if (!isEnabled && this.indSeries.sma200) {
        this.chart.removeSeries(this.indSeries.sma200);
        delete this.indSeries.sma200;
      }
    }

    // VWAP
    if (name === 'vwap') {
      if (isEnabled && !this.indSeries.vwap) {
        this.indSeries.vwap = this.chart.addLineSeries({ color: '#ec4899', lineWidth: 2, priceLineVisible: false, title: 'VWAP' });
      } else if (!isEnabled && this.indSeries.vwap) {
        this.chart.removeSeries(this.indSeries.vwap);
        delete this.indSeries.vwap;
      }
    }

    // Bollinger Bands (20, 2)
    if (name === 'bollinger') {
      if (isEnabled && !this.indSeries.bbUpper) {
        this.indSeries.bbUpper = this.chart.addLineSeries({ color: 'rgba(59, 130, 246, 0.8)', lineWidth: 1, priceLineVisible: false, title: 'BB Upper' });
        this.indSeries.bbMid   = this.chart.addLineSeries({ color: 'rgba(59, 130, 246, 0.5)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, title: 'BB Mid' });
        this.indSeries.bbLower = this.chart.addLineSeries({ color: 'rgba(59, 130, 246, 0.8)', lineWidth: 1, priceLineVisible: false, title: 'BB Lower' });
      } else if (!isEnabled && this.indSeries.bbUpper) {
        ['bbUpper', 'bbMid', 'bbLower'].forEach(k => {
          if (this.indSeries[k]) { this.chart.removeSeries(this.indSeries[k]); delete this.indSeries[k]; }
        });
      }
    }

    // OBV (On-Balance Volume)
    if (name === 'obv') {
      if (isEnabled && !this.indSeries.obv) {
        this.indSeries.obv = this.chart.addLineSeries({
          color: '#3b82f6',
          lineWidth: 2,
          priceScaleId: 'obv',
          priceLineVisible: false,
          title: 'OBV',
        });
        this.chart.priceScale('obv').applyOptions({
          scaleMargins: { top: 0.78, bottom: 0.02 },
          autoScale: true,
        });
      } else if (!isEnabled && this.indSeries.obv) {
        this.chart.removeSeries(this.indSeries.obv);
        delete this.indSeries.obv;
      }
    }

    // RSI (14)
    if (name === 'rsi') {
      if (isEnabled && !this.indSeries.rsi) {
        this.indSeries.rsi = this.chart.addLineSeries({
          color: '#a855f7',
          lineWidth: 2,
          priceScaleId: 'rsi',
          priceLineVisible: false,
          title: 'RSI(14)',
        });
        this.chart.priceScale('rsi').applyOptions({
          scaleMargins: { top: 0.78, bottom: 0.02 },
          autoScale: true,
        });
        this.indSeries.rsi.createPriceLine({ price: 70, color: 'rgba(239, 83, 80, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '70' });
        this.indSeries.rsi.createPriceLine({ price: 30, color: 'rgba(38, 166, 154, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '30' });
      } else if (!isEnabled && this.indSeries.rsi) {
        this.chart.removeSeries(this.indSeries.rsi);
        delete this.indSeries.rsi;
      }
    }

    // MACD (12, 26, 9)
    if (name === 'macd') {
      if (isEnabled && !this.indSeries.macdLine) {
        this.indSeries.macdLine = this.chart.addLineSeries({ color: '#06b6d4', lineWidth: 1.5, priceScaleId: 'macd', priceLineVisible: false, title: 'MACD' });
        this.indSeries.macdSig  = this.chart.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, priceScaleId: 'macd', priceLineVisible: false, title: 'Signal' });
        this.indSeries.macdHist = this.chart.addHistogramSeries({ priceScaleId: 'macd', priceLineVisible: false, title: 'Hist' });
        this.chart.priceScale('macd').applyOptions({
          scaleMargins: { top: 0.78, bottom: 0.02 },
          autoScale: true,
        });
      } else if (!isEnabled && this.indSeries.macdLine) {
        ['macdLine', 'macdSig', 'macdHist'].forEach(k => {
          if (this.indSeries[k]) { this.chart.removeSeries(this.indSeries[k]); delete this.indSeries[k]; }
        });
      }
    }

    // Stochastic (14, 3, 3)
    if (name === 'stoch') {
      if (isEnabled && !this.indSeries.stochK) {
        this.indSeries.stochK = this.chart.addLineSeries({ color: '#eab308', lineWidth: 1.5, priceScaleId: 'stoch', priceLineVisible: false, title: '%K' });
        this.indSeries.stochD = this.chart.addLineSeries({ color: '#3b82f6', lineWidth: 1.5, priceScaleId: 'stoch', priceLineVisible: false, title: '%D' });
        this.chart.priceScale('stoch').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, autoScale: true });
        this.indSeries.stochK.createPriceLine({ price: 80, color: 'rgba(239, 83, 80, 0.5)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '80' });
        this.indSeries.stochK.createPriceLine({ price: 20, color: 'rgba(38, 166, 154, 0.5)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '20' });
      } else if (!isEnabled && this.indSeries.stochK) {
        ['stochK', 'stochD'].forEach(k => {
          if (this.indSeries[k]) { this.chart.removeSeries(this.indSeries[k]); delete this.indSeries[k]; }
        });
      }
    }

    // ATR (14)
    if (name === 'atr') {
      if (isEnabled && !this.indSeries.atr) {
        this.indSeries.atr = this.chart.addLineSeries({ color: '#10b981', lineWidth: 2, priceScaleId: 'atr', priceLineVisible: false, title: 'ATR(14)' });
        this.chart.priceScale('atr').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, autoScale: true });
      } else if (!isEnabled && this.indSeries.atr) {
        this.chart.removeSeries(this.indSeries.atr);
        delete this.indSeries.atr;
      }
    }

    // ADX (14)
    if (name === 'adx') {
      if (isEnabled && !this.indSeries.adx) {
        this.indSeries.adx = this.chart.addLineSeries({ color: '#ec4899', lineWidth: 2, priceScaleId: 'adx', priceLineVisible: false, title: 'ADX(14)' });
        this.chart.priceScale('adx').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, autoScale: true });
        this.indSeries.adx.createPriceLine({ price: 25, color: 'rgba(236, 72, 153, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '25' });
      } else if (!isEnabled && this.indSeries.adx) {
        this.chart.removeSeries(this.indSeries.adx);
        delete this.indSeries.adx;
      }
    }

    // CCI (20)
    if (name === 'cci') {
      if (isEnabled && !this.indSeries.cci) {
        this.indSeries.cci = this.chart.addLineSeries({ color: '#f97316', lineWidth: 2, priceScaleId: 'cci', priceLineVisible: false, title: 'CCI(20)' });
        this.chart.priceScale('cci').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, autoScale: true });
        this.indSeries.cci.createPriceLine({ price: 100, color: 'rgba(249, 115, 22, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '100' });
        this.indSeries.cci.createPriceLine({ price: -100, color: 'rgba(249, 115, 22, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '-100' });
      } else if (!isEnabled && this.indSeries.cci) {
        this.chart.removeSeries(this.indSeries.cci);
        delete this.indSeries.cci;
      }
    }

    // MFI (14)
    if (name === 'mfi') {
      if (isEnabled && !this.indSeries.mfi) {
        this.indSeries.mfi = this.chart.addLineSeries({ color: '#ef4444', lineWidth: 2, priceScaleId: 'mfi', priceLineVisible: false, title: 'MFI(14)' });
        this.chart.priceScale('mfi').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, autoScale: true });
        this.indSeries.mfi.createPriceLine({ price: 80, color: 'rgba(239, 68, 68, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '80' });
        this.indSeries.mfi.createPriceLine({ price: 20, color: 'rgba(34, 197, 94, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '20' });
      } else if (!isEnabled && this.indSeries.mfi) {
        this.chart.removeSeries(this.indSeries.mfi);
        delete this.indSeries.mfi;
      }
    }

    // Williams %R
    if (name === 'williamsr') {
      if (isEnabled && !this.indSeries.williamsr) {
        this.indSeries.williamsr = this.chart.addLineSeries({ color: '#84cc16', lineWidth: 2, priceScaleId: 'williamsr', priceLineVisible: false, title: '%R' });
        this.chart.priceScale('williamsr').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, autoScale: true });
        this.indSeries.williamsr.createPriceLine({ price: -20, color: 'rgba(239, 68, 68, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '-20' });
        this.indSeries.williamsr.createPriceLine({ price: -80, color: 'rgba(34, 197, 94, 0.6)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '-80' });
      } else if (!isEnabled && this.indSeries.williamsr) {
        this.chart.removeSeries(this.indSeries.williamsr);
        delete this.indSeries.williamsr;
      }
    }
  }

  recalculateIndicators() {
    if (!this.bars || this.bars.length === 0) return;

    // Volume
    if (this.volSeries) {
      this.volSeries.applyOptions({ visible: !!this.activeIndicators.volume });
    }

    // Clear and redraw price lines (pivots, volprofile, fvg)
    this._clearPriceLines();

    if (this.candleSeries) {
      // Pivot Points
      if (this.activeIndicators.pivots) {
        const piv = calculatePivotPoints(this.bars);
        if (piv) {
          const makePivLine = (price, color, title) => {
            const l = this.candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title });
            this.priceLines.push(l);
          };
          makePivLine(piv.P,  '#64748b', 'P');
          makePivLine(piv.R1, '#ef4444', 'R1');
          makePivLine(piv.S1, '#22c55e', 'S1');
          makePivLine(piv.R2, '#b91c1c', 'R2');
          makePivLine(piv.S2, '#15803d', 'S2');
        }
      }

      // Volume Profile (POC / VA)
      if (this.activeIndicators.volprofile) {
        const vp = calculateVolumeProfile(this.bars);
        if (vp) {
          const l1 = this.candleSeries.createPriceLine({ price: vp.poc, color: '#ef4444', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'POC' });
          const l2 = this.candleSeries.createPriceLine({ price: vp.vah, color: '#3b82f6', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'VAH' });
          const l3 = this.candleSeries.createPriceLine({ price: vp.val, color: '#3b82f6', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'VAL' });
          this.priceLines.push(l1, l2, l3);
        }
      }

      // Fair Value Gaps (FVG)
      if (this.activeIndicators.fvg) {
        const fvgs = calculateFVG(this.bars);
        fvgs.forEach((f, idx) => {
          const col = f.type === 'bullish' ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)';
          const lTop = this.candleSeries.createPriceLine({ price: f.top, color: col, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: `FVG` });
          const lBot = this.candleSeries.createPriceLine({ price: f.bottom, color: col, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: `` });
          this.priceLines.push(lTop, lBot);
        });
      }
    }

    // Supertrend
    if (this.activeIndicators.supertrend && this.indSeries.supertrend) {
      this.indSeries.supertrend.setData(calculateSupertrend(this.bars, 10, 3));
    }

    // Ichimoku Cloud
    if (this.activeIndicators.ichimoku && this.indSeries.tenkan) {
      const ich = calculateIchimoku(this.bars);
      this.indSeries.tenkan.setData(ich.tenkan);
      this.indSeries.kijun.setData(ich.kijun);
      this.indSeries.spanA.setData(ich.spanA);
      this.indSeries.spanB.setData(ich.spanB);
    }

    // Moving Averages
    if (this.activeIndicators.ema20 && this.indSeries.ema20) {
      this.indSeries.ema20.setData(calculateEMA(this.bars, 20));
    }
    if (this.activeIndicators.ema50 && this.indSeries.ema50) {
      this.indSeries.ema50.setData(calculateEMA(this.bars, 50));
    }
    if (this.activeIndicators.sma200 && this.indSeries.sma200) {
      this.indSeries.sma200.setData(calculateSMA(this.bars, 200));
    }
    if (this.activeIndicators.vwap && this.indSeries.vwap) {
      this.indSeries.vwap.setData(calculateVWAP(this.bars));
    }

    // Bollinger Bands
    if (this.activeIndicators.bollinger && this.indSeries.bbUpper) {
      const bb = calculateBollinger(this.bars, 20, 2);
      this.indSeries.bbUpper.setData(bb.upper);
      this.indSeries.bbMid.setData(bb.middle);
      this.indSeries.bbLower.setData(bb.lower);
    }

    // OBV
    if (this.activeIndicators.obv && this.indSeries.obv) {
      this.indSeries.obv.setData(calculateOBV(this.bars));
    }

    // RSI
    if (this.activeIndicators.rsi && this.indSeries.rsi) {
      this.indSeries.rsi.setData(calculateRSI(this.bars, 14));
    }

    // MACD
    if (this.activeIndicators.macd && this.indSeries.macdLine) {
      const m = calculateMACD(this.bars, 12, 26, 9);
      this.indSeries.macdLine.setData(m.macd);
      this.indSeries.macdSig.setData(m.signal);
      this.indSeries.macdHist.setData(m.hist);
    }

    // Stochastic
    if (this.activeIndicators.stoch && this.indSeries.stochK) {
      const s = calculateStochastic(this.bars, 14, 3, 3);
      this.indSeries.stochK.setData(s.k);
      this.indSeries.stochD.setData(s.d);
    }

    // ATR
    if (this.activeIndicators.atr && this.indSeries.atr) {
      this.indSeries.atr.setData(calculateATR(this.bars, 14));
    }

    // ADX
    if (this.activeIndicators.adx && this.indSeries.adx) {
      this.indSeries.adx.setData(calculateADX(this.bars, 14));
    }

    // CCI
    if (this.activeIndicators.cci && this.indSeries.cci) {
      this.indSeries.cci.setData(calculateCCI(this.bars, 20));
    }

    // MFI
    if (this.activeIndicators.mfi && this.indSeries.mfi) {
      this.indSeries.mfi.setData(calculateMFI(this.bars, 14));
    }

    // Williams %R
    if (this.activeIndicators.williamsr && this.indSeries.williamsr) {
      this.indSeries.williamsr.setData(calculateWilliamsR(this.bars, 14));
    }
  }

  // ── Drawing Tools & Canvas Engine ───────────────────────────────────────
  setDrawingTool(tool) {
    this.activeTool = tool || 'cursor';
    const canvas = document.getElementById(this.canvasId);
    if (!canvas) return;

    if (this.activeTool === 'cursor') {
      canvas.style.pointerEvents = 'auto';
      canvas.style.cursor = 'default';
    } else {
      canvas.style.pointerEvents = 'auto';
      canvas.style.cursor = 'crosshair';
    }

    if (typeof this.onToolChanged === 'function') {
      this.onToolChanged(this.activeTool);
    }
  }

  toggleDrawingsVisibility() {
    this.drawingsVisible = !this.drawingsVisible;
    this.redrawDrawings();
    return this.drawingsVisible;
  }

  clearAllDrawings() {
    this.drawings = [];
    this.currentDrawing = null;
    this.selectedDrawing = null;
    this.redrawDrawings();
    if (typeof this.onDrawingsChanged === 'function') {
      this.onDrawingsChanged(this.drawings);
    }
  }

  deleteSelectedDrawing() {
    if (!this.selectedDrawing) return;
    const target = this.selectedDrawing;
    this.drawings = this.drawings.filter(d => d !== target && d.id !== target.id);
    this.selectedDrawing = null;
    this.isDraggingDrawing = false;
    this.dragStart = null;
    this.redrawDrawings();
    if (typeof this.onDrawingsChanged === 'function') {
      this.onDrawingsChanged(this.drawings);
    }
  }

  getDrawings() {
    return this.drawings;
  }

  setDrawings(drawings) {
    this.drawings = Array.isArray(drawings) ? drawings : [];
    this.selectedDrawing = null;
    this.redrawDrawings();
  }

  _initDrawingCanvas() {
    const canvas = document.getElementById(this.canvasId);
    if (!canvas) return;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    canvas.style.pointerEvents = 'auto';

    const resizeCanvas = () => {
      const container = document.getElementById(this.containerId);
      if (!container || !canvas) return;
      const rect = container.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        this.redrawDrawings();
      }
    };

    resizeCanvas();

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => resizeCanvas());
      const container = document.getElementById(this.containerId);
      if (container) ro.observe(container);
    }

    if (this.chart) {
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.redrawDrawings());
      this.chart.timeScale().subscribeVisibleTimeRangeChange(() => this.redrawDrawings());
    }

    canvas.addEventListener('mousedown', (e) => this._onCanvasMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this._onCanvasMouseMove(e));
    canvas.addEventListener('mouseup', (e) => this._onCanvasMouseUp(e));
    canvas.addEventListener('mouseleave', (e) => this._onCanvasMouseLeave(e));

    // Delete / Backspace key listener
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedDrawing) {
        if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
          return;
        }
        this.deleteSelectedDrawing();
      }
    });
  }

  _getCanvasPoint(e) {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let time = null;
    let price = null;

    if (this.chart && this.candleSeries) {
      time = this.chart.timeScale().coordinateToTime(x);
      price = this.candleSeries.coordinateToPrice(y);

      if (time === null && this.bars && this.bars.length > 0) {
        const logical = this.chart.timeScale().coordinateToLogical(x);
        if (logical !== null) {
          if (logical < 0) {
            time = this.bars[0].time;
          } else if (logical >= this.bars.length) {
            time = this.bars[this.bars.length - 1].time;
          } else {
            const idx = Math.floor(logical);
            time = this.bars[idx] ? this.bars[idx].time : this.bars[this.bars.length - 1].time;
          }
        }
      }
    }

    return { x, y, time, price };
  }

  _pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
  }

  _hitTest(x, y) {
    if (!this.drawingsVisible || !this.drawings) return null;

    // 1. Check handle points of selected drawing
    if (this.selectedDrawing) {
      const d = this.selectedDrawing;
      if (d.type === 'horizline') {
        const yLine = this.candleSeries ? this.candleSeries.priceToCoordinate(d.price) : null;
        if (yLine !== null && Math.abs(y - yLine) <= 8) {
          return { drawing: d, handle: 'body' };
        }
      } else if (d.p1) {
        const p1 = this._timePriceToXY(d.p1);
        const p2 = this._timePriceToXY(d.p2);
        if (p1 && Math.hypot(x - p1.x, y - p1.y) <= 10) return { drawing: d, handle: 'p1' };
        if (p2 && Math.hypot(x - p2.x, y - p2.y) <= 10) return { drawing: d, handle: 'p2' };
      }
    }

    // 2. Check all drawings from last to first
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];

      if (d.type === 'horizline') {
        const yLine = this.candleSeries ? this.candleSeries.priceToCoordinate(d.price) : null;
        if (yLine !== null && Math.abs(y - yLine) <= 8) {
          return { drawing: d, handle: 'body' };
        }
      }

      if (d.type === 'trendline' || d.type === 'fib' || d.type === 'rectangle' || d.type === 'ruler') {
        const p1 = this._timePriceToXY(d.p1);
        const p2 = this._timePriceToXY(d.p2);
        if (p1 && p2) {
          if (Math.hypot(x - p1.x, y - p1.y) <= 10) return { drawing: d, handle: 'p1' };
          if (Math.hypot(x - p2.x, y - p2.y) <= 10) return { drawing: d, handle: 'p2' };
          if (d.type === 'trendline' && this._pointToSegmentDistance(x, y, p1.x, p1.y, p2.x, p2.y) <= 8) {
            return { drawing: d, handle: 'body' };
          }
          if ((d.type === 'rectangle' || d.type === 'ruler' || d.type === 'fib') &&
              x >= Math.min(p1.x, p2.x) - 4 && x <= Math.max(p1.x, p2.x) + 4 &&
              y >= Math.min(p1.y, p2.y) - 4 && y <= Math.max(p1.y, p2.y) + 4) {
            return { drawing: d, handle: 'body' };
          }
        }
      }

      if (d.type === 'text' && d.p1) {
        const p1 = this._timePriceToXY(d.p1);
        if (p1) {
          if (x >= p1.x - 5 && x <= p1.x + 80 && y >= p1.y - 25 && y <= p1.y + 5) {
            return { drawing: d, handle: 'body' };
          }
        }
      }

      if (d.type === 'brush' && d.points) {
        for (let j = 0; j < d.points.length - 1; j++) {
          const pt1 = this._timePriceToXY(d.points[j]);
          const pt2 = this._timePriceToXY(d.points[j + 1]);
          if (pt1 && pt2 && this._pointToSegmentDistance(x, y, pt1.x, pt1.y, pt2.x, pt2.y) <= 8) {
            return { drawing: d, handle: 'body' };
          }
        }
      }
    }

    return null;
  }

  _onCanvasMouseDown(e) {
    const pt = this._getCanvasPoint(e);
    if (!pt || pt.price === null) return;

    // Check if user clicked the delete badge of selected drawing
    if (this.selectedDrawing && this.selectedBadgeRect) {
      const r = this.selectedBadgeRect;
      if (pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height) {
        this.deleteSelectedDrawing();
        return;
      }
    }

    if (this.activeTool === 'cursor') {
      const hit = this._hitTest(pt.x, pt.y);
      if (hit) {
        this.selectedDrawing = hit.drawing;
        this.isDraggingDrawing = true;
        this.dragHandle = hit.handle;
        this.dragStart = {
          x: pt.x,
          y: pt.y,
          time: pt.time,
          price: pt.price,
          p1: hit.drawing.p1 ? { ...hit.drawing.p1 } : null,
          p2: hit.drawing.p2 ? { ...hit.drawing.p2 } : null,
          horizPrice: hit.drawing.price,
        };
        this.redrawDrawings();
      } else {
        if (this.selectedDrawing) {
          this.selectedDrawing = null;
          this.redrawDrawings();
        }
        // Temporarily set canvas pointerEvents to none so click goes through to chart container below for panning
        if (this.canvas) this.canvas.style.pointerEvents = 'none';
        const reenable = () => {
          if (this.canvas) this.canvas.style.pointerEvents = 'auto';
          window.removeEventListener('mouseup', reenable);
        };
        window.addEventListener('mouseup', reenable);
      }
      return;
    }

    // Active tool drawing creation
    const point = { time: pt.time, price: pt.price };

    if (this.activeTool === 'horizline') {
      const d = {
        id: 'draw_' + Date.now(),
        type: 'horizline',
        price: pt.price,
        color: '#f59e0b',
      };
      this.drawings.push(d);
      this.selectedDrawing = d;
      this.setDrawingTool('cursor');
      this.redrawDrawings();
      if (this.onDrawingsChanged) this.onDrawingsChanged(this.drawings);
      return;
    }

    if (this.activeTool === 'text') {
      const txt = prompt('Enter note text:');
      if (txt && txt.trim()) {
        const d = {
          id: 'draw_' + Date.now(),
          type: 'text',
          p1: point,
          text: txt.trim(),
          color: '#ffffff',
        };
        this.drawings.push(d);
        this.selectedDrawing = d;
        this.setDrawingTool('cursor');
        this.redrawDrawings();
        if (this.onDrawingsChanged) this.onDrawingsChanged(this.drawings);
      } else {
        this.setDrawingTool('cursor');
      }
      return;
    }

    this.isDrawing = true;
    this.currentDrawing = {
      id: 'draw_' + Date.now(),
      type: this.activeTool,
      p1: point,
      p2: point,
      points: [point],
      color: this.activeTool === 'ruler' ? '#3b82f6' : (this.activeTool === 'brush' ? '#22c55e' : '#2962ff'),
    };
  }

  _onCanvasMouseMove(e) {
    const pt = this._getCanvasPoint(e);
    if (!pt) return;

    // 1. Handle creation of new drawing
    if (this.isDrawing && this.currentDrawing) {
      const point = { time: pt.time, price: pt.price };
      if (this.currentDrawing.type === 'brush') {
        this.currentDrawing.points.push(point);
      } else {
        this.currentDrawing.p2 = point;
      }
      this.redrawDrawings();
      return;
    }

    // 2. Handle dragging an existing drawing
    if (this.isDraggingDrawing && this.selectedDrawing && this.dragStart) {
      const d = this.selectedDrawing;
      const deltaPrice = pt.price - this.dragStart.price;

      if (d.type === 'horizline') {
        d.price = pt.price;
      } else if (this.dragHandle === 'p1' && d.p1) {
        d.p1 = { time: pt.time, price: pt.price };
      } else if (this.dragHandle === 'p2' && d.p2) {
        d.p2 = { time: pt.time, price: pt.price };
      } else if (this.dragHandle === 'body') {
        if (d.p1 && this.dragStart.p1) {
          d.p1.price = this.dragStart.p1.price + deltaPrice;
          if (pt.time && this.dragStart.time) d.p1.time = pt.time;
        }
        if (d.p2 && this.dragStart.p2) {
          d.p2.price = this.dragStart.p2.price + deltaPrice;
          if (pt.time && this.dragStart.time) d.p2.time = pt.time;
        }
        if (d.points && d.points.length > 0) {
          d.points = d.points.map(p => ({ time: p.time, price: p.price + deltaPrice }));
        }
      }
      this.redrawDrawings();
      return;
    }

    // 3. Cursor mode hover hit testing to change cursor style
    if (this.activeTool === 'cursor') {
      const hit = this._hitTest(pt.x, pt.y);
      if (hit) {
        if (this.canvas) this.canvas.style.cursor = hit.handle === 'body' ? 'move' : 'pointer';
      } else {
        if (this.canvas) this.canvas.style.cursor = 'default';
      }
    }
  }

  _onCanvasMouseUp(e) {
    if (this.isDraggingDrawing) {
      this.isDraggingDrawing = false;
      this.dragStart = null;
      if (this.onDrawingsChanged) this.onDrawingsChanged(this.drawings);
      return;
    }

    if (!this.isDrawing || !this.currentDrawing) return;
    const pt = this._getCanvasPoint(e);
    if (pt) {
      const point = { time: pt.time, price: pt.price };
      if (this.currentDrawing.type === 'brush') {
        this.currentDrawing.points.push(point);
      } else {
        this.currentDrawing.p2 = point;
      }
    }

    const created = { ...this.currentDrawing };
    this.drawings.push(created);
    this.selectedDrawing = created;
    this.isDrawing = false;
    this.currentDrawing = null;
    this.setDrawingTool('cursor');
    this.redrawDrawings();

    if (this.onDrawingsChanged) this.onDrawingsChanged(this.drawings);
  }

  _onCanvasMouseLeave(e) {
    if (this.isDrawing) {
      this._onCanvasMouseUp(e);
    }
  }

  _timePriceToXY(point) {
    if (!point || !this.chart || !this.candleSeries) return null;

    let x = this.chart.timeScale().timeToCoordinate(point.time);
    const y = this.candleSeries.priceToCoordinate(point.price);

    if (x === null && this.bars && this.bars.length > 0) {
      const idx = this.bars.findIndex(b => b.time === point.time);
      if (idx !== -1) {
        x = this.chart.timeScale().logicalToCoordinate(idx);
      }
    }

    if (x === null || y === null) return null;
    return { x, y };
  }

  redrawDrawings() {
    if (!this.canvas || !this.ctx) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.drawingsVisible) return;

    this.selectedBadgeRect = null;

    const all = [...this.drawings];
    if (this.isDrawing && this.currentDrawing) {
      all.push(this.currentDrawing);
    }

    all.forEach(item => this._renderShape(ctx, item));

    if (this.selectedDrawing) {
      this._renderSelectionOverlay(ctx, this.selectedDrawing);
    }
  }

  _renderSelectionOverlay(ctx, shape) {
    if (!shape) return;
    ctx.save();

    let badgeX = 20, badgeY = 20;

    if (shape.type === 'horizline') {
      const y = this.candleSeries ? this.candleSeries.priceToCoordinate(shape.price) : null;
      if (y !== null) {
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.canvas.width, y);
        ctx.stroke();

        badgeX = this.canvas.width - 90;
        badgeY = y - 11;
      }
    } else if (shape.p1) {
      const p1 = this._timePriceToXY(shape.p1);
      const p2 = this._timePriceToXY(shape.p2 || shape.p1);

      if (p1) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (p2) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p2.x, p2.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (p2) {
        badgeX = p2.x + 10;
        badgeY = p2.y - 11;
      } else if (p1) {
        badgeX = p1.x + 10;
        badgeY = p1.y - 11;
      }
    }

    if (this.canvas) {
      badgeX = Math.max(10, Math.min(this.canvas.width - 40, badgeX));
      badgeY = Math.max(10, Math.min(this.canvas.height - 30, badgeY));
    }

    // Draw Trash Bin Badge
    ctx.fillStyle = '#ef4444';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, 26, 22, 4);
      ctx.fill();
    } else {
      ctx.fillRect(badgeX, badgeY, 26, 22);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.fillText('🗑️', badgeX + 4, badgeY + 15);

    this.selectedBadgeRect = { x: badgeX, y: badgeY, width: 26, height: 22 };

    ctx.restore();
  }

  _renderShape(ctx, shape) {
    if (!shape || !shape.type) return;

    if (shape.type === 'horizline') {
      const y = this.candleSeries ? this.candleSeries.priceToCoordinate(shape.price) : null;
      if (y === null) return;

      ctx.save();
      ctx.strokeStyle = shape.color || '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.canvas.width, y);
      ctx.stroke();

      // Label
      ctx.setLineDash([]);
      ctx.fillStyle = shape.color || '#f59e0b';
      ctx.font = '10px sans-serif';
      const txt = (shape.price || 0).toFixed(2);
      ctx.fillRect(this.canvas.width - 55, y - 9, 50, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(txt, this.canvas.width - 50, y + 4);
      ctx.restore();
      return;
    }

    if (shape.type === 'trendline') {
      const p1 = this._timePriceToXY(shape.p1);
      const p2 = this._timePriceToXY(shape.p2);
      if (!p1 || !p2) return;

      ctx.save();
      ctx.strokeStyle = shape.color || '#2962ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Handles
      [p1, p2].forEach(p => {
        ctx.fillStyle = '#2962ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
      return;
    }

    if (shape.type === 'fib') {
      const p1 = this._timePriceToXY(shape.p1);
      const p2 = this._timePriceToXY(shape.p2);
      if (!p1 || !p2) return;

      const levels = [
        { r: 0, col: '#787b86' },
        { r: 0.236, col: '#ef5350' },
        { r: 0.382, col: '#f59e0b' },
        { r: 0.5, col: '#22c55e' },
        { r: 0.618, col: '#06b6d4' },
        { r: 0.786, col: '#3b82f6' },
        { r: 1.0, col: '#a855f7' }
      ];

      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);
      const price1 = shape.p1.price;
      const price2 = shape.p2.price;
      const diff = price2 - price1;

      ctx.save();
      levels.forEach(lvl => {
        const lvlPrice = price1 + diff * lvl.r;
        const y = this.candleSeries ? this.candleSeries.priceToCoordinate(lvlPrice) : null;
        if (y === null) return;

        ctx.strokeStyle = lvl.col;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
        ctx.stroke();

        ctx.fillStyle = lvl.col;
        ctx.font = '10px sans-serif';
        ctx.fillText(`${lvl.r} (${lvlPrice.toFixed(2)})`, minX + 5, y - 3);
      });

      // Baseline connecting p1 and p2
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      ctx.restore();
      return;
    }

    if (shape.type === 'rectangle') {
      const p1 = this._timePriceToXY(shape.p1);
      const p2 = this._timePriceToXY(shape.p2);
      if (!p1 || !p2) return;

      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);

      ctx.save();
      ctx.fillStyle = 'rgba(41, 98, 255, 0.15)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
      return;
    }

    if (shape.type === 'brush') {
      if (!shape.points || shape.points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = shape.color || '#22c55e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      shape.points.forEach(pt => {
        const xy = this._timePriceToXY(pt);
        if (xy) {
          if (!started) { ctx.moveTo(xy.x, xy.y); started = true; }
          else ctx.lineTo(xy.x, xy.y);
        }
      });
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (shape.type === 'text') {
      const p1 = this._timePriceToXY(shape.p1);
      if (!p1) return;

      ctx.save();
      ctx.font = '12px sans-serif';
      const metrics = ctx.measureText(shape.text);
      const w = metrics.width + 12;
      const h = 20;

      ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
      ctx.strokeStyle = '#3b82f6';
      ctx.fillRect(p1.x, p1.y - h, w, h);
      ctx.strokeRect(p1.x, p1.y - h, w, h);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(shape.text, p1.x + 6, p1.y - 6);
      ctx.restore();
      return;
    }

    if (shape.type === 'ruler') {
      const p1 = this._timePriceToXY(shape.p1);
      const p2 = this._timePriceToXY(shape.p2);
      if (!p1 || !p2) return;

      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);

      const priceDiff = shape.p2.price - shape.p1.price;
      const pctChange = shape.p1.price ? (priceDiff / shape.p1.price) * 100 : 0;
      const col = priceDiff >= 0 ? '#22c55e' : '#ef5350';

      ctx.save();
      ctx.fillStyle = priceDiff >= 0 ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);

      // Info badge
      const infoText = `${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(2)} (${pctChange > 0 ? '+' : ''}${pctChange.toFixed(2)}%)`;
      ctx.fillStyle = col;
      ctx.font = 'bold 11px sans-serif';
      const textWidth = ctx.measureText(infoText).width;
      const badgeX = x + w / 2 - textWidth / 2 - 6;
      const badgeY = y + h / 2 - 10;

      ctx.fillRect(badgeX, badgeY, textWidth + 12, 20);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(infoText, badgeX + 6, badgeY + 14);

      ctx.restore();
      return;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  destroy() {
    this._clearPriceLines();
    if (this.chart) {
      this.chart.remove();
      this.chart       = null;
      this.candleSeries = null;
      this.volSeries   = null;
      this.indSeries   = {};
    }
  }
}

// ── Technical Indicator Calculation Helpers ──────────────────────────────────

function calculateSMA(bars, period) {
  if (!bars || bars.length < period) return [];
  const res = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += bars[i - j].close;
    res.push({ time: bars[i].time, value: +(sum / period).toFixed(4) });
  }
  return res;
}

function calculateEMA(bars, period) {
  if (!bars || bars.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  let prev = sum / period;
  const res = [{ time: bars[period - 1].time, value: +prev.toFixed(4) }];
  for (let i = period; i < bars.length; i++) {
    const val = (bars[i].close - prev) * k + prev;
    res.push({ time: bars[i].time, value: +val.toFixed(4) });
    prev = val;
  }
  return res;
}

function calculateVWAP(bars) {
  if (!bars || bars.length === 0) return [];
  const res = [];
  let cumVol = 0;
  let cumVal = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 1;
    cumVol += v;
    cumVal += tp * v;
    res.push({ time: b.time, value: +(cumVal / cumVol).toFixed(2) });
  }
  return res;
}

function calculateBollinger(bars, period = 20, mult = 2) {
  if (!bars || bars.length < period) return { upper: [], middle: [], lower: [] };
  const upper = [], middle = [], lower = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += bars[i - j].close;
    const mean = sum / period;
    let v = 0;
    for (let j = 0; j < period; j++) v += Math.pow(bars[i - j].close - mean, 2);
    const sd = Math.sqrt(v / period);
    const t = bars[i].time;
    middle.push({ time: t, value: +mean.toFixed(2) });
    upper.push({ time: t, value: +(mean + mult * sd).toFixed(2) });
    lower.push({ time: t, value: +(mean - mult * sd).toFixed(2) });
  }
  return { upper, middle, lower };
}

function calculateSupertrend(bars, period = 10, multiplier = 3) {
  if (!bars || bars.length <= period) return [];
  const trs = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atrs = [];
  let trSum = 0;
  for (let i = 0; i < period; i++) trSum += trs[i];
  atrs[period - 1] = trSum / period;
  for (let i = period; i < bars.length; i++) {
    atrs[i] = (atrs[i - 1] * (period - 1) + trs[i]) / period;
  }

  const res = [];
  let prevFinalUpper = 0, prevFinalLower = 0, prevTrend = 1;
  for (let i = period - 1; i < bars.length; i++) {
    const b = bars[i];
    const hl2 = (b.high + b.low) / 2;
    const atr = atrs[i];
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;

    const prevClose = i > 0 ? bars[i - 1].close : b.close;
    const finalUpper = (basicUpper < prevFinalUpper || prevClose > prevFinalUpper) ? basicUpper : prevFinalUpper;
    const finalLower = (basicLower > prevFinalLower || prevClose < prevFinalLower) ? basicLower : prevFinalLower;

    let trend = prevTrend;
    if (prevTrend === 1 && b.close < finalLower) trend = -1;
    else if (prevTrend === -1 && b.close > finalUpper) trend = 1;

    const stVal = trend === 1 ? finalLower : finalUpper;
    res.push({
      time: b.time,
      value: +stVal.toFixed(2),
    });

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevTrend = trend;
  }
  return res;
}

function calculateIchimoku(bars) {
  if (!bars || bars.length < 52) return { tenkan: [], kijun: [], spanA: [], spanB: [] };
  const hl = (start, len) => {
    let maxH = -Infinity, minL = Infinity;
    for (let i = start - len + 1; i <= start; i++) {
      if (bars[i].high > maxH) maxH = bars[i].high;
      if (bars[i].low < minL) minL = bars[i].low;
    }
    return (maxH + minL) / 2;
  };
  const tenkan = [], kijun = [], spanA = [], spanB = [];
  for (let i = 8; i < bars.length; i++) {
    tenkan.push({ time: bars[i].time, value: +hl(i, 9).toFixed(2) });
  }
  for (let i = 25; i < bars.length; i++) {
    kijun.push({ time: bars[i].time, value: +hl(i, 26).toFixed(2) });
  }
  for (let i = 25; i < bars.length; i++) {
    const t = hl(i, 9);
    const k = hl(i, 26);
    spanA.push({ time: bars[i].time, value: +((t + k) / 2).toFixed(2) });
  }
  for (let i = 51; i < bars.length; i++) {
    spanB.push({ time: bars[i].time, value: +hl(i, 52).toFixed(2) });
  }
  return { tenkan, kijun, spanA, spanB };
}

function calculatePivotPoints(bars) {
  if (!bars || bars.length < 5) return null;
  let high = -Infinity, low = Infinity;
  const recent = bars.slice(-20);
  for (const b of recent) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  const close = recent[recent.length - 1].close;
  const p = (high + low + close) / 3;
  return {
    P:  +p.toFixed(2),
    R1: +(2 * p - low).toFixed(2),
    S1: +(2 * p - high).toFixed(2),
    R2: +(p + (high - low)).toFixed(2),
    S2: +(p - (high - low)).toFixed(2),
  };
}

function calculateFVG(bars) {
  if (!bars || bars.length < 5) return [];
  const gaps = [];
  for (let i = bars.length - 1; i >= 2 && gaps.length < 4; i--) {
    const curr = bars[i];
    const prev2 = bars[i - 2];
    if (curr.low > prev2.high) {
      gaps.push({ type: 'bullish', top: curr.low, bottom: prev2.high, time: curr.time });
    } else if (curr.high < prev2.low) {
      gaps.push({ type: 'bearish', top: prev2.low, bottom: curr.high, time: curr.time });
    }
  }
  return gaps;
}

function calculateVolumeProfile(bars) {
  if (!bars || bars.length < 10) return null;
  const recent = bars.slice(-80);
  let minP = Infinity, maxP = -Infinity;
  for (const b of recent) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  const numBins = 24;
  const binSize = (maxP - minP) / numBins;
  if (binSize <= 0) return null;
  const bins = new Array(numBins).fill(0);

  for (const b of recent) {
    const avg = (b.high + b.low + b.close) / 3;
    const idx = Math.min(numBins - 1, Math.max(0, Math.floor((avg - minP) / binSize)));
    bins[idx] += (b.volume || 1);
  }

  let maxBin = 0, pocIdx = 0;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > maxBin) { maxBin = bins[i]; pocIdx = i; }
  }
  const poc = minP + (pocIdx + 0.5) * binSize;
  const vah = Math.min(maxP, poc + binSize * 4);
  const val = Math.max(minP, poc - binSize * 4);
  return { poc: +poc.toFixed(2), vah: +vah.toFixed(2), val: +val.toFixed(2) };
}

function calculateRSI(bars, period = 14) {
  if (!bars || bars.length <= period) return [];
  const res = [];
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  let rs = al === 0 ? 100 : ag / al;
  res.push({ time: bars[period].time, value: +(100 - 100 / (1 + rs)).toFixed(2) });

  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const gain = d >= 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + gain) / period;
    al = (al * (period - 1) + loss) / period;
    rs = al === 0 ? 100 : ag / al;
    res.push({ time: bars[i].time, value: +(100 - 100 / (1 + rs)).toFixed(2) });
  }
  return res;
}

function calculateMACD(bars, fast = 12, slow = 26, signal = 9) {
  if (!bars || bars.length < slow + signal) return { macd: [], signal: [], hist: [] };
  const emaFast = calculateEMA(bars, fast);
  const emaSlow = calculateEMA(bars, slow);
  const slowMap = {};
  emaSlow.forEach(d => slowMap[d.time] = d.value);

  const macdLine = [];
  for (const f of emaFast) {
    if (slowMap[f.time] !== undefined) {
      macdLine.push({ time: f.time, close: f.value - slowMap[f.time] });
    }
  }
  const signalLine = calculateEMA(macdLine, signal);
  const sigMap = {};
  signalLine.forEach(s => sigMap[s.time] = s.value);

  const macdRes = [], sigRes = [], histRes = [];
  for (const m of macdLine) {
    const sigVal = sigMap[m.time];
    macdRes.push({ time: m.time, value: +m.close.toFixed(4) });
    if (sigVal !== undefined) {
      sigRes.push({ time: m.time, value: +sigVal.toFixed(4) });
      const h = m.close - sigVal;
      histRes.push({
        time: m.time,
        value: +h.toFixed(4),
        color: h >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)'
      });
    }
  }
  return { macd: macdRes, signal: sigRes, hist: histRes };
}

function calculateStochastic(bars, kPeriod = 14, dPeriod = 3, smooth = 3) {
  if (!bars || bars.length < kPeriod + smooth + dPeriod) return { k: [], d: [] };
  const rawK = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let minL = Infinity, maxH = -Infinity;
    for (let j = 0; j < kPeriod; j++) {
      const b = bars[i - j];
      if (b.low < minL) minL = b.low;
      if (b.high > maxH) maxH = b.high;
    }
    const den = maxH - minL;
    const k = den === 0 ? 50 : ((bars[i].close - minL) / den) * 100;
    rawK.push({ time: bars[i].time, close: k });
  }
  const smoothK = calculateSMA(rawK, smooth);
  const dLine = calculateSMA(smoothK.map(x => ({ time: x.time, close: x.value })), dPeriod);
  return {
    k: smoothK.map(x => ({ time: x.time, value: +x.value.toFixed(2) })),
    d: dLine.map(x => ({ time: x.time, value: +x.value.toFixed(2) }))
  };
}

function calculateATR(bars, period = 14) {
  if (!bars || bars.length <= period) return [];
  const trs = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let atr = sum / period;
  const res = [{ time: bars[period - 1].time, value: +atr.toFixed(2) }];
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    res.push({ time: bars[i].time, value: +atr.toFixed(2) });
  }
  return res;
}

function calculateADX(bars, period = 14) {
  if (!bars || bars.length < period * 2) return [];
  const trs = [], pDMs = [], mDMs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, ph = bars[i - 1].high, pl = bars[i - 1].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph;
    const downMove = pl - l;
    pDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let tr14 = 0, pdm14 = 0, mdm14 = 0;
  for (let i = 0; i < period; i++) { tr14 += trs[i]; pdm14 += pDMs[i]; mdm14 += mDMs[i]; }
  const dxs = [];
  for (let i = period; i < trs.length; i++) {
    tr14 = tr14 - tr14 / period + trs[i];
    pdm14 = pdm14 - pdm14 / period + pDMs[i];
    mdm14 = mdm14 - mdm14 / period + mDMs[i];
    const pdi = (pdm14 / (tr14 || 1)) * 100;
    const mdi = (mdm14 / (tr14 || 1)) * 100;
    const dx = Math.abs(pdi - mdi) / ((pdi + mdi) || 1) * 100;
    dxs.push({ time: bars[i + 1].time, close: dx });
  }
  const adx = calculateSMA(dxs, period);
  return adx.map(x => ({ time: x.time, value: +x.value.toFixed(2) }));
}

function calculateCCI(bars, period = 20) {
  if (!bars || bars.length < period) return [];
  const tps = bars.map(b => (b.high + b.low + b.close) / 3);
  const res = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += tps[i - j];
    const sma = sum / period;
    let md = 0;
    for (let j = 0; j < period; j++) md += Math.abs(tps[i - j] - sma);
    const meanDev = md / period;
    const cci = meanDev === 0 ? 0 : (tps[i] - sma) / (0.015 * meanDev);
    res.push({ time: bars[i].time, value: +cci.toFixed(2) });
  }
  return res;
}

function calculateOBV(bars) {
  if (!bars || bars.length === 0) return [];
  const res = [{ time: bars[0].time, value: bars[0].volume || 0 }];
  let obv = bars[0].volume || 0;
  for (let i = 1; i < bars.length; i++) {
    const v = bars[i].volume || 0;
    if (bars[i].close > bars[i - 1].close) obv += v;
    else if (bars[i].close < bars[i - 1].close) obv -= v;
    res.push({ time: bars[i].time, value: +obv.toFixed(0) });
  }
  return res;
}

function calculateMFI(bars, period = 14) {
  if (!bars || bars.length <= period) return [];
  const tps = bars.map(b => (b.high + b.low + b.close) / 3);
  const mfs = bars.map((b, i) => tps[i] * (b.volume || 1));
  const res = [];
  for (let i = period; i < bars.length; i++) {
    let pos = 0, neg = 0;
    for (let j = 0; j < period; j++) {
      const idx = i - j;
      if (tps[idx] > tps[idx - 1]) pos += mfs[idx];
      else if (tps[idx] < tps[idx - 1]) neg += mfs[idx];
    }
    const mr = neg === 0 ? 100 : pos / neg;
    const mfi = 100 - (100 / (1 + mr));
    res.push({ time: bars[i].time, value: +mfi.toFixed(2) });
  }
  return res;
}

function calculateWilliamsR(bars, period = 14) {
  if (!bars || bars.length < period) return [];
  const res = [];
  for (let i = period - 1; i < bars.length; i++) {
    let maxH = -Infinity, minL = Infinity;
    for (let j = 0; j < period; j++) {
      const b = bars[i - j];
      if (b.high > maxH) maxH = b.high;
      if (b.low < minL) minL = b.low;
    }
    const den = maxH - minL;
    const wr = den === 0 ? -50 : ((maxH - bars[i].close) / den) * -100;
    res.push({ time: bars[i].time, value: +wr.toFixed(2) });
  }
  return res;
}
