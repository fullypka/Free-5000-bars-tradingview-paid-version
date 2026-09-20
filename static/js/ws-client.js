/**
 * ws-client.js
 * ─────────────────────────────────────────────────────────────────────────
 * Wraps the Socket.IO connection and routes `tick` events to chart panes.
 *
 * Public API (global object `WsClient`)
 * ───────────────────────────────────────
 *   WsClient.connect()                               → open socket
 *   WsClient.subscribe(paneId, symbol, tf, source)   → start stream
 *   WsClient.unsubscribe(paneId)                     → stop stream
 *   WsClient.registerPane(paneId, chartPane)         → attach a ChartPane
 *   WsClient.unregisterPane(paneId)                  → detach a ChartPane
 */

const WsClient = (() => {
  let socket = null;

  /** Map of pane_id → ChartPane instance */
  const panes = {};

  /**
   * Connect to the Flask-SocketIO server.
   * Safe to call multiple times — ignores if already connected.
   */
  function connect() {
    if (socket) return;

    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.info('[WS] Connected:', socket.id);
      // Re-subscribe all registered panes on reconnect
      if (typeof Dashboard !== 'undefined') {
        Dashboard.resubscribeAll();
      }
    });

    socket.on('disconnect', (reason) => {
      console.warn('[WS] Disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
      console.error('[WS] Connection error:', err.message);
    });

    socket.on('tick', (data) => {
      const { pane_id, ...bar } = data;
      const pane = panes[pane_id];
      if (pane) {
        pane.onTick(bar);
      }
    });

    socket.on('error', (data) => {
      const { pane_id, message } = data;
      console.error(`[WS] Server error on pane ${pane_id}: ${message}`);
      const pane = panes[pane_id];
      if (pane) pane.showError(message);
    });
  }

  /**
   * Subscribe a pane to a live stream.
   * @param {number} paneId
   * @param {string} symbol  e.g. "BTC" or "RELIANCE.NS"
   * @param {string} tf      e.g. "1m", "15m", "1h"
   * @param {string} source  e.g. "hyperliquid" or "yfinance"
   */
  function subscribe(paneId, symbol, tf, source) {
    if (!socket || !socket.connected) {
      console.warn('[WS] subscribe called before connect');
      return;
    }
    socket.emit('subscribe', { pane_id: paneId, symbol, tf, source });
  }

  /**
   * Unsubscribe a pane from its current stream.
   * @param {number} paneId
   */
  function unsubscribe(paneId) {
    if (!socket || !socket.connected) return;
    socket.emit('unsubscribe', { pane_id: paneId });
  }

  /**
   * Register a ChartPane so incoming ticks are routed to it.
   * @param {number} paneId
   * @param {ChartPane} chartPane
   */
  function registerPane(paneId, chartPane) {
    panes[paneId] = chartPane;
  }

  /**
   * Remove a pane from the routing table.
   * @param {number} paneId
   */
  function unregisterPane(paneId) {
    delete panes[paneId];
  }

  return { connect, subscribe, unsubscribe, registerPane, unregisterPane };
})();
