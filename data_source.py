"""
data_source.py — Pluggable data-source registry for the Trading Dashboard.

To add a new broker (Alpaca, Binance, Zerodha, Polygon, etc.):
  1. Create a class that follows the DataSource interface below.
  2. Add one entry to DATA_SOURCES at the bottom of this file.

DataSource interface:
  get_symbols() -> list[str]
  get_history(symbol: str, tf: str, limit: int) -> list[dict]
      Returns list of {time, open, high, low, close, volume} dicts.
      `time` is a Unix timestamp in seconds (UTC).
  start_stream(sid: str, pane_id: int, symbol: str, tf: str, callback: callable) -> None
      Starts emitting live ticks.  callback(bar: dict) is called on each new bar.
  stop_stream(sid: str, pane_id: int) -> None
      Stops the live stream for this (sid, pane_id) pair.
"""

import threading
import time
import json
import logging

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
import ssl
import yfinance as yf
import websocket

log = logging.getLogger("data_source")


# ─────────────────────────────────────────────────────────────────────────────
# Hyperliquid  (no API key required)
# ─────────────────────────────────────────────────────────────────────────────

class HyperliquidSource:
    """
    Streams crypto perpetual-futures candles from Hyperliquid.
    One shared WebSocket connection; multiple (sid, pane_id) callbacks can
    subscribe to the same (symbol, tf) without duplicating the WS feed.
    """

    WS_URL   = "wss://api.hyperliquid.xyz/ws"
    REST_URL = "https://api.hyperliquid.xyz/info"

    SYMBOLS = [
        "BTC", "ETH", "SOL", "AVAX", "DOGE", "MATIC", "ARB", "OP",
        "LINK", "UNI", "AAVE", "INJ", "SUI", "APT", "TIA", "SEI",
        "ATOM", "DOT", "ADA", "XRP", "LTC", "BCH", "FIL", "MKR",
        "LDO", "GMX", "PERP", "BLUR", "WIF", "PEPE", "BONK",
        "JUP", "PYTH", "W", "STRK", "MANTA", "ZRO", "FRIEND",
    ]

    # display_tf → hyperliquid API tf
    TF_MAP = {
        "1m":  "1m",
        "5m":  "5m",
        "15m": "15m",
        "30m": "30m",
        "1h":  "1h",
        "4h":  "4h",
        "1d":  "1d",
    }

    # tf → approximate seconds per bar (used to calculate start_time for history)
    TF_SECONDS = {
        "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
        "1h": 3600, "4h": 14400, "1d": 86400,
    }

    def __init__(self):
        self._ws          = None
        self._ws_thread   = None
        self._connected   = False
        self._connecting  = False
        # {(symbol, hl_tf): {(sid, pane_id): callback}}
        self._subscriptions: dict = {}
        self._lock = threading.Lock()

    # ── Public API ──────────────────────────────────────────────────────────

    def get_symbols(self) -> list:
        return self.SYMBOLS

    def get_history(self, symbol: str, tf: str, limit: int = 20000) -> list:
        hl_tf    = self.TF_MAP.get(tf, "1m")
        bar_secs = self.TF_SECONDS.get(tf, 60)
        BATCH    = 5000   # Hyperliquid caps each response at ~5000 bars

        all_candles: dict = {}   # keyed by open-time ms → dedup
        end_ms = int(time.time() * 1000)

        batches_needed = max(1, -(-limit // BATCH))   # ceiling division

        for _ in range(batches_needed):
            start_ms = end_ms - bar_secs * BATCH * 1000
            payload = {
                "type": "candleSnapshot",
                "req": {
                    "coin":      symbol,
                    "interval":  hl_tf,
                    "startTime": start_ms,
                    "endTime":   end_ms,
                },
            }
            try:
                resp = requests.post(self.REST_URL, json=payload, timeout=15, verify=False)
                resp.raise_for_status()
                candles = resp.json()
            except Exception as exc:
                log.error("[HL] History error for %s/%s: %s", symbol, tf, exc)
                break

            if not isinstance(candles, list) or not candles:
                break

            for c in candles:
                all_candles[c["t"]] = c

            # Move end_ms back to just before the earliest candle in this batch
            earliest_t = min(c["t"] for c in candles)
            end_ms = earliest_t - 1

            # Stop if we already have enough
            if len(all_candles) >= limit:
                break

        if not all_candles:
            return []

        bars = [
            {
                "time":   int(c["t"] / 1000),
                "open":   float(c["o"]),
                "high":   float(c["h"]),
                "low":    float(c["l"]),
                "close":  float(c["c"]),
                "volume": float(c["v"]),
            }
            for c in sorted(all_candles.values(), key=lambda x: x["t"])
        ]
        return bars[-limit:]

    def start_stream(self, sid: str, pane_id: int,
                     symbol: str, tf: str, callback) -> None:
        hl_tf = self.TF_MAP.get(tf, "1m")
        key   = (symbol, hl_tf)
        with self._lock:
            if key not in self._subscriptions:
                self._subscriptions[key] = {}
            self._subscriptions[key][(sid, pane_id)] = callback

        if self._connected:
            self._send_subscribe(symbol, hl_tf)
        elif not self._connecting:
            self._start_ws()

    def stop_stream(self, sid: str, pane_id: int) -> None:
        with self._lock:
            for key in list(self._subscriptions.keys()):
                pair = (sid, pane_id)
                if pair in self._subscriptions[key]:
                    del self._subscriptions[key][pair]
                    if not self._subscriptions[key]:
                        del self._subscriptions[key]
                        symbol, hl_tf = key
                        self._send_unsubscribe(symbol, hl_tf)

    # ── WebSocket internals ─────────────────────────────────────────────────

    def _send_subscribe(self, symbol: str, hl_tf: str) -> None:
        if self._ws and self._connected:
            try:
                self._ws.send(json.dumps({
                    "method": "subscribe",
                    "subscription": {"type": "candle", "coin": symbol, "interval": hl_tf},
                }))
            except Exception as exc:
                log.warning("[HL] Subscribe send failed: %s", exc)

    def _send_unsubscribe(self, symbol: str, hl_tf: str) -> None:
        if self._ws and self._connected:
            try:
                self._ws.send(json.dumps({
                    "method": "unsubscribe",
                    "subscription": {"type": "candle", "coin": symbol, "interval": hl_tf},
                }))
            except Exception as exc:
                log.warning("[HL] Unsubscribe send failed: %s", exc)

    def _start_ws(self) -> None:
        if self._connecting or self._connected:
            return
        self._connecting = True

        def on_open(ws):
            log.info("[HL] WebSocket connected")
            self._connected  = True
            self._connecting = False
            # Re-subscribe to all known feeds
            with self._lock:
                for (symbol, hl_tf) in list(self._subscriptions.keys()):
                    self._send_subscribe(symbol, hl_tf)

        def on_message(ws, message):
            try:
                data = json.loads(message)
                channel = data.get("channel", "")
                if channel == "candle":
                    c      = data["data"]
                    symbol = c.get("s", "")
                    hl_tf  = c.get("i", "1m")
                    key    = (symbol, hl_tf)
                    bar    = {
                        "time":   int(c["t"] / 1000),
                        "open":   float(c["o"]),
                        "high":   float(c["h"]),
                        "low":    float(c["l"]),
                        "close":  float(c["c"]),
                        "volume": float(c["v"]),
                    }
                    with self._lock:
                        callbacks = list(self._subscriptions.get(key, {}).values())
                    for cb in callbacks:
                        try:
                            cb(bar)
                        except Exception as exc:
                            log.warning("[HL] Callback error: %s", exc)
                # ignore ping, subscriptionResponse, etc.
            except Exception as exc:
                log.debug("[HL] on_message parse error: %s", exc)

        def on_error(ws, error):
            log.warning("[HL] WebSocket error: %s", error)

        def on_close(ws, close_status_code, close_msg):
            log.info("[HL] WebSocket closed (%s). Reconnecting in 5 s …", close_status_code)
            self._connected  = False
            self._connecting = False
            time.sleep(5)
            with self._lock:
                has_subs = bool(self._subscriptions)
            if has_subs:
                self._start_ws()

        self._ws = websocket.WebSocketApp(
            self.WS_URL,
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        self._ws_thread = threading.Thread(
            target=self._ws.run_forever,
            kwargs={"ping_interval": 30, "ping_timeout": 10, "sslopt": {"cert_reqs": ssl.CERT_NONE}},
            daemon=True,
        )
        self._ws_thread.start()


# ─────────────────────────────────────────────────────────────────────────────
# yFinance  (Indian stocks via .NS / .BO suffixes — no API key required)
# ─────────────────────────────────────────────────────────────────────────────

class YFinanceSource:
    """
    Polls Yahoo Finance every ~3 seconds for the latest candle bar.
    Indian NSE stocks use the '.NS' suffix; BSE stocks use '.BO'.
    """

    # Nifty 50 + a few BSE giants
    SYMBOLS = [
        # Nifty 50
        "RELIANCE.NS", "TCS.NS",       "HDFCBANK.NS",  "INFY.NS",     "ICICIBANK.NS",
        "HINDUNILVR.NS","SBIN.NS",     "BHARTIARTL.NS","ITC.NS",      "KOTAKBANK.NS",
        "LT.NS",        "AXISBANK.NS", "ASIANPAINT.NS","MARUTI.NS",   "BAJFINANCE.NS",
        "WIPRO.NS",     "ULTRACEMCO.NS","NESTLEIND.NS", "POWERGRID.NS","TITAN.NS",
        "NTPC.NS",      "HCLTECH.NS",  "SUNPHARMA.NS", "ONGC.NS",     "M&M.NS",
        "ADANIENT.NS",  "ADANIPORTS.NS","BAJAJFINSV.NS","BPCL.NS",    "BRITANNIA.NS",
        "CIPLA.NS",     "COALINDIA.NS","DRREDDY.NS",   "EICHERMOT.NS","GRASIM.NS",
        "HEROMOTOCO.NS","HINDALCO.NS", "JSWSTEEL.NS",  "INDUSINDBK.NS","LTIM.NS",
        "SBILIFE.NS",   "SHRIRAMFIN.NS","TATACONSUM.NS","TATAMOTORS.NS","TATASTEEL.NS",
        "TECHM.NS",     "TRENT.NS",    "APOLLOHOSP.NS","DIVISLAB.NS", "BAJAJ-AUTO.NS",
        # BSE equivalents (a few)
        "RELIANCE.BO",  "TCS.BO",      "INFY.BO",
    ]

    # display_tf → (yfinance period, yfinance interval)
    TF_MAP = {
        "1m":  ("7d",   "1m"),
        "5m":  ("60d",  "5m"),
        "15m": ("60d",  "15m"),
        "30m": ("60d",  "30m"),
        "1h":  ("730d", "1h"),
        "4h":  ("730d", "1h"),   # yfinance has no 4h; fall back to 1h
        "1d":  ("5y",   "1d"),
    }

    POLL_INTERVAL = 3  # seconds between polls

    def __init__(self):
        self._streams:    dict = {}   # {(sid, pane_id): threading.Thread}
        self._stop_flags: dict = {}   # {(sid, pane_id): threading.Event}
        self._lock = threading.Lock()
        self._session = requests.Session()
        self._session.verify = False
        self._session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
        })

    # ── Public API ──────────────────────────────────────────────────────────

    def get_symbols(self) -> list:
        return self.SYMBOLS

    def get_history(self, symbol: str, tf: str, limit: int = 20000) -> list:
        period, interval = self.TF_MAP.get(tf, ("60d", "1d"))
        # First attempt: Direct Yahoo Finance Chart API (fast, reliable, no crumb/rate limit issues)
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
            params = {
                "interval": interval,
                "range": period,
                "includePrePost": "false",
            }
            resp = self._session.get(url, params=params, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                result = data.get("chart", {}).get("result")
                if result and len(result) > 0:
                    timestamps = result[0].get("timestamp", [])
                    indicators = result[0].get("indicators", {})
                    quotes = indicators.get("quote", [{}])[0]
                    opens = quotes.get("open", [])
                    highs = quotes.get("high", [])
                    lows = quotes.get("low", [])
                    closes = quotes.get("close", [])
                    volumes = quotes.get("volume", [])

                    bars = []
                    for i in range(len(timestamps)):
                        if (i < len(opens) and opens[i] is not None and
                            i < len(highs) and highs[i] is not None and
                            i < len(lows) and lows[i] is not None and
                            i < len(closes) and closes[i] is not None):
                            v = volumes[i] if (i < len(volumes) and volumes[i] is not None) else 0
                            bars.append({
                                "time": int(timestamps[i]),
                                "open": round(float(opens[i]), 2),
                                "high": round(float(highs[i]), 2),
                                "low": round(float(lows[i]), 2),
                                "close": round(float(closes[i]), 2),
                                "volume": float(v),
                            })
                    if bars:
                        return bars[-limit:]
        except Exception as exc:
            log.warning("[YF] Direct chart API error for %s: %s, trying yfinance fallback", symbol, exc)

        # Fallback to yf.download
        try:
            df = yf.download(
                symbol, period=period, interval=interval,
                progress=False, auto_adjust=True,
            )
            if df is None or df.empty:
                return []
            bars = []
            for ts, row in df.iterrows():
                try:
                    bars.append({
                        "time":   int(ts.timestamp()),
                        "open":   round(float(row["Open"]), 2),
                        "high":   round(float(row["High"]), 2),
                        "low":    round(float(row["Low"]), 2),
                        "close":  round(float(row["Close"]), 2),
                        "volume": float(row["Volume"]),
                    })
                except Exception:
                    continue
            return bars[-limit:]
        except Exception as exc:
            log.error("[YF] History error for %s/%s: %s", symbol, tf, exc)
            return []

    def start_stream(self, sid: str, pane_id: int,
                     symbol: str, tf: str, callback) -> None:
        self.stop_stream(sid, pane_id)  # cancel any existing poll for this pane

        stop_event = threading.Event()
        key = (sid, pane_id)
        with self._lock:
            self._stop_flags[key] = stop_event

        _, interval = self.TF_MAP.get(tf, ("1d", "1d"))

        def poll():
            last_bar: dict = {}
            while not stop_event.is_set():
                try:
                    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
                    params = {"interval": interval, "range": "5d"}
                    resp = self._session.get(url, params=params, timeout=8)
                    if resp.status_code == 200:
                        data = resp.json()
                        result = data.get("chart", {}).get("result")
                        if result:
                            timestamps = result[0].get("timestamp", [])
                            quotes = result[0].get("indicators", {}).get("quote", [{}])[0]
                            if timestamps:
                                idx = len(timestamps) - 1
                                while idx >= 0 and (quotes.get("close", [None])[idx] is None or quotes.get("open", [None])[idx] is None):
                                    idx -= 1
                                if idx >= 0:
                                    bar = {
                                        "time": int(timestamps[idx]),
                                        "open": round(float(quotes["open"][idx]), 2),
                                        "high": round(float(quotes["high"][idx]), 2),
                                        "low": round(float(quotes["low"][idx]), 2),
                                        "close": round(float(quotes["close"][idx]), 2),
                                        "volume": float(quotes.get("volume", [0])[idx] or 0),
                                    }
                                    if bar != last_bar:
                                        callback(bar)
                                        last_bar = dict(bar)
                except Exception as exc:
                    log.warning("[YF] Poll error for %s: %s", symbol, exc)
                stop_event.wait(timeout=self.POLL_INTERVAL)

        t = threading.Thread(target=poll, daemon=True)
        with self._lock:
            self._streams[key] = t
        t.start()

    def stop_stream(self, sid: str, pane_id: int) -> None:
        key = (sid, pane_id)
        with self._lock:
            if key in self._stop_flags:
                self._stop_flags[key].set()
                del self._stop_flags[key]
            self._streams.pop(key, None)


# ─────────────────────────────────────────────────────────────────────────────
# Stub — shows how to plug in a new broker (e.g. Alpaca, Binance, Zerodha)
# ─────────────────────────────────────────────────────────────────────────────

class StubSource:
    """
    Template for adding a new broker.  Copy this class, rename it, fill in
    the three methods, then add it to DATA_SOURCES below.
    """

    def get_symbols(self) -> list:
        return ["STUB-A", "STUB-B"]

    def get_history(self, symbol: str, tf: str, limit: int = 300) -> list:
        # TODO: call broker REST API and return list of OHLCV dicts
        return []

    def start_stream(self, sid: str, pane_id: int,
                     symbol: str, tf: str, callback) -> None:
        # TODO: start a WebSocket / polling thread; call callback(bar) on each tick
        pass

    def stop_stream(self, sid: str, pane_id: int) -> None:
        # TODO: cancel the stream for this (sid, pane_id)
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Registry  — add any new source here
# ─────────────────────────────────────────────────────────────────────────────

DATA_SOURCES = {
    "hyperliquid": HyperliquidSource(),
    "yfinance":    YFinanceSource(),
    # "stub":      StubSource(),       # ← uncomment to expose the stub
    # "alpaca":    AlpacaSource(),     # ← add your own class and register here
    # "binance":   BinanceSource(),
    # "zerodha":   ZerodhaSource(),
}
