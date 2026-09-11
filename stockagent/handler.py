#!/usr/bin/env python3
"""HTTP request handler and routes."""

import json
import mimetypes
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler

from .paths import RESOURCE_ROOT, resolve_static_path
from .config_store import public_config, save_config
from .workspace_store import get_workspace, save_workspace
from .dividend import analysis_support_map, get_dividend_dashboard
from .quotes import get_etf_quotes, get_price_history, get_single_quote
from .sentiment import get_market_sentiment
from .gold_macro import get_gold_macro
from .health import get_data_health, get_runtime_info
from .ai_providers import AIProviderError
from .ai_service import ai_status, review_portfolio, review_recommendation, test_connection
from .secret_store import delete_api_key, save_api_key
from .site_auth import (
    auth_enabled,
    cookie_ok,
    is_public_path,
    login_ok,
    login_page_html,
    request_is_https,
    session_cookie_header,
)

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/html", ".html")

class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authorize(parsed.path):
            return
        if parsed.path.startswith("/api/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            return
        target = resolve_static_path(parsed.path)
        if target is None:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/login":
            error = (query.get("error") or [""])[0].strip() or None
            self.send_html(login_page_html(error))
            return
        if not self._authorize(parsed.path):
            return
        try:
            if parsed.path == "/api/config":
                self.send_json(public_config())
                return
            if parsed.path == "/api/dividend/daily":
                refresh = query.get("refresh", ["0"])[0] in ("1", "true")
                symbol = query.get("symbol", [""])[0].strip()
                lite = query.get("lite", ["0"])[0] in ("1", "true")
                self.send_json(get_dividend_dashboard(refresh=refresh, symbol=symbol or None, lite=lite))
                return
            if parsed.path == "/api/etf/analysis-map":
                raw = query.get("symbols", [""])[0]
                symbols = [part.strip() for part in raw.replace("，", ",").split(",") if part.strip()] or None
                self.send_json({"items": analysis_support_map(symbols)})
                return
            if parsed.path == "/api/etf/quotes":
                raw = query.get("symbols", [""])[0]
                symbols = [part.strip() for part in raw.replace("，", ",").split(",") if part.strip()]
                self.send_json(get_etf_quotes(symbols))
                return
            if parsed.path == "/api/quote":
                symbol = query.get("symbol", [""])[0].strip()
                self.send_json(get_single_quote(symbol, "A"))
                return
            if parsed.path == "/api/history":
                symbol = query.get("symbol", [""])[0].strip().upper()
                range_key = query.get("range", ["1y"])[0].strip().lower() or "1y"
                self.send_json(get_price_history(symbol, "A", range_key))
                return
            if parsed.path == "/api/market/sentiment":
                markets = query.get("markets", ["A,HK,US"])[0]
                refresh = query.get("refresh", ["0"])[0] in ("1", "true")
                self.send_json(get_market_sentiment(markets=markets, refresh=refresh))
                return
            if parsed.path == "/api/market/gold-macro":
                refresh = query.get("refresh", ["0"])[0] in ("1", "true")
                self.send_json(get_gold_macro(refresh=refresh))
                return
            if parsed.path == "/api/workspace":
                self.send_json(get_workspace())
                return
            if parsed.path == "/api/health":
                self.send_json(get_data_health())
                return
            if parsed.path == "/api/ai/status":
                self.send_json(ai_status())
                return
            if parsed.path == "/api/ready":
                # Lightweight liveness for desktop launch — must not touch markets.
                index = resolve_static_path("/index.html")
                self.send_json(
                    {
                        "ready": True,
                        "app": "ETF Agent",
                        "mode": "desktop" if os.environ.get("STOCKAGENT_DESKTOP") == "1" else "server",
                        "frozen": bool(getattr(sys, "frozen", False)),
                        "index_html": bool(index),
                        "resource_root": str(RESOURCE_ROOT),
                    }
                )
                return
            if parsed.path == "/api/runtime":
                self.send_json(get_runtime_info())
                return
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)
            return
        if parsed.path.startswith("/api/"):
            self.send_json({"error": f"未知接口: {parsed.path}"}, status=404)
            return
        self.serve_static(parsed.path)

    def do_PUT(self):
        self._handle_write()

    def do_POST(self):
        self._handle_write()

    def _handle_write(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body.decode("utf-8") if body else "{}")
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"JSON 格式错误: {exc}"}, status=400)
            return

        if parsed.path == "/api/auth/login":
            if not auth_enabled():
                self.send_json({"ok": True, "auth": False})
                return
            if not login_ok(payload.get("password")):
                self.send_json({"error": "口令错误"}, status=401)
                return
            self.send_json(
                {"ok": True},
                set_cookie=session_cookie_header(secure=request_is_https(self)),
            )
            return
        if parsed.path == "/api/auth/logout":
            self.send_json(
                {"ok": True},
                set_cookie=session_cookie_header(secure=request_is_https(self), clear=True),
            )
            return

        if not self._authorize(parsed.path):
            return

        try:
            if parsed.path == "/api/config":
                self.send_json(public_config(save_config(payload)))
                return
            if parsed.path == "/api/workspace":
                self.send_json(save_workspace(payload))
                return
            if parsed.path == "/api/ai/credentials":
                provider = payload.get("provider")
                if payload.get("delete") is True:
                    status = delete_api_key(provider)
                else:
                    status = save_api_key(provider, payload.get("api_key"))
                self.send_json({"provider": provider, **status})
                return
            if parsed.path == "/api/ai/test":
                self.send_json(test_connection(payload.get("provider")))
                return
            if parsed.path == "/api/ai/review-recommendation":
                self.send_json(
                    review_recommendation(
                        payload,
                        force=payload.get("force") is True,
                    )
                )
                return
            if parsed.path == "/api/ai/review-portfolio":
                self.send_json(
                    review_portfolio(
                        payload,
                        force=payload.get("force") is True,
                    )
                )
                return
            if parsed.path == "/api/strategy/backtest":
                from .portfolio_backtest import run_backtest_from_workspace_symbols

                status, body = run_backtest_from_workspace_symbols(payload)
                self.send_json(body, status=status)
                return
            self.send_error(404)
        except AIProviderError as exc:
            self.send_json(
                {"error": str(exc), "code": exc.code},
                status=exc.status,
            )
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def _authorize(self, path: str) -> bool:
        """Return True if the request may proceed; otherwise write a denial response."""
        if not auth_enabled() or is_public_path(path) or cookie_ok(self.headers):
            return True
        if path.startswith("/api/"):
            self.send_json({"error": "未登录"}, status=401)
            return False
        # Browser navigations: show login form instead of a bare 401.
        self.send_html(login_page_html())
        return False

    def serve_static(self, path):
        target = resolve_static_path(path)
        if target is None:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, body: str, status=200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload, status=200, set_cookie=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))
