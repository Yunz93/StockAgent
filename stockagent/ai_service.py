#!/usr/bin/env python3
"""Build, validate, and safely arbitrate AI recommendation corrections."""

from __future__ import annotations

import copy
import datetime
import hashlib
import json
import time

from .ai_providers import AIProviderError, PORTFOLIO_REVIEW_SCHEMA, request_review
from .config_store import ai_settings
from .dividend import get_dividend_dashboard
from .market_time import market_freshness
from .secret_store import credential_status, get_api_key
from .state import AI_REVIEW_CACHE, AI_USAGE_SESSION, QUOTE_CACHE, QUOTE_MARKET_CACHE
from .workspace_store import get_workspace

SYSTEM_PROMPT = """你是 ETF Agent 的 ETF 分析器。只能使用输入 JSON 中的事实，
不得补充新闻、财报、行情或外部知识。你的任务是识别这只 ETF 当前最值得决策的矛盾，并分析规则建议中的明显盲点，而不是取代规则引擎。
数据不足时降低置信度并保持原建议。不要承诺收益，不要给出确定性买卖指令。
先根据 ETF 名称、跟踪指数、估值、趋势、交易质量、仓位和数据质量判断本只 ETF 的分析重点。
不同 ETF 不要套用相同段落：只选择 2 至 4 个真正相关的主题，主题标题必须描述本只 ETF 的具体矛盾，
不得使用“支持因素”“风险分析”“技术面分析”等通用标题。每个主题都要引用输入中的具体数值或状态并解释其决策影响，
不要只复述“估值较低、技术面中性、注意风险”等可替换到任何 ETF 的空泛句子。
商品/债券类 ETF（asset_class 为 commodity/bond，或 data_quality.valuation_framework 为 technical）
没有股票 PE/股息估值口径：not_applicable_fields 中的估值与股债利差属于框架不适用，
不得据此判定数据质量差、也不得据此削弱或否定规则补仓建议。
可结合 portfolio 指出组合层面矛盾（超配/低配对本期建议的影响）；portfolio.positions 的 actual_weight_pct 为成本口径占比。

文案规则（很重要）：
- summary、focus_title、analysis_sections、watch_items、conditions_to_reverse、data_limitations
  必须使用中文可读表述，例如「当前仓位」「PE 近十年分位」「年线（MA250）」「规则建议」。
- 禁止在上述展示字段中写 JSON 字段路径或变量名，例如 position.actual_weight、
  valuation.pe_percentile_10y、baseline.stance、data_quality.critical_degraded_fields、ma250。
- evidence 数组才写输入字段路径，例如 analysis.valuation.pe_percentile_10y、position.actual_weight。

只返回 JSON 对象，不要添加 Markdown。对象必须包含以下字段：
action: "keep" | "increase" | "reduce" | "pause"；
amount_multiplier: 数字；confidence: "low" | "medium" | "high"；summary、focus_title: 字符串；
analysis_sections: 由 2 至 4 个对象组成的数组，每个对象包含 title 和 items，items 为 1 至 3 条字符串；
watch_items、evidence、conditions_to_reverse、data_limitations: 字符串数组。
所有字段都必须出现；数组每项不超过 80 个汉字，最多 3 项，没有内容时返回空数组。"""

CONNECTION_PING_PROMPT = (
    '返回 JSON 最小合法对象：'
    '{"action":"keep","amount_multiplier":1,"confidence":"low","summary":"ok",'
    '"focus_title":"ping","analysis_sections":[{"title":"t","items":["i"]}],'
    '"watch_items":[],"evidence":[],"conditions_to_reverse":[],"data_limitations":[]}'
)

PORTFOLIO_SYSTEM_PROMPT = """你是 ETF Agent 的全池分配审视器。只能使用输入 JSON 中的事实，
不得补充新闻、财报、行情或外部知识。你的任务是审视规则引擎给出的本期全池分配，
识别组合层矛盾（集中度、同指数重复持仓、超配/低配与估值的冲突、现金池释放时机），
而不是取代规则引擎重新算一遍。
数据不足时降低置信度并保持规则分配。不要承诺收益，不要给出确定性买卖指令。

文案规则（很重要）：
- summary、focus_title、analysis_sections、watch_items、conditions_to_reverse、data_limitations、
  per_symbol_adjustments.reason 必须使用中文可读表述。
- 禁止在上述展示字段中写 JSON 字段路径或变量名。
- evidence 数组才写输入字段路径，例如 holdings.0.pe_percentile_10y、baseline.deploy_total。

只返回 JSON 对象，不要添加 Markdown。对象必须包含以下字段：
action: "keep" | "adjust"；
confidence: "low" | "medium" | "high"；summary、focus_title: 字符串；
analysis_sections: 由 2 至 4 个对象组成的数组，每个对象包含 title 和 items，items 为 1 至 3 条字符串；
per_symbol_adjustments: 对象数组（可空），每项含 symbol、multiplier、reason；
watch_items、evidence、conditions_to_reverse、data_limitations: 字符串数组。
所有字段都必须出现；数组每项不超过 80 个汉字，最多 3 项（per_symbol_adjustments 最多 8 项），没有内容时返回空数组。
action 为 keep 时 per_symbol_adjustments 应为空；仅在确有组合层修正时使用 adjust。"""

