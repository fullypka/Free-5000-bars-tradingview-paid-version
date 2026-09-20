"""
app.py — Flask + Flask-SocketIO backend for the Trading Dashboard.

Routes
------
GET  /                            → serves index.html
GET  /api/sources                 → list of registered data sources
GET  /api/symbols?source=<name>   → symbol list for a source
GET  /api/history                 → OHLCV history
     ?source=<name>&symbol=<sym>&tf=<tf>&limit=<int>

SocketIO events (namespace '/')
-------------------------------
client → server:
  subscribe    {pane_id, symbol, tf, source}
  unsubscribe  {pane_id}

server → client:
  tick         {pane_id, time, open, high, low, close, volume}
  error        {pane_id, message}
"""

import eventlet
eventlet.monkey_patch()          # must be FIRST — patches socket/ssl/threading

import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("app")

from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS

from data_source import DATA_SOURCES

# ── Flask app ────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="/static")
CORS(app)

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
    logger=False,
    engineio_logger=False,
)

# Active subscriptions: { sid: { pane_id: (source_name, symbol, tf) } }
_subs: dict = {}


# ── Static / Index ───────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ── REST endpoints ───────────────────────────────────────────────────────────
@app.route("/api/sources")
def api_sources():
    return jsonify(list(DATA_SOURCES.keys()))


@app.route("/api/symbols")
def api_symbols():
    source_name = request.args.get("source", "hyperliquid")
    source = DATA_SOURCES.get(source_name)
    if source is None:
        return jsonify({"error": f"Unknown source '{source_name}'"}), 404
    return jsonify(source.get_symbols())


@app.route("/api/history")
def api_history():
    source_name = request.args.get("source", "hyperliquid")
    symbol      = request.args.get("symbol", "BTC")
    tf          = request.args.get("tf", "1m")
    limit       = int(request.args.get("limit", 20000))

    source = DATA_SOURCES.get(source_name)
    if source is None:
        return jsonify({"error": f"Unknown source '{source_name}'"}), 404

    try:
        bars = source.get_history(symbol, tf, limit)
        return jsonify(bars)
    except Exception as exc:
        log.error("History fetch failed for %s %s %s: %s", source_name, symbol, tf, exc)
        return jsonify({"error": str(exc)}), 500


# ── SocketIO events ──────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    sid = request.sid
    _subs[sid] = {}
    log.info("Client connected: %s", sid)


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    _cleanup_all(sid)
    _subs.pop(sid, None)
    log.info("Client disconnected: %s", sid)


@socketio.on("subscribe")
def on_subscribe(data):
    sid      = request.sid
    pane_id  = data.get("pane_id")
    symbol   = data.get("symbol", "BTC")
    tf       = data.get("tf", "1m")
    src_name = data.get("source", "hyperliquid")

    source = DATA_SOURCES.get(src_name)
    if source is None:
        emit("error", {"pane_id": pane_id, "message": f"Unknown source: {src_name}"})
        return

    # Cancel old subscription for this pane (if any)
    _cancel_pane(sid, pane_id)

    # Register new subscription
    _subs.setdefault(sid, {})[pane_id] = (src_name, symbol, tf)

    def on_tick(bar: dict):
        """Called from a background thread/greenlet by the data source."""
        socketio.emit("tick", {"pane_id": pane_id, **bar}, to=sid)

    source.start_stream(sid, pane_id, symbol, tf, on_tick)
    log.info("[%s] pane %s → %s %s %s", sid[:6], pane_id, src_name, symbol, tf)


@socketio.on("unsubscribe")
def on_unsubscribe(data):
    sid     = request.sid
    pane_id = data.get("pane_id")
    _cancel_pane(sid, pane_id)


# ── Helpers ──────────────────────────────────────────────────────────────────
def _cancel_pane(sid: str, pane_id: int) -> None:
    pane_subs = _subs.get(sid, {})
    if pane_id in pane_subs:
        src_name, symbol, tf = pane_subs.pop(pane_id)
        src = DATA_SOURCES.get(src_name)
        if src:
            src.stop_stream(sid, pane_id)


def _cleanup_all(sid: str) -> None:
    for pane_id, (src_name, symbol, tf) in list(_subs.get(sid, {}).items()):
        src = DATA_SOURCES.get(src_name)
        if src:
            src.stop_stream(sid, pane_id)


# ── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log.info("  Trading Dashboard  →  http://localhost:5000")
    log.info("  Sources: %s", list(DATA_SOURCES.keys()))
    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
