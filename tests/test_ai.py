import copy
import json
import unittest
from unittest.mock import patch

from stockagent.ai_providers import AIProviderError, _decode_json_text, _openai_request
from stockagent.ai_service import (
    CONNECTION_PING_PROMPT,
    SYSTEM_PROMPT,
    _analysis_snapshot,
    _cache_key,
    _data_quality,
    _portfolio_snapshot,
    _position_snapshot,
    _strip_volatile_quote_fields,
    _validate_proposal,
    ai_status,
    apply_policy,
    humanize_ai_text,
    record_ai_usage,
    review_recommendation,
    test_connection as run_connection_test,
)
from stockagent.config_store import normalize_config, public_config
from stockagent.defaults import DEFAULT_CONFIG
from stockagent.state import AI_REVIEW_CACHE, AI_USAGE_SESSION, QUOTE_MARKET_CACHE


class AIConfigTests(unittest.TestCase):
    def test_ai_config_is_normalized_and_capped(self):
        config = normalize_config(
            {
                "ai": {
                    "enabled": True,
                    "provider": "openai",
                    "models": {"openai": "gpt-custom"},
                    "timeout_seconds": 999,
                    "max_output_tokens": 10,
                    "max_increase_multiplier": 4,
                }
            }
        )
        self.assertTrue(config["ai"]["enabled"])
        self.assertEqual(config["ai"]["provider"], "openai")
        self.assertEqual(config["ai"]["models"]["openai"], "gpt-custom")
        self.assertEqual(config["ai"]["timeout_seconds"], 120)
        self.assertEqual(config["ai"]["max_output_tokens"], 400)
        self.assertEqual(config["ai"]["max_increase_multiplier"], 1.5)

    @patch(
        "stockagent.secret_store.credential_status",
        return_value={"configured": True, "source": "keychain"},
    )
    def test_public_config_exposes_status_but_never_key(self, _status):
        payload = public_config(copy.deepcopy(DEFAULT_CONFIG))
        encoded = json.dumps(payload)
        self.assertTrue(payload["ai"]["credentials"]["deepseek"]["configured"])
        self.assertNotIn("api_key", encoded.lower())


class AIProviderTests(unittest.TestCase):
    def test_json_output_accepts_fenced_payload(self):
        self.assertEqual(_decode_json_text('```json\n{"action":"keep"}\n```')["action"], "keep")

    def test_invalid_json_is_rejected(self):
        with self.assertRaises(AIProviderError) as caught:
            _decode_json_text("not-json")
        self.assertEqual(caught.exception.code, "invalid_output")

    @patch("stockagent.ai_providers.http_post_json")
    def test_openai_schema_requests_dynamic_analysis_sections(self, post):
        post.return_value = {
            "output_text": json.dumps(
                {
                    "action": "keep",
                    "amount_multiplier": 1,
                    "confidence": "medium",
                    "summary": "维持规则建议。",
                    "focus_title": "仓位是当前首要约束",
                    "analysis_sections": [
                        {
                            "title": "仓位先于估值",
                            "items": ["当前仓位高于目标。"],
                        }
                    ],
                    "watch_items": [],
                    "evidence": [],
                    "conditions_to_reverse": [],
                    "data_limitations": [],
                }
            )
        }
        _openai_request("key", "model", "prompt", {}, 30, 800)
        schema = post.call_args.args[1]["text"]["format"]["schema"]
        self.assertIn("analysis_sections", schema["required"])
        self.assertIn("focus_title", schema["required"])
        self.assertNotIn("supporting_factors", schema["required"])

    @patch("stockagent.ai_service.get_api_key", return_value="test-secret-key")
    @patch(
        "stockagent.ai_service.request_review",
        return_value=(
            {
                "confidence": "low",
                "reasons": ["测试数据为空"],
                "review_opinion": "连接正常",
            },
            {"total_tokens": 20},
        ),
    )
    @patch(
        "stockagent.ai_service.ai_settings",
        return_value={
            "provider": "deepseek",
            "models": {"deepseek": "deepseek-v4-flash"},
            "timeout_seconds": 60,
        },
    )
    def test_connection_accepts_valid_json_without_investment_fields(
        self, _settings, request_review, _key
    ):
        result = run_connection_test("deepseek")
        self.assertTrue(result["ok"])
        args = request_review.call_args.args
        self.assertEqual(args[3], CONNECTION_PING_PROMPT)
        self.assertEqual(args[6], 200)
        self.assertNotEqual(args[3], SYSTEM_PROMPT)