AI_ANALYSIS_VERSION = 4
ALLOWED_ACTIONS = {"keep", "increase", "reduce", "pause"}
ALLOWED_PORTFOLIO_ACTIONS = {"keep", "adjust"}
ALLOWED_CONFIDENCE = {"low", "medium", "high"}

# Longer keys first so nested paths replace before short suffixes.
FIELD_LABELS = (
    ("data_quality.critical_degraded_fields", "关键降级字段"),
    ("data_quality.not_applicable_fields", "不适用字段"),
    ("data_quality.valuation_framework", "估值框架"),
    ("data_quality.degraded_fields", "降级字段"),
    ("data_quality.may_increase", "是否允许加仓"),
    ("data_quality.freshness", "行情新鲜度"),
    ("analysis.valuation.pe_percentile_10y", "PE 近十年分位"),
    ("analysis.valuation.dividend_yield_pct", "股息率"),
    ("analysis.technicals.bias_pct", "年线乖离"),
    ("analysis.technicals.ma250", "年线（MA250）"),
    ("analysis.technicals.rsi14", "RSI"),
    ("analysis.technicals.rsi_label", "RSI 状态"),
    ("analysis.technicals.kdj_label", "KDJ 状态"),
    ("analysis.spread.percentile", "股债利差历史分位"),
    ("analysis.spread.value", "股债利差"),
    ("analysis.score.total", "综合评分"),
    ("analysis.score.grade", "评分档位"),
    ("valuation.pe_percentile_10y", "PE 近十年分位"),
    ("valuation.dividend_yield_pct", "股息率"),
    ("valuation.pe", "PE"),
    ("valuation.pb", "PB"),
    ("technicals.bias_pct", "年线乖离"),
    ("technicals.ma250", "年线（MA250）"),
    ("technicals.rsi14", "RSI"),
    ("technicals.rsi_label", "RSI 状态"),
    ("technicals.kdj_label", "KDJ 状态"),
    ("position.actual_weight", "当前仓位"),
    ("position.target_weight", "目标仓位"),
    ("position.projected_weight", "投入后仓位"),
    ("position.execution_budget", "本期可执行预算"),
    ("position.plan_budget", "每期预算"),
    ("baseline.remaining_amount", "规则剩余额度"),
    ("baseline.headline", "规则建议标题"),
    ("baseline.reason", "规则建议理由"),
    ("baseline.stance", "规则建议"),
    ("baseline.amount", "规则建议金额"),
    ("workspace.plan_budget", "每期预算"),
    ("workspace.capital_base", "可投资总资金"),
    ("portfolio.positions", "组合持仓"),
    ("portfolio.budget", "每期预算"),
    ("baseline.deploy_total", "建议部署总额"),
    ("baseline.cash_keep", "留现金"),
    ("baseline.cash_release", "现金池释放"),
    ("baseline.budget", "本期预算"),
    ("plan.cash_reserve_balance", "现金池余额"),
    ("holdings", "组合持仓快照"),
    ("per_symbol_adjustments", "分品种倍率修正"),
    ("spread.percentile", "股债利差历史分位"),
    ("spread.value", "股债利差"),
    ("score.total", "综合评分"),
    ("score.grade", "评分档位"),
    ("pe_percentile_10y", "PE 近十年分位"),
    ("dividend_yield_pct", "股息率"),
    ("critical_degraded_fields", "关键降级字段"),
    ("degraded_fields", "降级字段"),
    ("actual_weight", "当前仓位"),
    ("target_weight", "目标仓位"),
    ("projected_weight", "投入后仓位"),
    ("bias_pct", "年线乖离"),
    ("ma250", "年线（MA250）"),
    ("rsi14", "RSI"),
)


