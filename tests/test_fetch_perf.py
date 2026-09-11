#!/usr/bin/env python3
"""Data-fetch performance: shared quote cache, lite dividend payload, history reuse."""

from __future__ import annotations

import time
import unittest
from unittest import mock

from stockagent import dividend_service, dividend_sources, quotes
from stockagent.state import HISTORY_CACHE, QUOTE_MARKET_CACHE


class QuoteCacheShareTests(unittest.TestCase):
    def setUp(self):
        QUOTE_MARKET_CACHE.clear()

    def tearDown(self):
        QUOTE_MARKET_CACHE.clear()

    def test_batch_quotes_seed_per_symbol_cache_for_single_lookup(self):
        fake = {
            "quotes": [
                {"symbol": "512890", "name": "红利低波", "price": 1.23},
                {"symbol": "510300", "name": "沪深300", "price": 4.56},
            ],
            "provider": "腾讯行情",
            "source_url": "https://gu.qq.com/",
        }
        with mock.patch.object(quotes, "fetch_quotes_for_stocks", return_value=fake) as fetch:
            first = quotes.get_etf_quotes(["512890", "510300"])
            self.assertEqual(first["returned"], 2)
            self.assertEqual(fetch.call_count, 1)

            second = quotes.get_etf_quotes(["512890"])
            self.assertEqual(second["returned"], 1)
            self.assertEqual(second["quotes"][0]["price"], 1.23)
            # 单只命中按标的缓存，不再打行情源
            self.assertEqual(fetch.call_count, 1)
            self.assertGreaterEqual(second.get("cache_hits", 0), 1)


class DividendLitePayloadTests(unittest.TestCase):
    def tearDown(self):
        dividend_service.DIVIDEND_CACHE.clear()

    def test_slim_payload_strips_heavy_fields(self):
        payload = {
            "supported": True,
            "score": {"grade": "B", "total": 70},
            "valuation": {"pe_percentile_10y": 0.4},
            "chart": {
                "name": "demo",
                "points": [{"date": f"2024-01-{(i % 28) + 1:02d}", "close": i} for i in range(90)],
                "markers": [{"date": "2024-01-01"}],
            },
            "sources": [{"name": "x"}],
            "commentary": "长文",
            "disclaimer": "风险",
            "note_text": "笔记",
            "backtest": {
                "samples": 10,
                "avg_return_pct": 1.2,
                "win_rate_pct": 60,
                "label": "一般",
                "extra": "drop-me",
            },
        }
        slim = dividend_service.slim_dividend_payload(payload)
        self.assertTrue(slim["lite"])
        self.assertNotIn("sources", slim)
        self.assertNotIn("commentary", slim)
        self.assertLessEqual(len(slim["chart"]["points"]), 60)
        self.assertEqual(slim["chart"]["markers"], [])
        self.assertEqual(slim["score"]["grade"], "B")
        self.assertNotIn("extra", slim.get("backtest") or {})

    def test_dashboard_cache_hit_respects_lite_flag(self):
        dividend_service.DIVIDEND_CACHE.clear()
        full = {
            "supported": True,
            "score": {"grade": "A"},
            "chart": {"points": [{"date": "2024-01-01", "close": 1}] * 80, "markers": [1]},
            "sources": [1],
            "commentary": "x",
        }
        dividend_service.DIVIDEND_CACHE["512890"] = {
            "payload": full,
            "expires": time.time() + 3600,
        }
        with mock.patch.object(
            dividend_service,
            "fetch_etf_quote",
            return_value={"symbol": "512890", "name": "红利低波", "price": 1.0},
        ):
            with mock.patch.object(
                dividend_service,
                "resolve_analysis_settings",
                return_value={"etf_symbol": "512890", "etf_name": "红利", "cache_seconds": 1800},
            ):
                lite = dividend_service.get_dividend_dashboard(symbol="512890", lite=True)
                normal = dividend_service.get_dividend_dashboard(symbol="512890", lite=False)
        self.assertTrue(lite.get("lite"))
        self.assertNotIn("sources", lite)
        self.assertIsNone(normal.get("lite"))
        self.assertIn("sources", normal)


class HistoryCacheReuseTests(unittest.TestCase):
    def setUp(self):
        HISTORY_CACHE.clear()

    def tearDown(self):
        HISTORY_CACHE.clear()

    def test_etf_as_index_history_reuses_price_history_cache(self):
        points = [
            {"date": f"2023-{min(12, 1 + i // 20):02d}-{1 + (i % 20):02d}", "close": 1.0 + i * 0.01}
            for i in range(120)
        ]
        HISTORY_CACHE["A:512890:5y"] = {
            "expires": time.time() + 300,
            "payload": {"points": points},
        }
        with mock.patch.object(
            dividend_sources,
            "fetch_tencent_index_history",
            side_effect=AssertionError("network"),
        ):
            rows, source = dividend_sources.fetch_etf_as_index_history("512890")
        self.assertEqual(source, "本地历史缓存")
        self.assertGreaterEqual(len(rows), 60)


if __name__ == "__main__":
    unittest.main()