class AIPolicyTests(unittest.TestCase):
    def setUp(self):
        AI_REVIEW_CACHE.clear()

    def test_low_confidence_cannot_change_baseline(self):
        policy = apply_policy(
            {"remaining_amount": 1000},
            {
                "action": "increase",
                "amount_multiplier": 1.5,
                "confidence": "low",
            },
            {"may_increase": True},
            {"plan_budget": 2000, "blocked": False, "would_exceed": False},
            {"max_increase_multiplier": 1.5},
        )
        self.assertEqual(policy["accepted_multiplier"], 1)
        self.assertEqual(policy["final_amount"], 1000)

    def test_stale_data_cannot_increase_amount(self):
        policy = apply_policy(
            {"remaining_amount": 1000},
            {
                "action": "increase",
                "amount_multiplier": 1.5,
                "confidence": "high",
            },
            {"may_increase": False},
            {"plan_budget": 2000, "blocked": False, "would_exceed": False},
            {"max_increase_multiplier": 1.5},
        )
        self.assertEqual(policy["accepted_multiplier"], 1)

    def test_commodity_valuation_na_is_not_critical_degradation(self):
        quality = _data_quality(
            {
                "asset_class": "commodity",
                "score": {"framework": "technical"},
                "not_applicable": {
                    "valuation": "黄金/商品类 ETF 没有 PE、股息率等股票估值口径"
                },
                "errors": {"fund_profile": "费率暂不可用"},
                "etf": {"market": "A", "market_timestamp": None},
            }
        )
        self.assertEqual(quality["valuation_framework"], "technical")
        self.assertIn("valuation", quality["not_applicable_fields"])
        self.assertNotIn("valuation", quality["critical_degraded_fields"])
        self.assertNotIn("valuation", quality["degraded_fields"])
        self.assertEqual(quality["degraded_fields"], ["fund_profile"])
        self.assertIn("not_applicable_fields", SYSTEM_PROMPT)
        self.assertIn("commodity/bond", SYSTEM_PROMPT)
        self.assertIn("框架不适用", SYSTEM_PROMPT)

    def test_unknown_evidence_path_is_removed_and_confidence_is_lowered(self):
        proposal = {
            "action": "keep",
            "amount_multiplier": 1,
            "confidence": "high",
            "summary": "维持",
            "evidence": ["analysis.nonexistent"],
        }
        result = _validate_proposal(proposal, {"analysis.valuation.pe"})
        self.assertEqual(result["evidence"], [])
        self.assertEqual(result["confidence"], "low")
        self.assertIn("不可验证字段", result["data_limitations"][0])

    def test_valid_evidence_survives_when_unknown_path_is_removed(self):
        proposal = {
            "action": "increase",
            "amount_multiplier": 1.5,
            "confidence": "high",
            "summary": "估值较低",
            "evidence": [
                "analysis.valuation.pe",
                "analysis.valuation.nonexistent",
            ],
        }
        result = _validate_proposal(proposal, {"analysis.valuation.pe"})
        self.assertEqual(result["evidence"], ["analysis.valuation.pe"])
        self.assertEqual(result["confidence"], "low")

    def test_non_keep_action_requires_two_valid_evidence(self):
        result = _validate_proposal(
            {
                "action": "reduce",
                "amount_multiplier": 0.7,
                "confidence": "high",
                "summary": "减仓",
                "evidence": ["position.actual_weight"],
                "data_limitations": [],
            },
            {"position.actual_weight", "analysis.valuation.pe"},
        )
        self.assertEqual(result["confidence"], "low")
        self.assertIn("证据不足", result["data_limitations"][0])

        ok = _validate_proposal(
            {
                "action": "reduce",
                "amount_multiplier": 0.7,
                "confidence": "high",
                "summary": "减仓",
                "evidence": ["position.actual_weight", "analysis.valuation.pe"],
            },
            {"position.actual_weight", "analysis.valuation.pe"},
        )
        self.assertEqual(ok["confidence"], "high")

    def test_dynamic_analysis_sections_keep_etf_specific_titles(self):
        result = _validate_proposal(
            {
                "action": "keep",
                "amount_multiplier": 1,
                "confidence": "high",
                "summary": "仓位约束比估值更影响本期决策。",
                "focus_title": "高仓位压过估值优势",
                "analysis_sections": [
                    {
                        "title": "52% 仓位成为首要约束",
                        "items": ["当前仓位 52%，高于 30% 目标。"],
                    },
                    {
                        "title": "年线附近但不宜继续集中",
                        "items": ["年线乖离 -0.45%，趋势风险有限。"],
                    },
                    {"title": "", "items": ["无标题内容应忽略"]},
                ],
                "evidence": ["position.actual_weight"],
            },
            {"position.actual_weight"},
        )
        self.assertEqual(result["focus_title"], "高仓位压过估值优势")
        self.assertEqual(
            [section["title"] for section in result["analysis_sections"]],
            ["52% 仓位成为首要约束", "年线附近但不宜继续集中"],
        )

    def test_humanize_ai_text_replaces_field_paths(self):
        text = (
            "position.actual_weight为52.3%，baseline.stance为skip；"
            "valuation.pe_percentile_10y为0.69，关注ma250=5675。"
        )
        readable = humanize_ai_text(text)
        self.assertNotIn("position.actual_weight", readable)
        self.assertNotIn("baseline.stance", readable)
        self.assertNotIn("valuation.pe_percentile_10y", readable)
        self.assertNotIn("ma250=", readable)
        self.assertIn("当前仓位", readable)
        self.assertIn("规则建议", readable)
        self.assertIn("PE 近十年分位", readable)
        self.assertIn("年线（MA250）", readable)

    def test_validate_proposal_humanizes_user_facing_fields_but_keeps_evidence_paths(self):
        result = _validate_proposal(
            {
                "action": "keep",
                "amount_multiplier": 1,
                "confidence": "medium",
                "summary": "position.actual_weight超标且data_quality.critical_degraded_fields含估值。",
                "focus_title": "baseline.stance为skip",
                "analysis_sections": [
                    {
                        "title": "仓位约束",
                        "items": ["position.actual_weight为52%，高于目标。"],
                    }
                ],
                "watch_items": ["观察pe_percentile_10y是否回落，指数能否站上ma250"],
                "evidence": ["position.actual_weight", "valuation.pe_percentile_10y"],
                "conditions_to_reverse": [],
                "data_limitations": ["data_quality.critical_degraded_fields含估值"],
            },
            {"position.actual_weight", "valuation.pe_percentile_10y"},
        )
        self.assertNotIn("position.actual_weight", result["summary"])
        self.assertIn("当前仓位", result["summary"])
        self.assertIn("关键降级字段", result["summary"])
        self.assertIn("规则建议", result["focus_title"])
        self.assertIn("当前仓位", result["analysis_sections"][0]["items"][0])
        self.assertIn("PE 近十年分位", result["watch_items"][0])
        self.assertIn("年线（MA250）", result["watch_items"][0])
        self.assertEqual(
            result["evidence"],
            ["position.actual_weight", "valuation.pe_percentile_10y"],
        )
        self.assertIn("字段路径", SYSTEM_PROMPT)
        self.assertIn("禁止在上述展示字段中写 JSON 字段路径", SYSTEM_PROMPT)

    def test_analysis_snapshot_includes_etf_identity_and_distinguishing_metrics(self):
        snapshot = _analysis_snapshot(
            {
                "symbol": "563360",
                "index_name": "中证A500",
                "index_full_name": "中证A500",
                "etf_name": "A500ETF华泰柏瑞",
                "etf": {
                    "symbol_name": "A500ETF华泰柏瑞",
                    "product_quality": {"tracking_error_pct": 2.46},
                },
                "technicals": {
                    "kdj": {"k": 37, "d": 38, "j": 34},
                    "kdj_label": "中性区间",
                },
            }
        )
        self.assertEqual(snapshot["index_name"], "中证A500")
        self.assertEqual(snapshot["etf"]["product_quality"]["tracking_error_pct"], 2.46)
        self.assertEqual(snapshot["technicals"]["kdj"]["k"], 37)

    def test_position_breach_cannot_increase_amount(self):
        policy = apply_policy(
            {"remaining_amount": 1000},
            {
                "action": "increase",
                "amount_multiplier": 1.5,
                "confidence": "high",
            },
            {"may_increase": True},
            {"plan_budget": 2000, "blocked": True, "would_exceed": True},
            {"max_increase_multiplier": 1.5},
        )
        self.assertEqual(policy["accepted_multiplier"], 1)

    def test_initial_build_uses_execution_budget_instead_of_monthly_budget(self):
        policy = apply_policy(
            {"remaining_amount": 18000},
            {
                "action": "keep",
                "amount_multiplier": 1,
                "confidence": "high",
            },
            {"may_increase": True},
            {
                "plan_budget": 5000,
                "execution_budget": 20000,
                "blocked": False,
                "would_exceed": False,
            },
            {"max_increase_multiplier": 1.5},
        )
        self.assertEqual(policy["final_amount"], 18000)

    def test_position_snapshot_recurring_cap_ignores_pending_carry(self):
        snapshot = _position_snapshot(
            {"execution_phase": "recurring"},
            {
                "plan": {
                    "amount": 2000,
                    "pending_orders": {
                        "512890": {
                            "period": "2026-06-01",
                            "carry": 800,
                            "scheduled": 2000,
                            "remaining": 800,
                        }
                    },
                },
                "etfs": [{"symbol": "512890", "shares": 1000, "cost": 1}],
            },
            "512890",
        )
        self.assertEqual(snapshot["plan_budget"], 2000)
        self.assertEqual(snapshot["execution_budget"], 2000)

    def test_position_snapshot_uses_remaining_initial_gap(self):
        snapshot = _position_snapshot(
            {"execution_phase": "initial"},
            {
                "plan": {
                    "amount": 5000,
                    "capital_base": 100000,
                    "initial_target_pct": 30,
                    "initial_months": 1,
                },
                "etfs": [{"symbol": "512890", "shares": 10000, "cost": 1}],
            },
            "512890",
        )
        self.assertEqual(snapshot["execution_budget"], 20000)
        self.assertEqual(snapshot["plan_budget"], 5000)

    def test_position_snapshot_prefers_cached_market_price(self):
        QUOTE_MARKET_CACHE.clear()
        QUOTE_MARKET_CACHE["512890"] = {
            "expires": 1e18,
            "payload": {"quotes": [{"symbol": "512890", "price": 2.0}]},
        }
        try:
            snapshot = _position_snapshot(
                {"execution_phase": "initial"},
                {
                    "plan": {
                        "amount": 5000,
                        "capital_base": 100000,
                        "initial_target_pct": 30,
                        "initial_months": 1,
                    },
                    # cost=1 但缓存价=2 → 市值按 2 计，缺口更小
                    "etfs": [{"symbol": "512890", "shares": 10000, "cost": 1}],
                },
                "512890",
            )
            # target 30000 - mark 20000 = 10000
            self.assertEqual(snapshot["execution_budget"], 10000)
        finally:
            QUOTE_MARKET_CACHE.clear()

    def test_position_snapshot_spreads_initial_build_across_months(self):
        snapshot = _position_snapshot(
            {"execution_phase": "initial"},
            {
                "plan": {
                    "amount": 5000,
                    "capital_base": 100000,
                    "initial_target_pct": 30,
                    "initial_months": 6,
                    "cadence": "monthly",
                },
                "etfs": [{"symbol": "512890", "shares": 10000, "cost": 1}],
            },
            "512890",
        )
        # 尚缺 20000 ÷ 剩余 6 个月
        self.assertAlmostEqual(snapshot["execution_budget"], 20000 / 6, places=2)

    def test_reduce_action_cannot_raise_amount(self):
        policy = apply_policy(
            {"remaining_amount": 1000},
            {
                "action": "reduce",
                "amount_multiplier": 1.4,
                "confidence": "high",
            },
            {"may_increase": True},
            {"plan_budget": 2000, "blocked": False, "would_exceed": False},
            {"max_increase_multiplier": 1.5},
        )
        self.assertEqual(policy["accepted_multiplier"], 1)

    @patch("stockagent.ai_service.get_api_key", return_value="test-secret-key")
    @patch("stockagent.ai_service.get_workspace")
    @patch("stockagent.ai_service.get_dividend_dashboard")
    @patch("stockagent.ai_service.request_review")
    @patch("stockagent.ai_service.ai_settings")
    def test_review_uses_model_proposal_and_local_policy(
        self,
        settings,
        provider,
        dashboard,
        workspace,
        _key,
    ):
        settings.return_value = {
            "enabled": True,
            "provider": "deepseek",
            "models": {"deepseek": "deepseek-v4-flash"},
            "timeout_seconds": 60,
            "max_output_tokens": 1800,
            "cache_minutes": 30,
            "max_increase_multiplier": 1.5,
        }
        workspace.return_value = {
            "plan": {"amount": 2000, "strategy": "valuation"},
            "etfs": [{"symbol": "512890", "shares": 1000, "cost": 1, "target_weight": 20}],
        }
        dashboard.return_value = {
            "supported": True,
            "symbol": "512890",
            "updated_at": "2026-07-29T10:00:00+08:00",
            "analysis_mode": "index",
            "etf": {
                "symbol": "512890",
                "price": 1.2,
                "market": "A",
                "market_timestamp": 1,
            },
            "index": {"date": "2026-07-29", "close": 5000},
            "valuation": {"pe": 10, "pe_percentile_10y": 0.2},
            "score": {"total": 80, "grade": "A", "components": []},
        }
        provider.return_value = (
            {
                "action": "reduce",
                "amount_multiplier": 0.7,
                "confidence": "high",
                "summary": "仓位接近上限，降低本期投入。",
                "focus_title": "仓位约束压过低估值",
                "analysis_sections": [
                    {
                        "title": "仓位先于估值",
                        "items": ["当前仓位 25%，高于 20% 目标。"],
                    },
                    {
                        "title": "低估值仍可保留观察",
                        "items": ["PE 10，近十年分位 20%。"],
                    },
                ],
                "watch_items": ["观察仓位回落"],
                "evidence": ["position.actual_weight", "analysis.valuation.pe"],
                "conditions_to_reverse": ["仓位回到目标附近"],
                "data_limitations": [],
            },
            {"prompt_tokens": 80, "completion_tokens": 20, "total_tokens": 100},
        )
        AI_USAGE_SESSION.update({"requests": 0, "prompt_tokens": 0, "completion_tokens": 0})
        result = review_recommendation(
            {
                "symbol": "512890",
                "baseline": {
                    "stance": "invest",
                    "amount": 1000,
                    "remaining_amount": 1000,
                },
                "position": {
                    "actual_weight": 25,
                    "target_weight": 20,
                    "blocked": False,
                    "would_exceed": False,
                },
            }
        )
        self.assertEqual(result["policy_decision"]["accepted_multiplier"], 0.7)
        self.assertEqual(result["final_recommendation"]["amount"], 700)
        self.assertEqual(result["ai_proposal"]["focus_title"], "仓位约束压过低估值")
        sent_payload = provider.call_args.args[4]
        self.assertEqual(sent_payload["output_version"], 4)
        self.assertIn("portfolio", sent_payload)
        self.assertEqual(sent_payload["portfolio"]["budget"], 2000)
        self.assertEqual(sent_payload["portfolio"]["weight_basis"], "cost")
        provider.assert_called_once()
        status = ai_status()
        self.assertEqual(status["usage_session"]["requests"], 1)
        self.assertEqual(status["usage_session"]["prompt_tokens"], 80)
        self.assertEqual(status["usage_session"]["completion_tokens"], 20)

    def test_cache_key_ignores_intraday_quote_fields(self):
        base = {
            "analysis": {
                "etf": {"symbol": "512890", "price": 1.2, "change_pct": 1.1, "volume": 9},
                "index": {"close": 5000, "change_pct": 0.5},
            },
            "baseline": {"amount": 1000},
        }
        moved = copy.deepcopy(base)
        moved["analysis"]["etf"]["price"] = 1.25
        moved["analysis"]["etf"]["change_pct"] = -0.3
        moved["analysis"]["index"]["change_pct"] = 1.2
        self.assertEqual(_cache_key("deepseek", "m", base), _cache_key("deepseek", "m", moved))
        stripped = _strip_volatile_quote_fields(base)
        self.assertNotIn("price", stripped["analysis"]["etf"])
        self.assertIn("price", base["analysis"]["etf"])  # 请求体仍完整

    def test_portfolio_snapshot_uses_cost_weights(self):
        portfolio = _portfolio_snapshot(
            {
                "plan": {"amount": 2000},
                "etfs": [
                    {"symbol": "512890", "name": "红利", "shares": 1000, "cost": 1, "target_weight": 40},
                    {"symbol": "510300", "name": "沪深300", "shares": 500, "cost": 4, "target_weight": 60},
                ],
            }
        )
        self.assertEqual(portfolio["budget"], 2000)
        by_symbol = {row["symbol"]: row for row in portfolio["positions"]}
        self.assertEqual(by_symbol["512890"]["actual_weight_pct"], 33.33)
        self.assertEqual(by_symbol["510300"]["actual_weight_pct"], 66.67)

    def test_usage_normalizes_openai_response_keys(self):
        AI_USAGE_SESSION.update({"requests": 0, "prompt_tokens": 0, "completion_tokens": 0})
        record_ai_usage({"input_tokens": 11, "output_tokens": 7})
        self.assertEqual(AI_USAGE_SESSION["prompt_tokens"], 11)
        self.assertEqual(AI_USAGE_SESSION["completion_tokens"], 7)


if __name__ == "__main__":
    unittest.main()