def _number(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _short_list(value, limit=3):
    if not isinstance(value, list):
        return []
    return [str(item).strip()[:160] for item in value if str(item).strip()][:limit]


def humanize_ai_text(text):
    """Replace machine field paths in user-facing AI prose with Chinese labels."""
    if text is None:
        return ""
    result = str(text)
    for path, label in FIELD_LABELS:
        if path in result:
            result = result.replace(path, label)
    # Collapse leftover "label=123" wrappers that still look technical.
    result = result.replace("年线（MA250）=", "年线（MA250） ")
    return result


def _humanize_list(items):
    return [humanize_ai_text(item) for item in items]


def _analysis_sections(value, limit=4):
    if not isinstance(value, list):
        return []
    sections = []
    for raw in value[:limit]:
        if not isinstance(raw, dict):
            continue
        title = humanize_ai_text(str(raw.get("title") or "").strip())[:40]
        items = _humanize_list(_short_list(raw.get("items")))
        if title and items:
            sections.append({"title": title, "items": items})
    return sections


def _analysis_snapshot(payload):
    return {
        "symbol": payload.get("symbol") or (payload.get("etf") or {}).get("symbol"),
        "name": payload.get("name"),
        "index_name": payload.get("index_name"),
        "index_full_name": payload.get("index_full_name"),
        "etf_name": payload.get("etf_name"),
        "analysis_mode": payload.get("analysis_mode"),
        "asset_class": payload.get("asset_class"),
        "updated_at": payload.get("updated_at"),
        "etf": {
            key: (payload.get("etf") or {}).get(key)
            for key in (
                "symbol",
                "symbol_name",
                "price",
                "change_pct",
                "as_of",
                "market_timestamp",
                "provider",
                "volume",
                "bid",
                "ask",
                "product_quality",
            )
        },
        "index": {
            key: (payload.get("index") or {}).get(key)
            for key in ("date", "close", "change_pct")
        },
        "valuation": {
            key: (payload.get("valuation") or {}).get(key)
            for key in ("pe", "pb", "dividend_yield_pct", "pe_percentile_10y", "roe_pct")
        },
        "bond": {"yield10y": (payload.get("bond") or {}).get("yield10y")},
        "spread": {
            key: (payload.get("spread") or {}).get(key)
            for key in ("value", "percentile", "label")
        },
        "technicals": {
            key: (payload.get("technicals") or {}).get(key)
            for key in (
                "bias_pct",
                "ma250",
                "rsi14",
                "rsi_label",
                "boll",
                "kdj",
                "kdj_label",
            )
        },
        "score": {
            "total": (payload.get("score") or {}).get("total"),
            "grade": (payload.get("score") or {}).get("grade"),
            "framework": (payload.get("score") or {}).get("framework"),
            "components": (payload.get("score") or {}).get("components"),
        },
        "not_applicable": payload.get("not_applicable") or {},
        "gold_macro": {
            key: (payload.get("gold_macro") or {}).get(key)
            for key in ("score", "mult", "zone", "band", "hint", "degraded", "us10y", "usd_index")
        }
        if payload.get("gold_macro")
        else None,
        "backtest": {
            key: (payload.get("backtest") or {}).get(key)
            for key in (
                "samples",
                "horizon_days",
                "avg_return_pct",
                "win_rate_pct",
                "worst_pct",
                "label",
            )
        },
    }


def _workspace_snapshot(workspace, symbol):
    holding = next(
        (item for item in workspace.get("etfs") or [] if item.get("symbol") == symbol),
        {},
    )
    plan = workspace.get("plan") or {}
    return {
        "plan_budget": _number(plan.get("amount")),
        "capital_base": _number(plan.get("capital_base")),
        "initial_target_pct": _number(plan.get("initial_target_pct")),
        "initial_build_completed": bool(plan.get("initial_build_completed_at")),
        "trading_cost": plan.get("trading_cost") or {},
        "plan_strategy": plan.get("strategy"),
        "holding": {
            key: holding.get(key) for key in ("symbol", "shares", "cost", "target_weight")
        },
    }


def _normalize_baseline(raw, workspace, execution_budget=None):
    if not isinstance(raw, dict):
        raise AIProviderError("缺少规则基线建议", status=400, code="invalid_request")
    amount = max(0.0, _number(raw.get("amount")))
    plan_budget = max(
        0.0,
        _number(
            execution_budget,
            _number((workspace.get("plan") or {}).get("amount")),
        ),
    )
    return {
        "stance": str(raw.get("stance") or "")[:40],
        "headline": str(raw.get("headline") or "")[:160],
        "reason": str(raw.get("reason") or "")[:240],
        "amount": min(amount, plan_budget),
        "remaining_amount": min(
            max(0.0, _number(raw.get("remaining_amount"), amount)), plan_budget
        ),
    }


def _data_quality(analysis):
    errors = analysis.get("errors") if isinstance(analysis.get("errors"), dict) else {}
    not_applicable = (
        analysis.get("not_applicable")
        if isinstance(analysis.get("not_applicable"), dict)
        else {}
    )
    asset_class = str(analysis.get("asset_class") or "").strip().lower()
    score = analysis.get("score") if isinstance(analysis.get("score"), dict) else {}
    framework = str(score.get("framework") or "").strip().lower()
    if framework not in ("technical", "valuation"):
        framework = (
            "technical" if asset_class in ("commodity", "bond") else "valuation"
        )
    # 商品/债券：估值/国债/指数 PE 为框架不适用，即使仍出现在 errors 也不算关键降级。
    na_keys = set(not_applicable.keys())
    if framework == "technical" or asset_class in ("commodity", "bond"):
        na_keys.update({"valuation", "bond", "index_pe"})
    etf = analysis.get("etf") or {}
    freshness = market_freshness(
        etf.get("market") or "A",
        etf.get("market_timestamp"),
    ).get("status")
    updated_at = analysis.get("updated_at")
    degraded = sorted(key for key in errors if key not in na_keys)
    critical_errors = sorted(
        key
        for key in errors
        if key in ("etf", "valuation", "index_pe", "bond") and key not in na_keys
    )
    return {
        "freshness": freshness,
        "updated_at": updated_at,
        "degraded_fields": degraded,
        "critical_degraded_fields": critical_errors,
        "not_applicable_fields": sorted(na_keys),
        "valuation_framework": framework,
        "may_increase": not critical_errors and freshness in ("live", "recent_close"),
    }


def _evidence_paths(payload, prefix=""):
    paths = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            paths.add(path)
            paths.update(_evidence_paths(value, path))
    return paths


def _validate_proposal(raw, allowed_evidence=None):
    action = str(raw.get("action") or "").strip().lower()
    confidence = str(raw.get("confidence") or "").strip().lower()
    if action not in ALLOWED_ACTIONS or confidence not in ALLOWED_CONFIDENCE:
        raise AIProviderError("大模型校正字段无效", code="invalid_output")
    evidence = _short_list(raw.get("evidence"))
    valid_evidence = evidence if allowed_evidence is None else [
        item for item in evidence if item in allowed_evidence
    ]
    invalid_evidence = [item for item in evidence if item not in valid_evidence]
    data_limitations = _short_list(raw.get("data_limitations"))
    if invalid_evidence:
        confidence = "low"
        data_limitations = _short_list(
            [
                *data_limitations,
                "模型引用了不可验证字段，已忽略并保留规则建议。",
            ]
        )
    # 偏离规则建议时至少需要 2 条合法证据，否则强制低置信度
    if action != "keep" and len(valid_evidence) < 2:
        confidence = "low"
        note = "偏离规则建议但证据不足，已保留规则建议"
        if note not in data_limitations:
            data_limitations = _short_list([*data_limitations, note])
    sections = _analysis_sections(raw.get("analysis_sections"))
    if not sections:
        legacy_sections = (
            ("有利条件", raw.get("supporting_factors")),
            ("主要约束", raw.get("risks")),
        )
        sections = [
            {"title": title, "items": _humanize_list(items)}
            for title, value in legacy_sections
            if (items := _short_list(value))
        ]
    return {
        "action": action,
        "amount_multiplier": max(0.0, _number(raw.get("amount_multiplier"), 1)),
        "confidence": confidence,
        "summary": humanize_ai_text(str(raw.get("summary") or "").strip())[:240],
        "focus_title": humanize_ai_text(str(raw.get("focus_title") or "").strip())[:80],
        "analysis_sections": sections,
        "supporting_factors": _humanize_list(_short_list(raw.get("supporting_factors"))),
        "risks": _humanize_list(_short_list(raw.get("risks"))),
        "watch_items": _humanize_list(_short_list(raw.get("watch_items"))),
        "evidence": valid_evidence,
        "conditions_to_reverse": _humanize_list(_short_list(raw.get("conditions_to_reverse"))),
        "data_limitations": _humanize_list(data_limitations),
    }


def apply_policy(baseline, proposal, data_quality, position, settings):
    requested = proposal["amount_multiplier"]
    if proposal["action"] == "reduce":
        requested = min(1.0, requested)
    elif proposal["action"] == "increase":
        requested = max(1.0, requested)
    accepted = requested
    reasons = []
    if proposal["action"] == "pause":
        accepted = 0
    elif proposal["action"] == "keep":
        accepted = 1
    if proposal["confidence"] == "low":
        accepted = 1
        reasons.append("低置信度：保留规则建议")
    if not data_quality.get("may_increase") and accepted > 1:
        accepted = 1
        reasons.append("数据陈旧或降级：禁止提高投入")
    if position.get("blocked") or position.get("would_exceed"):
        if accepted > 1:
            accepted = 1
        reasons.append("仓位达到或将超过允许上限：禁止提高投入")
    accepted = min(
        max(0.0, accepted),
        _number(settings.get("max_increase_multiplier"), 1.5),
    )
    baseline_amount = max(0.0, _number(baseline.get("remaining_amount")))
    budget = max(
        0.0,
        _number(position.get("execution_budget"), _number(position.get("plan_budget"))),
    )
    final_amount = min(budget, baseline_amount * accepted)
    return {
        "status": "accepted" if accepted == requested else "adjusted",
        "requested_multiplier": round(requested, 2),
        "accepted_multiplier": round(accepted, 2),
        "reasons": reasons or ["校正提案符合风控约束"],
        "final_amount": round(final_amount, 2),
    }


def _cached_quote_price(symbol):
    """从进程内行情缓存取市价；无缓存返回 None（不触发网络请求）。"""
    code = str(symbol or "").strip()
    if not code:
        return None

    def _scan(quotes):
        for quote in quotes or []:
            if not isinstance(quote, dict):
                continue
            if str(quote.get("symbol") or "").strip() != code:
                continue
            price = _number(quote.get("price"))
            if price > 0:
                return price
        return None

    for entry in QUOTE_MARKET_CACHE.values():
        if not isinstance(entry, dict):
            continue
        found = _scan((entry.get("payload") or {}).get("quotes"))
        if found is not None:
            return found
    cached = QUOTE_CACHE.get("payload")
    if isinstance(cached, dict):
        found = _scan(cached.get("quotes"))
        if found is not None:
            return found
    return None


def _holding_mark_value(item):
    shares = max(0.0, _number(item.get("shares")))
    if not (shares > 0):
        return 0.0
    price = _cached_quote_price(item.get("symbol"))
    if price is not None and price > 0:
        return shares * price
    cost = max(0.0, _number(item.get("cost")))
    return shares * cost if cost > 0 else 0.0


def _position_snapshot(raw, workspace, symbol=""):
    source = raw if isinstance(raw, dict) else {}
    plan = workspace.get("plan") or {}
    phase = str(source.get("execution_phase") or "recurring")
    recurring_budget = max(0.0, _number(plan.get("amount")))
    # Phase 7：不再叠加 pending carry；未执行预算统一走现金池，AI 侧只用周期预算
    recurring_cap = recurring_budget
    capital_base = max(0.0, _number(plan.get("capital_base")))
    initial_target_pct = max(0.0, min(100.0, _number(plan.get("initial_target_pct"))))
    try:
        initial_months = int(plan.get("initial_months") or 1)
    except (TypeError, ValueError):
        initial_months = 1
    initial_months = max(1, min(36, initial_months))
    target_amount = capital_base * initial_target_pct / 100.0
    current_value = 0.0
    for item in workspace.get("etfs") or []:
        current_value += _holding_mark_value(item)
    initial_gap = max(0.0, target_amount - current_value)
    cadence = str(plan.get("cadence") or "monthly").strip().lower()
    periods = 4 if cadence == "weekly" else 2 if cadence == "biweekly" else 1
    # 剩余缺口 ÷ 剩余月数（无起始戳时按全长月数）；逾期剩 1 个月打满。
    started_raw = str(plan.get("initial_build_started_at") or "").strip()
    months_left = initial_months
    if started_raw:
        try:
            started = datetime.datetime.fromisoformat(started_raw.replace("Z", "+00:00"))
            now = datetime.datetime.now(started.tzinfo) if started.tzinfo else datetime.datetime.now()
            elapsed = (now.year - started.year) * 12 + (now.month - started.month)
            if now.day < started.day:
                elapsed -= 1
            months_left = max(1, initial_months - max(0, elapsed))
        except ValueError:
            months_left = initial_months
    period_installment = (initial_gap / months_left) / periods if months_left else initial_gap
    initial_budget = min(initial_gap, period_installment)
    allowed_budget = (
        initial_budget
        if phase == "initial" and not plan.get("initial_build_completed_at")
        else recurring_cap
    )
    requested_budget = max(0.0, _number(source.get("execution_budget")))
    execution_budget = min(requested_budget, allowed_budget) if requested_budget else allowed_budget
    return {
        "target_weight": source.get("target_weight"),
        "actual_weight": source.get("actual_weight"),
        "projected_weight": source.get("projected_weight"),
        "blocked": source.get("blocked") is True,
        "would_exceed": source.get("would_exceed") is True,
        "plan_budget": recurring_budget,
        "execution_phase": phase,
        "execution_budget": execution_budget,
    }


def _strip_volatile_quote_fields(model_input):
    """缓存键用：剔除盘中高频字段，避免行情跳动刷缓存。"""
    payload = copy.deepcopy(model_input)
    analysis = payload.get("analysis")
    if isinstance(analysis, dict):
        etf = analysis.get("etf")
        if isinstance(etf, dict):
            for key in ("price", "change_pct", "as_of", "market_timestamp", "bid", "ask", "volume"):
                etf.pop(key, None)
        index = analysis.get("index")
        if isinstance(index, dict):
            index.pop("change_pct", None)
    return payload


def _cache_key(provider, model, payload):
    stable = _strip_volatile_quote_fields(payload)
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return f"{provider}:{model}:{hashlib.sha256(encoded).hexdigest()}"


def _normalize_usage(usage):
    if not isinstance(usage, dict):
        return {"prompt_tokens": 0, "completion_tokens": 0}
    prompt = usage.get("prompt_tokens")
    if prompt is None:
        prompt = usage.get("input_tokens")
    completion = usage.get("completion_tokens")
    if completion is None:
        completion = usage.get("output_tokens")
    try:
        prompt = int(prompt or 0)
    except (TypeError, ValueError):
        prompt = 0
    try:
        completion = int(completion or 0)
    except (TypeError, ValueError):
        completion = 0
    return {"prompt_tokens": max(0, prompt), "completion_tokens": max(0, completion)}


def record_ai_usage(usage):
    normalized = _normalize_usage(usage)
    AI_USAGE_SESSION["requests"] = int(AI_USAGE_SESSION.get("requests") or 0) + 1
    AI_USAGE_SESSION["prompt_tokens"] = int(AI_USAGE_SESSION.get("prompt_tokens") or 0) + normalized[
        "prompt_tokens"
    ]
    AI_USAGE_SESSION["completion_tokens"] = int(AI_USAGE_SESSION.get("completion_tokens") or 0) + normalized[
        "completion_tokens"
    ]
    return normalized


def _portfolio_snapshot(workspace):
    """组合上下文：actual_weight_pct 用 shares×cost 成本口径（离线可算）。"""
    plan = workspace.get("plan") or {}
    budget = max(0.0, _number(plan.get("amount")))
    rows = []
    total_cost = 0.0
    prepared = []
    for item in workspace.get("etfs") or []:
        symbol = str(item.get("symbol") or "").strip()
        if not symbol:
            continue
        shares = max(0.0, _number(item.get("shares")))
        cost = max(0.0, _number(item.get("cost")))
        value = shares * cost if shares > 0 and cost > 0 else 0.0
        total_cost += value
        prepared.append(
            {
                "symbol": symbol,
                "name": str(item.get("name") or "").strip(),
                "target_weight": _number(item.get("target_weight")),
                "cost_value": value,
            }
        )
    for row in prepared:
        pct = (row["cost_value"] / total_cost * 100.0) if total_cost > 0 else 0.0
        rows.append(
            {
                "symbol": row["symbol"],
                "name": row["name"],
                "target_weight": round(row["target_weight"], 2),
                "actual_weight_pct": round(pct, 2),
            }
        )
    return {
        "budget": round(budget, 2),
        "weight_basis": "cost",
        "positions": rows,
    }


def review_recommendation(request_payload, force=False):
    settings = ai_settings()
    if not settings.get("enabled"):
        raise AIProviderError("请先在设置中启用 AI 分析", status=409, code="disabled")
    provider = settings.get("provider")
    model = (settings.get("models") or {}).get(provider)
    api_key = get_api_key(provider)
    if not api_key:
        raise AIProviderError("请先配置当前提供商的 API Key", status=409, code="missing_key")

    symbol = "".join(ch for ch in str(request_payload.get("symbol") or "") if ch.isdigit()).zfill(6)
    if len(symbol) != 6 or not symbol.strip("0"):
        raise AIProviderError("ETF 代码无效", status=400, code="invalid_request")
    workspace = get_workspace()
    position = _position_snapshot(request_payload.get("position"), workspace, symbol)
    baseline = _normalize_baseline(
        request_payload.get("baseline"),
        workspace,
        position.get("execution_budget"),
    )
    analysis = get_dividend_dashboard(symbol=symbol)
    if analysis.get("supported") is False or (analysis.get("error") and not analysis.get("score")):
        raise AIProviderError("当前分析数据不可用，不能执行 AI 分析", status=409, code="data_unavailable")
    quality = _data_quality(analysis)
    model_input = {
        "output_version": AI_ANALYSIS_VERSION,
        "analysis": _analysis_snapshot(analysis),
        "baseline": baseline,
        "workspace": _workspace_snapshot(workspace, symbol),
        "position": position,
        "portfolio": _portfolio_snapshot(workspace),
        "data_quality": quality,
    }
    cache_key = _cache_key(provider, model, model_input)
    cached = AI_REVIEW_CACHE.get(cache_key)
    if not force and cached and cached["expires"] > time.time():
        return {**cached["payload"], "cached": True}

    raw, usage = request_review(
        provider,
        api_key,
        model,
        SYSTEM_PROMPT,
        model_input,
        int(settings.get("timeout_seconds", 60)),
        int(settings.get("max_output_tokens", 1800)),
    )
    record_ai_usage(usage)
    proposal = _validate_proposal(raw, _evidence_paths(model_input))
    policy = apply_policy(baseline, proposal, quality, position, settings)
    result = {
        "baseline_recommendation": baseline,
        "ai_proposal": proposal,
        "policy_decision": policy,
        "final_recommendation": {
            "amount": policy["final_amount"],
            "action": proposal["action"],
            "summary": proposal["summary"],
            "is_correction": policy["accepted_multiplier"] != 1,
        },
        "provider": provider,
        "model": model,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "input_as_of": analysis.get("updated_at"),
        "usage": usage,
        "cached": False,
        "disclaimer": "AI 分析仅供研究参考，不构成投资建议；不会自动下单或修改长期策略。",
    }
    cache_seconds = int(settings.get("cache_minutes", 30)) * 60
    if cache_seconds:
        AI_REVIEW_CACHE[cache_key] = {
            "expires": time.time() + cache_seconds,
            "payload": result,
        }
    return result


def _normalize_symbol_code(raw):
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    symbol = digits.zfill(6)
    if len(symbol) != 6 or not digits:
        return ""
    return symbol


def _normalize_portfolio_baseline(raw):
    if not isinstance(raw, dict):
        raise AIProviderError("缺少全池规则基线", status=400, code="invalid_request")
    allocations = []
    for item in raw.get("allocations") or []:
        if not isinstance(item, dict):
            continue
        symbol = _normalize_symbol_code(item.get("symbol"))
        if not symbol:
            continue
        amount = max(0.0, _number(item.get("amount")))
        allocations.append(
            {
                "symbol": symbol,
                "name": str(item.get("name") or symbol).strip()[:80],
                "amount": round(amount, 2),
                "band": str(item.get("band") or "")[:40],
                "mult": max(0.0, _number(item.get("mult"), 1)),
            }
        )
    skipped = []
    for item in raw.get("skipped") or []:
        if not isinstance(item, dict):
            continue
        symbol = _normalize_symbol_code(item.get("symbol"))
        if not symbol:
            continue
        skipped.append(
            {
                "symbol": symbol,
                "name": str(item.get("name") or symbol).strip()[:80],
                "reason": str(item.get("reason") or item.get("band") or "")[:160],
            }
        )
    budget = max(0.0, _number(raw.get("budget")))
    if budget <= 0 and not allocations:
        raise AIProviderError("全池基线缺少预算或分配", status=400, code="invalid_request")
    return {
        "budget": round(budget, 2),
        "deploy_total": round(max(0.0, _number(raw.get("deploy_total"))), 2),
        "cash_keep": round(max(0.0, _number(raw.get("cash_keep"))), 2),
        "cash_release": round(max(0.0, _number(raw.get("cash_release"))), 2),
        "strategy": str(raw.get("strategy") or "valuation")[:40],
        "allocations": allocations,
        "skipped": skipped,
    }


def _compact_holding_snapshot(workspace_etf, analysis):
    symbol = _normalize_symbol_code(workspace_etf.get("symbol"))
    valuation = (analysis or {}).get("valuation") or {}
    spread = (analysis or {}).get("spread") or {}
    score = (analysis or {}).get("score") or {}
    return {
        "symbol": symbol,
        "name": str(
            workspace_etf.get("name")
            or (analysis or {}).get("etf_name")
            or (analysis or {}).get("name")
            or symbol
        ).strip()[:80],
        "asset_class": (analysis or {}).get("asset_class"),
        "target_weight": round(_number(workspace_etf.get("target_weight")), 2),
        "actual_weight_pct": None,  # filled by caller with cost-basis weights
        "pe_percentile_10y": valuation.get("pe_percentile_10y"),
        "spread_percentile": spread.get("percentile"),
        "score_total": score.get("total"),
        "grade": score.get("grade"),
    }


def _build_portfolio_holdings(workspace):
    """池内持仓紧凑快照；分析取不到则记入降级，不阻塞。"""
    portfolio = _portfolio_snapshot(workspace)
    weight_by_symbol = {
        row["symbol"]: row["actual_weight_pct"] for row in portfolio.get("positions") or []
    }
    holdings = []
    degraded = []
    critical = []
    for item in workspace.get("etfs") or []:
        symbol = _normalize_symbol_code(item.get("symbol"))
        if not symbol:
            continue
        try:
            analysis = get_dividend_dashboard(symbol=symbol)
        except Exception:
            analysis = {"supported": False, "error": "analysis_fetch_failed"}
        if analysis.get("supported") is False or (
            analysis.get("error") and not analysis.get("score")
        ):
            degraded.append(f"{symbol}.analysis")
            critical.append(f"{symbol}.analysis")
            snapshot = _compact_holding_snapshot(item, {})
        else:
            snapshot = _compact_holding_snapshot(item, analysis)
            if snapshot.get("pe_percentile_10y") is None and snapshot.get("score_total") is None:
                degraded.append(f"{symbol}.valuation")
                critical.append(f"{symbol}.valuation")
        snapshot["actual_weight_pct"] = weight_by_symbol.get(symbol, 0.0)
        holdings.append(snapshot)
    return holdings, {
        "degraded_fields": sorted(set(degraded)),
        "critical_degraded_fields": sorted(set(critical)),
        "may_increase": not critical,
    }


def _validate_portfolio_proposal(raw, allowed_evidence=None):
    action = str(raw.get("action") or "").strip().lower()
    confidence = str(raw.get("confidence") or "").strip().lower()
    if action not in ALLOWED_PORTFOLIO_ACTIONS or confidence not in ALLOWED_CONFIDENCE:
        raise AIProviderError("全池校正字段无效", code="invalid_output")
    evidence = _short_list(raw.get("evidence"))
    valid_evidence = (
        evidence
        if allowed_evidence is None
        else [item for item in evidence if item in allowed_evidence]
    )
    invalid_evidence = [item for item in evidence if item not in valid_evidence]
    data_limitations = _short_list(raw.get("data_limitations"))
    if invalid_evidence:
        confidence = "low"
        data_limitations = _short_list(
            [*data_limitations, "模型引用了不可验证字段，已忽略并保留规则分配。"]
        )
    if action == "adjust" and len(valid_evidence) < 2:
        confidence = "low"
        note = "偏离规则建议但证据不足，已保留规则分配"
        if note not in data_limitations:
            data_limitations = _short_list([*data_limitations, note])

    adjustments = []
    for item in raw.get("per_symbol_adjustments") or []:
        if not isinstance(item, dict):
            continue
        symbol = _normalize_symbol_code(item.get("symbol"))
        if not symbol:
            continue
        adjustments.append(
            {
                "symbol": symbol,
                "multiplier": max(0.0, _number(item.get("multiplier"), 1)),
                "reason": humanize_ai_text(str(item.get("reason") or "").strip())[:160],
            }
        )
        if len(adjustments) >= 8:
            break

    sections = _analysis_sections(raw.get("analysis_sections"))
    return {
        "action": action,
        "confidence": confidence,
        "summary": humanize_ai_text(str(raw.get("summary") or "").strip())[:240],
        "focus_title": humanize_ai_text(str(raw.get("focus_title") or "").strip())[:80],
        "analysis_sections": sections,
        "per_symbol_adjustments": adjustments if action == "adjust" else [],
        "watch_items": _humanize_list(_short_list(raw.get("watch_items"))),
        "evidence": valid_evidence,
        "conditions_to_reverse": _humanize_list(_short_list(raw.get("conditions_to_reverse"))),
        "data_limitations": _humanize_list(data_limitations),
    }


def apply_portfolio_policy(baseline, proposal, data_quality, settings):
    """仲裁全池修正：低置信度/证据不足保留规则；超顶按比例缩回；降级禁上调。"""
    max_mult = max(0.0, _number(settings.get("max_increase_multiplier"), 1.5))
    keep_rule = (
        proposal.get("confidence") == "low"
        or proposal.get("action") != "adjust"
        or len(proposal.get("evidence") or []) < 2
    )
    may_increase = data_quality.get("may_increase") is True
    reasons = []
    if keep_rule:
        reasons.append("低置信度或证据不足：保留规则分配")
    if not may_increase:
        reasons.append("数据降级：禁止上调投入")

    adj_map = {
        item["symbol"]: item
        for item in (proposal.get("per_symbol_adjustments") or [])
        if isinstance(item, dict) and item.get("symbol")
    }
    rows = []
    for row in baseline.get("allocations") or []:
        symbol = row["symbol"]
        rule_amount = max(0.0, _number(row.get("amount")))
        mult = 1.0
        if not keep_rule:
            adj = adj_map.get(symbol)
            if adj:
                mult = max(0.0, min(max_mult, _number(adj.get("multiplier"), 1)))
            if not may_increase and mult > 1:
                mult = 1.0
        final_amount = round(rule_amount * mult, 2)
        rows.append(
            {
                "symbol": symbol,
                "name": row.get("name") or symbol,
                "rule_amount": round(rule_amount, 2),
                "final_amount": final_amount,
                "multiplier": round(mult, 3),
                "changed": abs(final_amount - round(rule_amount, 2)) > 0.009,
            }
        )

    cap = max(
        0.0,
        _number(baseline.get("budget")) + _number(baseline.get("cash_release")),
    )
    total = sum(item["final_amount"] for item in rows)
    scaled = False
    if cap > 0 and total > cap + 1e-9:
        scale = cap / total
        for item in rows:
            item["final_amount"] = round(item["final_amount"] * scale, 2)
            item["changed"] = abs(item["final_amount"] - item["rule_amount"]) > 0.009
        # 尾差归到最大行，避免四舍五入超顶
        adjusted_total = sum(item["final_amount"] for item in rows)
        if rows and adjusted_total != round(cap, 2):
            delta = round(cap - adjusted_total, 2)
            top = max(rows, key=lambda item: item["final_amount"])
            top["final_amount"] = round(max(0.0, top["final_amount"] + delta), 2)
            top["changed"] = abs(top["final_amount"] - top["rule_amount"]) > 0.009
        scaled = True
        reasons.append("修正总额超预算+释放上限：已按比例缩回")

    changed_count = sum(1 for item in rows if item["changed"])
    status = "kept" if keep_rule or changed_count == 0 else ("scaled" if scaled else "adjusted")
    return {
        "status": status,
        "reasons": reasons or ["校正提案符合风控约束"],
        "final_total": round(sum(item["final_amount"] for item in rows), 2),
        "cap": round(cap, 2),
        "changed_count": changed_count,
        "allocations": rows,
    }


def review_portfolio(request_payload, force=False):
    settings = ai_settings()
    if not settings.get("enabled"):
        raise AIProviderError("请先在设置中启用 AI 分析", status=409, code="disabled")
    provider = settings.get("provider")
    model = (settings.get("models") or {}).get(provider)
    api_key = get_api_key(provider)
    if not api_key:
        raise AIProviderError("请先配置当前提供商的 API Key", status=409, code="missing_key")

    workspace = get_workspace()
    baseline = _normalize_portfolio_baseline(
        (request_payload or {}).get("baseline") if isinstance(request_payload, dict) else None
    )
    holdings, quality = _build_portfolio_holdings(workspace)
    plan = workspace.get("plan") or {}
    cash_reserve = plan.get("cash_reserve") if isinstance(plan.get("cash_reserve"), dict) else {}
    model_input = {
        "output_version": AI_ANALYSIS_VERSION,
        "baseline": baseline,
        "holdings": holdings,
        "plan": {
            "budget": round(max(0.0, _number(plan.get("amount"))), 2),
            "strategy": str(plan.get("strategy") or "")[:40],
            "cash_reserve_balance": round(max(0.0, _number(cash_reserve.get("balance"))), 2),
        },
        "data_quality": quality,
    }
    cache_key = f"portfolio:{_cache_key(provider, model, model_input)}"
    cached = AI_REVIEW_CACHE.get(cache_key)
    if not force and cached and cached["expires"] > time.time():
        return {**cached["payload"], "cached": True}

    raw, usage = request_review(
        provider,
        api_key,
        model,
        PORTFOLIO_SYSTEM_PROMPT,
        model_input,
        int(settings.get("timeout_seconds", 60)),
        int(settings.get("max_output_tokens", 1800)),
        response_schema=PORTFOLIO_REVIEW_SCHEMA,
        schema_name="portfolio_review",
    )
    record_ai_usage(usage)
    proposal = _validate_portfolio_proposal(raw, _evidence_paths(model_input))
    policy = apply_portfolio_policy(baseline, proposal, quality, settings)
    result = {
        "baseline": baseline,
        "ai_proposal": proposal,
        "policy_decision": policy,
        "final_allocations": [
            {
                "symbol": row["symbol"],
                "name": row["name"],
                "rule_amount": row["rule_amount"],
                "final_amount": row["final_amount"],
                "changed": row["changed"],
            }
            for row in policy.get("allocations") or []
        ],
        "provider": provider,
        "model": model,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "usage": usage,
        "cached": False,
        "disclaimer": "AI 全池审视仅供研究参考，不构成投资建议。",
    }
    cache_seconds = int(settings.get("cache_minutes", 30)) * 60
    if cache_seconds:
        AI_REVIEW_CACHE[cache_key] = {
            "expires": time.time() + cache_seconds,
            "payload": result,
        }
    return result


def ai_status():
    settings = ai_settings()
    provider = settings.get("provider")
    return {
        "enabled": settings.get("enabled") is True,
        "provider": provider,
        "model": (settings.get("models") or {}).get(provider),
        "credentials": {
            name: credential_status(name) for name in ("deepseek", "openai")
        },
        "usage_session": {
            "requests": int(AI_USAGE_SESSION.get("requests") or 0),
            "prompt_tokens": int(AI_USAGE_SESSION.get("prompt_tokens") or 0),
            "completion_tokens": int(AI_USAGE_SESSION.get("completion_tokens") or 0),
        },
    }


def test_connection(provider=None):
    settings = ai_settings()
    name = provider or settings.get("provider")
    model = (settings.get("models") or {}).get(name)
    api_key = get_api_key(name)
    if not api_key:
        raise AIProviderError("请先配置 API Key", status=409, code="missing_key")
    result, usage = request_review(
        name,
        api_key,
        model,
        CONNECTION_PING_PROMPT,
        {
            "analysis": {},
            "baseline": {"amount": 0},
            "workspace": {},
            "position": {},
            "data_quality": {"may_increase": False},
        },
        min(30, int(settings.get("timeout_seconds", 60))),
        200,
    )
    record_ai_usage(usage)
    return {"ok": True, "provider": name, "model": model, "usage": usage}
