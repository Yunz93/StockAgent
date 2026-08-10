#!/usr/bin/env python3
"""ETF 池后端的离线单元测试：代码清洗、批量行情组装、工作区与配置归一化。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from stockagent import workspace_store  # noqa: E402
from stockagent.config_store import normalize_config  # noqa: E402


def _tencent_fields(price="1.168", change="0.69", name="红利低波ETF"):
    fields = [""] * 70
    fields[1] = name
    fields[3] = price
    fields[6] = "1000000"
    fields[30] = "20260722150000"
    fields[32] = change
    fields[36] = "2000000"
    return fields


class GetEtfQuotesTests(unittest.TestCase):
    def setUp(self):
        server.QUOTE_MARKET_CACHE.clear()

    def test_cleans_and_dedupes_symbols(self):
        with patch.object(server, "fetch_tencent_quotes") as mock_fetch:
            mock_fetch.return_value = {
                ("A", "512890"): _tencent_fields(),
                ("A", "510300"): _tencent_fields(price="4.765", change="-0.46", name="沪深300ETF"),
            }
            payload = server.get_etf_quotes(["512890", "sh512890", "510300", "abc", "1234567"])
        requested = mock_fetch.call_args[0][0]
        self.assertEqual([item[0] for item in requested], ["512890", "510300"])
        # 沪市 5 开头 → .SS
        self.assertEqual(requested[0][2], "512890.SS")
        quotes = {q["symbol"]: q for q in payload["quotes"]}
        self.assertEqual(quotes["512890"]["name"], "红利低波ETF")
        self.assertEqual(quotes["510300"]["price"], 4.765)

    def test_no_valid_symbols(self):
        payload = server.get_etf_quotes(["abc", ""])
        self.assertTrue(payload["error"])
        self.assertEqual(payload["quotes"], [])

    def test_shenzhen_symbol_maps_to_sz(self):
        with patch.object(server, "fetch_tencent_quotes") as mock_fetch:
            mock_fetch.return_value = {("A", "159915"): _tencent_fields(name="创业板ETF")}
            server.get_etf_quotes(["159915"])
        requested = mock_fetch.call_args[0][0]
        self.assertEqual(requested[0][2], "159915.SZ")

    def test_caches_for_same_symbol_set(self):
        with patch.object(server, "fetch_tencent_quotes") as mock_fetch:
            mock_fetch.return_value = {("A", "512890"): _tencent_fields()}
            server.get_etf_quotes(["512890"])
            server.get_etf_quotes(["512890"])
        self.assertEqual(mock_fetch.call_count, 1)


class WorkspaceNormalizationTests(unittest.TestCase):
    def test_normalizes_etf_entries(self):
        workspace = workspace_store.normalize_workspace(
            {
                "etfs": [
                    {"symbol": "512890", "name": "红利低波ETF", "shares": 1000, "cost": 1.1, "target_weight": 30},
                    {"symbol": "sh510300", "shares": -5, "cost": "abc", "target_weight": 120},
                    {"symbol": "512890", "name": "重复"},
                    {"symbol": "bad"},
                    "not-a-dict",
                ],
                "plan": {"name": "测试计划", "amount": 3000, "cadence": "weekly", "day": 9},
            }
        )
        self.assertEqual(len(workspace["etfs"]), 2)
        first, second = workspace["etfs"]
        self.assertEqual(first["symbol"], "512890")
        self.assertEqual(first["shares"], 1000)
        self.assertEqual(first["target_weight"], 30)
        self.assertEqual(second["symbol"], "510300")
        self.assertEqual(second["shares"], 0)
        self.assertEqual(second["cost"], 0)
        self.assertEqual(second["target_weight"], 100)
        self.assertEqual(workspace["version"], 9)
        self.assertEqual(workspace["plan"]["name"], "测试计划")
        self.assertEqual(workspace["plan"]["amount"], 3000)
        self.assertEqual(workspace["plan"]["cadence"], "weekly")
        self.assertEqual(workspace["plan"]["day"], 7)
        self.assertEqual(workspace["plan"]["strategy"], "valuation")
        self.assertEqual(len(workspace["plan"]["strategy_config"]["pe_bands"]), 5)
        self.assertEqual(workspace["plan"]["trading_cost"]["min_commission"], 5)

    def test_plan_strategy_presets_and_custom_config(self):
        workspace = workspace_store.normalize_workspace(
            {
                "plan": {
                    "strategy": "custom",
                    "strategy_config": {
                        "pe_bands": [
                            {"max_pct": 25, "mult": 2, "label": "低"},
                            {"max_pct": 90, "mult": 0.3, "label": "高"},
                        ],
                        "grade_mult": {"A": 2, "E": 0},
                        "use_rebalance": False,
                    },
                    "strategy_overrides": {
                        "512890": "fixed",
                        "sh510300": "grade",
                        "159937": "nope",
                        "bad": "valuation",
                    },
                }
            }
        )
        plan = workspace["plan"]
        self.assertEqual(plan["strategy"], "custom")
        self.assertEqual(plan["strategy_config"]["pe_bands"][0]["max_pct"], 25)
        self.assertEqual(plan["strategy_overrides"], {"512890": "fixed", "510300": "grade"})
        self.assertEqual(
            workspace_store.normalize_workspace({"plan": {}} )["plan"]["strategy_overrides"],
            {},
        )
        self.assertEqual(plan["strategy_config"]["pe_bands"][-1]["max_pct"], 100)
        self.assertEqual(plan["strategy_config"]["grade_mult"]["A"], 2.0)
        self.assertEqual(plan["strategy_config"]["grade_mult"]["C"], 1.0)
        self.assertFalse(plan["strategy_config"]["use_rebalance"])

        fixed = workspace_store.normalize_plan({"strategy": "fixed"})
        self.assertEqual(fixed["strategy"], "fixed")

    def test_plan_add_plan_defaults_and_normalize(self):
        legacy = workspace_store.normalize_plan({})
        self.assertEqual(
            legacy["add_plan"],
            {"enabled": True, "anchor": "price", "preset": "auto", "levels": None},
        )

        custom = workspace_store.normalize_plan(
            {
                "add_plan": {
                    "enabled": False,
                    "anchor": "cost",
                    "levels": [
                        {"drawdown_pct": 12, "ratio": 1},
                        {"drawdown_pct": 0.1, "ratio": 1},
                        {"drawdown_pct": 40, "ratio": 2},
                        {"drawdown_pct": 8, "ratio": 1},
                        {"drawdown_pct": 20, "ratio": 1},
                    ],
                }
            }
        )
        self.assertFalse(custom["add_plan"]["enabled"])
        self.assertEqual(custom["add_plan"]["anchor"], "cost")
        # 旧配置带 levels 时推断为 custom 预设
        self.assertEqual(custom["add_plan"]["preset"], "custom")
        self.assertEqual(len(custom["add_plan"]["levels"]), 4)
        self.assertEqual(
            [row["drawdown_pct"] for row in custom["add_plan"]["levels"]],
            [0.5, 8.0, 12.0, 30.0],
        )
        # 后端宽松存储：比例不归一
        self.assertEqual(custom["add_plan"]["levels"][0]["ratio"], 1.0)
        self.assertEqual(custom["add_plan"]["levels"][3]["ratio"], 2.0)

        bad_anchor = workspace_store.normalize_plan({"add_plan": {"anchor": "nope"}})
        self.assertEqual(bad_anchor["add_plan"]["anchor"], "price")
        camel = workspace_store.normalize_plan({"addPlan": {"enabled": 0, "anchor": "cost"}})
        self.assertFalse(camel["add_plan"]["enabled"])
        self.assertEqual(camel["add_plan"]["anchor"], "cost")

        empty_levels = workspace_store.normalize_plan(
            {"add_plan": {"levels": [{"drawdown_pct": 3, "ratio": 0}]}}
        )
        self.assertIsNone(empty_levels["add_plan"]["levels"])
        self.assertEqual(empty_levels["add_plan"]["preset"], "auto")

        # 预设持久化：非 custom 预设不携带 levels；未知预设回退 auto
        steady = workspace_store.normalize_plan(
            {"add_plan": {"preset": "steady", "levels": [{"drawdown_pct": 9, "ratio": 1}]}}
        )
        self.assertEqual(steady["add_plan"]["preset"], "steady")
        self.assertIsNone(steady["add_plan"]["levels"])
        bogus = workspace_store.normalize_plan({"add_plan": {"preset": "magic"}})
        self.assertEqual(bogus["add_plan"]["preset"], "auto")

    def test_plan_strategy_unknown_falls_back(self):
        fixed = workspace_store.normalize_plan({"strategy": "fixed"})
        self.assertEqual(fixed["strategy"], "fixed")
        bogus = workspace_store.normalize_plan({"strategy": "magic"})
        self.assertEqual(bogus["strategy"], "valuation")

    def test_buy_records_are_normalized_deduplicated_and_date_validated(self):
        workspace = workspace_store.normalize_workspace(
            {
                "etfs": [],
                "buys": [
                    {"id": "buy-1", "symbol": "sh510300", "date": "2026-07-28", "shares": 10, "price": 4.2},
                    {"id": "buy-1", "symbol": "510300", "date": "2026-07-28", "shares": 20, "price": 4.1},
                    {"symbol": "512890", "date": "2026-02-31", "shares": 10, "price": 1.2},
                ],
            }
        )
        self.assertEqual(workspace["version"], 9)
        self.assertEqual(len(workspace["buys"]), 1)
        self.assertEqual(workspace["buys"][0]["symbol"], "510300")
        self.assertTrue(workspace_store.workspace_has_user_data(workspace))

    def test_legacy_workspace_fills_default_targets(self):
        workspace = workspace_store.normalize_workspace(
            {
                "etfs": [
                    {"symbol": "512890", "name": "红利低波ETF", "shares": 100, "cost": 1.2},
                    {"symbol": "563360", "shares": 0, "cost": 0},
                    {"symbol": "510300", "shares": 0, "cost": 0},
                ]
            }
        )
        by_symbol = {item["symbol"]: item for item in workspace["etfs"]}
        self.assertEqual(by_symbol["512890"]["target_weight"], 35)
        self.assertEqual(by_symbol["563360"]["target_weight"], 20)
        self.assertEqual(by_symbol["510300"]["target_weight"], 0)
        self.assertEqual(workspace["plan"]["cadence"], "monthly")

    def test_normalizes_buy_records(self):
        workspace = workspace_store.normalize_workspace(
            {
                "etfs": [{"symbol": "512890", "target_weight": 100}],
                "buys": [
                    {"symbol": "512890", "date": "2026-01-15", "price": 1.2, "shares": 1000, "note": "首笔"},
                    {"symbol": "bad", "date": "2026-01-15", "price": 1, "shares": 1},
                    {"symbol": "512890", "date": "bad-date", "price": 1, "shares": 1},
                    {"symbol": "512890", "date": "2026-02-01", "price": 0, "shares": 500},
                    {"id": "keep", "symbol": "sh510300", "date": "2025-12-01", "price": 4.5, "shares": 200},
                ],
            }
        )
        self.assertEqual(len(workspace["buys"]), 2)
        self.assertEqual(workspace["buys"][0]["date"], "2026-01-15")
        self.assertEqual(workspace["buys"][0]["symbol"], "512890")
        self.assertEqual(workspace["buys"][0]["shares"], 1000)
        self.assertEqual(workspace["buys"][1]["id"], "keep")
        self.assertEqual(workspace["buys"][1]["symbol"], "510300")
        self.assertEqual(workspace["version"], 9)

    def test_plan_normalizes_initial_build_and_trading_cost(self):
        plan = workspace_store.normalize_plan(
            {
                "amount": 5000,
                "capital_base": 100000,
                "initial_target_pct": 30,
                "initial_months": 6,
                "trading_cost": {
                    "min_commission": 5,
                    "commission_rate_pct": 0.025,
                    "max_fee_ratio_pct": 0.2,
                    "lot_size": 100,
                },
                "pending_orders": {
                    "512890": {
                        "period": "2026-07-01",
                        "carry": 800,
                        "scheduled": 1200,
                        "remaining": 2000,
                    }
                },
            }
        )
        self.assertEqual(plan["capital_base"], 100000)
        self.assertEqual(plan["initial_target_pct"], 30)
        self.assertEqual(plan["initial_months"], 6)
        self.assertEqual(plan["trading_cost"]["commission_rate_pct"], 0.025)
        self.assertEqual(plan["pending_orders"]["512890"]["remaining"], 2000)

    def test_plan_initial_months_defaults_and_clamps(self):
        self.assertEqual(workspace_store.normalize_plan({})["initial_months"], 1)
        self.assertEqual(
            workspace_store.normalize_plan({"initial_months": 0})["initial_months"], 1
        )
        self.assertEqual(
            workspace_store.normalize_plan({"initial_months": 99})["initial_months"], 36
        )

    def test_save_workspace_preserves_client_iso_updated_at(self):
        stamp = "2026-07-31T01:02:03.456Z"
        payload = {
            "etfs": [{"symbol": "510300", "name": "沪深300", "shares": 0, "cost": 0, "target_weight": 10}],
            "plan": {
                "amount": 8888,
                "capital_base": 250000,
                "initial_target_pct": 40,
                "name": "重启校验",
            },
            "updated_at": stamp,
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "workspace.json"
            with patch.object(workspace_store, "WORKSPACE_PATH", path):
                saved = workspace_store.save_workspace(payload)
                self.assertEqual(saved["updated_at"], stamp)
                self.assertEqual(saved["plan"]["capital_base"], 250000)
                self.assertEqual(saved["plan"]["amount"], 8888)
                self.assertEqual(saved["plan"]["initial_target_pct"], 40)
                loaded = workspace_store.get_workspace()
                self.assertEqual(loaded["plan"]["capital_base"], 250000)
                self.assertEqual(loaded["plan"]["name"], "重启校验")
                self.assertEqual(loaded["updated_at"], stamp)

    def test_trade_fee_is_preserved(self):
        workspace = workspace_store.normalize_workspace(
            {
                "buys": [
                    {
                        "symbol": "510300",
                        "date": "2026-07-28",
                        "shares": 100,
                        "price": 4.2,
                        "fee": 5,
                    }
                ]
            }
        )
        self.assertEqual(workspace["buys"][0]["fee"], 5)

    def test_sell_records_are_normalized_without_affecting_buys(self):
        workspace = workspace_store.normalize_workspace(
            {
                "buys": [{"id": "buy-1", "symbol": "510300", "date": "2026-07-01", "shares": 100, "price": 4.1}],
                "sells": [{"id": "sell-1", "symbol": "510300", "date": "2026-07-20", "shares": 50, "price": 4.3}],
            }
        )
        self.assertEqual(len(workspace["buys"]), 1)
        self.assertEqual(len(workspace["sells"]), 1)
        self.assertEqual(workspace["sells"][0]["id"], "sell-1")

    def test_invalid_payload_returns_empty(self):
        workspace = workspace_store.normalize_workspace(None)
        self.assertEqual(workspace["etfs"], [])
        self.assertEqual(workspace["buys"], [])
        self.assertEqual(workspace["sells"], [])
        self.assertEqual(workspace["execution_drafts"], [])
        self.assertEqual(workspace["plan"]["name"], "默认定投计划")
        self.assertFalse(workspace_store.workspace_has_user_data(workspace))

    def test_execution_drafts_are_normalized(self):
        workspace = workspace_store.normalize_workspace(
            {
                "execution_drafts": [
                    {
                        "period": "2026-07-01",
                        "symbol": "sh512890",
                        "suggested_amount": 1200,
                        "price": 1.2,
                        "shares": 1000,
                        "fee": 5,
                        "status": "pending",
                    },
                    {"period": "bad", "symbol": "512890"},
                    {
                        "id": "draft_x",
                        "period": "2026-07-01",
                        "symbol": "510300",
                        "suggested_amount": 800,
                        "price": 4,
                        "shares": 200,
                        "status": "skipped",
                        "skip_reason": "已下单",
                    },
                ]
            }
        )
        self.assertEqual(len(workspace["execution_drafts"]), 2)
        first = next(item for item in workspace["execution_drafts"] if item["symbol"] == "512890")
        self.assertEqual(first["id"], "draft_2026-07-01_512890")
        self.assertEqual(first["status"], "pending")
        self.assertEqual(first["side"], "buy")  # 缺省兼容旧数据
        skipped = next(item for item in workspace["execution_drafts"] if item["symbol"] == "510300")
        self.assertEqual(skipped["skip_reason"], "已下单")
        self.assertEqual(workspace["version"], 9)

    def test_cash_reserve_migrates_and_normalizes(self):
        empty = workspace_store.normalize_workspace({"plan": {}})
        self.assertEqual(empty["plan"]["cash_reserve"], {"balance": 0, "history": []})
        self.assertEqual(empty["version"], 9)
        workspace = workspace_store.normalize_workspace(
            {
                "plan": {
                    "cash_reserve": {
                        "balance": 800,
                        "history": [
                            {"period": "2026-05-01", "amount": 200, "type": "keep"},
                            {"period": "2026-05-01", "amount": -1, "type": "keep"},
                            {"period": "x", "amount": 1, "type": "sell"},
                        ],
                    }
                }
            }
        )
        reserve = workspace["plan"]["cash_reserve"]
        self.assertEqual(reserve["balance"], 800)
        self.assertEqual(len(reserve["history"]), 1)
        self.assertEqual(reserve["history"][0]["type"], "keep")

    def test_execution_drafts_preserve_sell_side(self):
        workspace = workspace_store.normalize_workspace(
            {
                "execution_drafts": [
                    {
                        "id": "draft_2026-01-01_512890_sell",
                        "period": "2026-01-01",
                        "symbol": "512890",
                        "side": "sell",
                        "suggested_amount": 800,
                        "price": 1.2,
                        "shares": 600,
                        "fee": 5,
                        "status": "pending",
                        "note": "年度再平衡",
                    }
                ]
            }
        )
        self.assertEqual(len(workspace["execution_drafts"]), 1)
        draft = workspace["execution_drafts"][0]
        self.assertEqual(draft["side"], "sell")
        self.assertEqual(draft["note"], "年度再平衡")


class ConfigNormalizationTests(unittest.TestCase):
    def test_etf_pool_cleaned(self):
        config = normalize_config(
            {
                "etf": {
                    "pool": [
                        {"symbol": "512890", "name": "红利低波ETF"},
                        {"symbol": "sz159915", "name": "创业板ETF"},
                        {"symbol": "nope"},
                    ]
                }
            }
        )
        symbols = [item["symbol"] for item in config["etf"]["pool"]]
        self.assertEqual(symbols, ["512890", "159915"])

    def test_dividend_block_merges(self):
        config = normalize_config({"dividend": {"index_code": "000922", "danjuan_code": "SH000922"}})
        self.assertEqual(config["dividend"]["index_code"], "000922")
        # 未覆盖字段保留默认
        self.assertEqual(config["dividend"]["etf_symbol"], "512890")

    def test_quote_auto_refresh_is_normalized(self):
        config = normalize_config(
            {"quotes": {"auto_refresh_enabled": False, "refresh_interval_seconds": 60}}
        )
        self.assertFalse(config["quotes"]["auto_refresh_enabled"])
        self.assertEqual(config["quotes"]["refresh_interval_seconds"], 60)

        fallback = normalize_config(
            {"quotes": {"auto_refresh_enabled": True, "refresh_interval_seconds": 5}}
        )
        self.assertTrue(fallback["quotes"]["auto_refresh_enabled"])
        self.assertEqual(fallback["quotes"]["refresh_interval_seconds"], 300)

    def test_etf_product_quality_fields_keep_only_non_negative_numbers(self):
        config = normalize_config(
            {
                "etf": {
                    "products": {
                        "512890": {
                            "fund_size_yi": 82.5,
                            "annual_fee_pct": "0.6",
                            "tracking_error_pct": -1,
                            "unknown": 99,
                        }
                    }
                }
            }
        )
        self.assertEqual(
            config["etf"]["products"]["512890"],
            {"fund_size_yi": 82.5, "annual_fee_pct": 0.6},
        )

    def test_custom_analysis_keeps_optional_history_fields_without_valuation(self):
        config = normalize_config(
            {
                "etf": {
                    "analysis": {
                        "513500": {
                            "index_code": "SPX",
                            "index_name": "标普500",
                            "danjuan_code": "",
                            "history_source": "tencent",
                            "history_symbol": "us.INX",
                        }
                    }
                }
            }
        )
        analysis = config["etf"]["analysis"]["513500"]
        self.assertEqual(analysis["index_code"], "SPX")
        self.assertNotIn("danjuan_code", analysis)
        self.assertEqual(analysis["history_source"], "tencent")
        self.assertEqual(analysis["history_symbol"], "us.INX")

    def test_ai_supported_and_unrelated_legacy_blocks_dropped(self):
        config = normalize_config({"ai": {"provider": "deepseek"}, "sec": {"enabled": True}, "catalog": {}})
        self.assertEqual(config["ai"]["provider"], "deepseek")
        self.assertFalse(config["ai"]["enabled"])
        self.assertNotIn("sec", config)
        self.assertNotIn("catalog", config)


if __name__ == "__main__":
    unittest.main()
