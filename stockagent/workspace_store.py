#!/usr/bin/env python3
"""Workspace persistence and normalization (DCA plan + ETF holdings)."""

import datetime
import json

from .defaults import DEFAULT_STRATEGY_CONFIG, DEFAULT_TARGET_WEIGHTS, DEFAULT_WORKSPACE
from .paths import WORKSPACE_LOCK, WORKSPACE_PATH
from .symbols import as_of

STRATEGY_IDS = ("fixed", "valuation", "grade", "rebalance", "custom")


def empty_workspace():
    return json.loads(json.dumps(DEFAULT_WORKSPACE))


def _positive_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _clamp_weight(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if number < 0:
        return 0
    if number > 100:
        return 100
    return round(number, 2)


def _nonnegative_number(value, fallback=0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return round(max(0, number), 6)


def _clamp_initial_months(value, fallback=1):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    if number < 1:
        return fallback
    return min(36, number)


def normalize_trading_cost(payload):
    base = dict(DEFAULT_WORKSPACE["plan"]["trading_cost"])
    source = payload if isinstance(payload, dict) else {}
    min_commission = _nonnegative_number(
        source.get("min_commission"), base["min_commission"]
    )
    commission_rate_pct = _nonnegative_number(
        source.get("commission_rate_pct"), base["commission_rate_pct"]
    )
    max_fee_ratio_pct = _nonnegative_number(
        source.get("max_fee_ratio_pct"), base["max_fee_ratio_pct"]
    )
    try:
        lot_size = int(source.get("lot_size", base["lot_size"]))
    except (TypeError, ValueError):
        lot_size = base["lot_size"]
    return {
        "min_commission": min_commission,
        "commission_rate_pct": min(10, commission_rate_pct),
        "max_fee_ratio_pct": min(100, max_fee_ratio_pct),
        "lot_size": min(100000, max(1, lot_size)),
    }


def normalize_pending_orders(payload):
    if not isinstance(payload, dict):
        return {}
    result = {}
    for raw_symbol, raw in payload.items():
        digits = "".join(ch for ch in str(raw_symbol or "") if ch.isdigit())
        symbol = digits.zfill(6)
        if len(symbol) != 6 or not digits or not isinstance(raw, dict):
            continue
        period = str(raw.get("period") or "").strip()
        if period and (len(period) != 10 or period[4] != "-" or period[7] != "-"):
            period = ""
        result[symbol] = {
            "period": period,
            "carry": _nonnegative_number(raw.get("carry")),
            "scheduled": _nonnegative_number(raw.get("scheduled")),
            "remaining": _nonnegative_number(raw.get("remaining")),
        }
    return result



def _nonnegative_or_default(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number >= 0 else fallback


def normalize_execution_policy(payload):
    base = dict(DEFAULT_WORKSPACE["plan"]["execution_policy"])
    source = payload if isinstance(payload, dict) else {}
    return {
        "premium_warn_pct": _nonnegative_or_default(
            source.get("premium_warn_pct"), base["premium_warn_pct"]
        ),
        "premium_block_pct": _nonnegative_or_default(
            source.get("premium_block_pct"), base["premium_block_pct"]
        ),
        "discount_warn_pct": _nonnegative_or_default(
            source.get("discount_warn_pct"), base["discount_warn_pct"]
        ),
        "discount_block_pct": _nonnegative_or_default(
            source.get("discount_block_pct"), base["discount_block_pct"]
        ),
        "spread_warn_pct": _nonnegative_or_default(
            source.get("spread_warn_pct"), base["spread_warn_pct"]
        ),
        "spread_block_pct": _nonnegative_or_default(
            source.get("spread_block_pct"), base["spread_block_pct"]
        ),
        "quote_max_age_minutes": max(
            1,
            int(
                round(
                    _nonnegative_or_default(
                        source.get("quote_max_age_minutes"), base["quote_max_age_minutes"]
                    )
                )
            ),
        ),
        "pe_hysteresis_pp": _nonnegative_or_default(
            source.get("pe_hysteresis_pp"), base["pe_hysteresis_pp"]
        ),
        "allow_warning_override": (
            base["allow_warning_override"]
            if source.get("allow_warning_override") is None
            else bool(source.get("allow_warning_override"))
        ),
    }


def normalize_signal_holding(row):
    if not isinstance(row, dict):
        return None

    def opt_float(key, digits=4):
        try:
            number = float(row.get(key))
        except (TypeError, ValueError):
            return None
        if not (number == number):  # NaN
            return None
        return round(number, digits)

    band_index = row.get("band_index")
    try:
        band_index = int(band_index) if band_index is not None else None
    except (TypeError, ValueError):
        band_index = None
    strategy = str(row.get("strategy") or "").strip().lower()
    if strategy and strategy not in STRATEGY_IDS:
        strategy = None
    return {
        "pe_pct": opt_float("pe_pct"),
        "grade": str(row["grade"]).upper() if row.get("grade") is not None else None,
        "asset_class": str(row["asset_class"]) if row.get("asset_class") is not None else None,
        "spread_pct": opt_float("spread_pct"),
        "bias_pct": opt_float("bias_pct"),
        "sentiment_market": (
            str(row["sentiment_market"]) if row.get("sentiment_market") is not None else None
        ),
        "sentiment_score": opt_float("sentiment_score", 6),
        "base_mult": opt_float("base_mult", 3),
        "sentiment_mult": opt_float("sentiment_mult", 3),
        "effective_mult": opt_float("effective_mult", 3),
        "band": str(row["band"]) if row.get("band") is not None else None,
        "band_index": band_index,
        "data_as_of": str(row["data_as_of"]) if row.get("data_as_of") is not None else None,
        "analysis_usable": True if row.get("analysis_usable") is None else bool(row.get("analysis_usable")),
        "index_code": str(row["index_code"]) if row.get("index_code") is not None else None,
        "strategy": strategy,
    }


def normalize_signal_snapshots(payload):
    if not isinstance(payload, dict):
        return {}
    entries = []
    for raw_key, raw in payload.items():
        period = str(raw_key or "").strip()
        if len(period) != 10 or period[4] != "-" or period[7] != "-":
            continue
        if not isinstance(raw, dict):
            continue
        holdings_in = raw.get("holdings") if isinstance(raw.get("holdings"), dict) else {}
        holdings = {}
        for sym_raw, row in holdings_in.items():
            digits = "".join(ch for ch in str(sym_raw or "") if ch.isdigit())
            symbol = digits.zfill(6)
            if len(symbol) != 6 or not digits:
                continue
            normalized = normalize_signal_holding(row)
            if normalized:
                holdings[symbol] = normalized
        strategy = str(raw.get("strategy") or "valuation").strip().lower()
        if strategy not in STRATEGY_IDS:
            strategy = "valuation"
        entries.append(
            (
                period,
                {
                    "id": str(raw.get("id") or "").strip() or f"sig_{period}",
                    "period": period,
                    "created_at": str(raw.get("created_at") or "").strip() or None,
                    "strategy": strategy,
                    "strategy_config": normalize_strategy_config(raw.get("strategy_config")),
                    "holdings": holdings,
                    "config_fingerprint": str(raw.get("config_fingerprint") or "").strip(),
                },
            )
        )
    entries.sort(key=lambda item: item[0])
    kept = entries[-24:]
    return {period: snapshot for period, snapshot in kept}


def normalize_decision_history(payload):
    if not isinstance(payload, list):
        return []
    actions = {"confirmed", "skipped", "blocked", "override"}
    sides = {"buy", "sell"}
    statuses = {"ready", "warning", "preview", "blocked"}
    rows = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        digits = "".join(ch for ch in str(item.get("symbol") or "") if ch.isdigit())
        symbol = digits.zfill(6)
        if len(symbol) != 6 or not digits:
            continue
        period = str(item.get("period") or "").strip()
        if len(period) != 10 or period[4] != "-" or period[7] != "-":
            continue
        action = str(item.get("action") or "").strip().lower()
        if action not in actions:
            continue
        side = str(item.get("side") or "buy").strip().lower()
        if side not in sides:
            side = "buy"
        policy_status = str(item.get("policy_status") or "").strip().lower()
        reasons = []
        for reason in item.get("policy_reasons") or []:
            text = str(reason or "").strip()
            if text:
                reasons.append(text)
            if len(reasons) >= 12:
                break
        strategic = _positive_number(item.get("strategic_amount"))
        order_amount = _positive_number(item.get("order_amount"))
        fee = _nonnegative_number(item.get("fee"))
        try:
            premium = float(item.get("premium_discount_pct"))
        except (TypeError, ValueError):
            premium = None
        try:
            spread = float(item.get("bid_ask_spread_pct"))
        except (TypeError, ValueError):
            spread = None
        rows.append(
            {
                "id": str(item.get("id") or "").strip() or f"dec_{period}_{symbol}_{action}",
                "period": period,
                "symbol": symbol,
                "side": side,
                "action": action,
                "strategic_amount": round(strategic, 2),
                "order_amount": round(order_amount, 2),
                "fee": round(fee, 2),
                "premium_discount_pct": round(premium, 4) if premium is not None else None,
                "bid_ask_spread_pct": round(spread, 4) if spread is not None else None,
                "policy_status": policy_status if policy_status in statuses else "",
                "policy_reasons": reasons,
                "signal_snapshot_id": str(item.get("signal_snapshot_id") or "").strip() or None,
                "created_at": str(item.get("created_at") or "").strip() or None,
            }
        )
    rows.sort(key=lambda row: (row.get("created_at") or "", row["id"]), reverse=True)
    return rows[:500]


def normalize_execution_drafts_meta(payload):
    source = payload if isinstance(payload, dict) else {}
    return {
        "synced_at": str(source.get("synced_at") or source.get("syncedAt") or "").strip() or None,
        "fingerprint": str(source.get("fingerprint") or "").strip(),
        "signal_snapshot_id": (
            str(source.get("signal_snapshot_id") or source.get("signalSnapshotId") or "").strip()
            or None
        ),
    }


def normalize_decision_snapshot(payload):
    if not isinstance(payload, dict):
        return None
    reasons = []
    for reason in payload.get("policy_reasons") or []:
        text = str(reason or "").strip()
        if text:
            reasons.append(text)
        if len(reasons) >= 12:
            break
    status = str(payload.get("policy_status") or "").strip().lower()
    if status not in ("ready", "warning", "preview", "blocked"):
        status = ""

    def opt_num(key):
        try:
            number = float(payload.get(key))
        except (TypeError, ValueError):
            return None
        return number

    return {
        "phase": str(payload.get("phase") or "").strip() or None,
        "strategic_amount": round(_positive_number(payload.get("strategic_amount")), 2),
        "target_amount": round(_nonnegative_number(payload.get("target_amount")), 2),
        "current_market_value": round(_nonnegative_number(payload.get("current_market_value")), 2),
        "target_gap": round(_nonnegative_number(payload.get("target_gap")), 2),
        "strategy": str(payload.get("strategy") or "").strip(),
        "band": str(payload.get("band") or "").strip(),
        "base_mult": opt_num("base_mult"),
        "sentiment_mult": opt_num("sentiment_mult"),
        "effective_mult": opt_num("effective_mult"),
        "quote_price": round(_nonnegative_number(payload.get("quote_price")), 6),
        "quote_as_of": str(payload["quote_as_of"]) if payload.get("quote_as_of") is not None else None,
        "market_timestamp": (
            str(payload["market_timestamp"]) if payload.get("market_timestamp") is not None else None
        ),
        "provider": str(payload["provider"]) if payload.get("provider") is not None else None,
        "iopv": opt_num("iopv"),
        "premium_discount_pct": opt_num("premium_discount_pct"),
        "bid_ask_spread_pct": opt_num("bid_ask_spread_pct"),
        "analysis_usable": (
            True if payload.get("analysis_usable") is None else bool(payload.get("analysis_usable"))
        ),
        "policy_status": status,
        "policy_reasons": reasons,
        "policy_fingerprint": str(payload.get("policy_fingerprint") or "").strip(),
        "signal_snapshot_id": str(payload.get("signal_snapshot_id") or "").strip() or None,
        "created_at": str(payload.get("created_at") or "").strip() or None,
    }


def normalize_execution_drafts(payload):
    if not isinstance(payload, list):
        return []
    seen = set()
    drafts = []
    readiness_statuses = {"ready", "warning", "preview", "blocked"}
    for item in payload:
        if not isinstance(item, dict):
            continue
        digits = "".join(ch for ch in str(item.get("symbol") or "") if ch.isdigit())
        symbol = digits.zfill(6)
        if len(symbol) != 6 or not digits:
            continue
        period = str(item.get("period") or "").strip()
        if len(period) != 10 or period[4] != "-" or period[7] != "-":
            continue
        date = str(item.get("date") or "").strip() or period
        if len(date) != 10 or date[4] != "-" or date[7] != "-":
            date = period
        status = str(item.get("status") or "pending").strip()
        if status not in ("pending", "confirmed", "skipped"):
            status = "pending"
        draft_id = str(item.get("id") or "").strip() or f"draft_{period}_{symbol}"
        if draft_id in seen:
            continue
        seen.add(draft_id)
        suggested = _positive_number(item.get("suggested_amount"))
        order_amount = _positive_number(item.get("order_amount"))
        total_cash = _positive_number(item.get("total_cash"))
        price = _positive_number(item.get("price"))
        shares = _positive_number(item.get("shares"))
        fee = _nonnegative_number(item.get("fee"))
        confirmed = str(item.get("confirmed_trade_id") or "").strip() or None
        side = str(item.get("side") or "buy").strip().lower()
        if side not in ("buy", "sell"):
            side = "buy"
        decision_snapshot = normalize_decision_snapshot(item.get("decision_snapshot"))
        readiness_raw = str(
            item.get("readiness_status")
            or ((decision_snapshot or {}).get("policy_status") if decision_snapshot else "")
            or ""
        ).strip().lower()
        readiness_status = readiness_raw if readiness_raw in readiness_statuses else (
            "" if status == "pending" else "ready"
        )
        readiness_reasons = []
        for reason in item.get("readiness_reasons") or (
            (decision_snapshot or {}).get("policy_reasons") if decision_snapshot else []
        ) or []:
            text_reason = str(reason or "").strip()
            if text_reason:
                readiness_reasons.append(text_reason)
            if len(readiness_reasons) >= 12:
                break
        stale = True if (status == "pending" and not decision_snapshot) else bool(item.get("stale"))
        if not order_amount and price > 0 and shares > 0:
            order_amount = round(price * shares, 2)
        drafts.append(
            {
                "id": draft_id,
                "period": period,
                "symbol": symbol,
                "name": str(item.get("name") or "").strip(),
                "side": side,
                "suggested_amount": round(suggested, 2),
                "order_amount": round(order_amount, 2),
                "total_cash": round(total_cash, 2),
                "price": round(price, 6),
                "shares": round(shares, 4),
                "fee": round(fee, 2),
                "date": date,
                "status": status,
                "skip_reason": str(item.get("skip_reason") or "").strip(),
                "confirmed_trade_id": confirmed,
                "note": str(item.get("note") or "").strip(),
                "readiness_status": readiness_status,
                "readiness_reasons": readiness_reasons,
                "stale": stale,
                "decision_snapshot": decision_snapshot,
            }
        )
    drafts.sort(
        key=lambda row: (row["period"], row["symbol"], 0 if row["side"] == "sell" else 1),
        reverse=True,
    )
    return drafts



def normalize_etf_entry(item):
    if not isinstance(item, dict):
        return None
    digits = "".join(ch for ch in str(item.get("symbol") or "") if ch.isdigit())
    symbol = digits.zfill(6)
    if len(symbol) != 6 or not digits:
        return None

    target = item.get("target_weight")
    if target is None and item.get("targetWeight") is not None:
        target = item.get("targetWeight")

    return {
        "symbol": symbol,
        "name": str(item.get("name") or "").strip(),
        "shares": _positive_number(item.get("shares")),
        "cost": _positive_number(item.get("cost")),
        "target_weight": _clamp_weight(target),
        "note": str(item.get("note") or "").strip(),
    }


def _clamp_mult(value, fallback=1.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if number < 0:
        return float(fallback)
    return round(min(5.0, number), 2)


def _clamp_pct(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return int(fallback)
    return int(min(100, max(1, round(number))))


def normalize_strategy_config(payload):
    base = json.loads(json.dumps(DEFAULT_STRATEGY_CONFIG))
    if not isinstance(payload, dict):
        return base

    raw_bands = payload.get("pe_bands")
    pe_bands = []
    if isinstance(raw_bands, list) and raw_bands:
        for index, band in enumerate(raw_bands[:8]):
            if not isinstance(band, dict):
                continue
            fallback = base["pe_bands"][min(index, len(base["pe_bands"]) - 1)]
            max_pct = _clamp_pct(band.get("max_pct", band.get("maxPct")), fallback["max_pct"])
            mult = _clamp_mult(band.get("mult"), fallback["mult"])
            label = str(band.get("label") or fallback["label"]).strip() or fallback["label"]
            pe_bands.append({"max_pct": max_pct, "mult": mult, "label": label})
        pe_bands.sort(key=lambda row: row["max_pct"])
        if pe_bands:
            pe_bands[-1]["max_pct"] = 100
    if not pe_bands:
        pe_bands = base["pe_bands"]

    raw_grade = payload.get("grade_mult") if isinstance(payload.get("grade_mult"), dict) else {}
    grade_mult = {}
    for key in ("A", "B", "C", "D", "E"):
        grade_mult[key] = _clamp_mult(raw_grade.get(key), base["grade_mult"][key])

    use_rebalance = payload.get("use_rebalance", True)
    if use_rebalance in (0, "0", "false", "False", False):
        use_rebalance = False
    else:
        use_rebalance = True

    return {
        "pe_bands": pe_bands,
        "grade_mult": grade_mult,
        "use_rebalance": use_rebalance,
    }


def normalize_strategy_overrides(payload):
    """按品种策略覆盖：key 为 6 位代码，value 须为合法 strategy id。"""
    if not isinstance(payload, dict):
        return {}
    result = {}
    for raw_key, raw_id in payload.items():
        digits = "".join(ch for ch in str(raw_key or "") if ch.isdigit())
        symbol = digits.zfill(6) if digits else ""
        if len(symbol) != 6:
            continue
        strategy = str(raw_id or "").strip().lower()
        if strategy not in STRATEGY_IDS:
            continue
        result[symbol] = strategy
    return result


ADD_PLAN_PRESETS = ("auto", "steady", "deep", "custom")


def normalize_add_plan(payload):
    """分档加仓预案：enabled / anchor / preset / levels（宽松存储，比例不在此归一）。

    preset 缺失时：带合法 levels 视为 custom（兼容旧配置），否则 auto；
    preset 非 custom 时 levels 恒为 None（档位建议值由前端预设给出）。
    """
    base = {"enabled": True, "anchor": "price", "preset": "auto", "levels": None}
    if not isinstance(payload, dict):
        return dict(base)
    enabled = payload.get("enabled", True)
    if enabled in (0, "0", "false", "False", False):
        enabled = False
    else:
        enabled = True
    anchor = str(payload.get("anchor") or "price").strip().lower()
    if anchor not in ("price", "cost"):
        anchor = "price"
    raw_levels = payload.get("levels")
    levels = None
    if isinstance(raw_levels, list) and raw_levels:
        rows = []
        for item in raw_levels[:4]:
            if not isinstance(item, dict):
                continue
            try:
                drawdown = float(item.get("drawdown_pct", item.get("drawdownPct")))
                ratio = float(item.get("ratio"))
            except (TypeError, ValueError):
                continue
            if not (ratio > 0):
                continue
            rows.append(
                {
                    "drawdown_pct": min(30.0, max(0.5, drawdown)),
                    "ratio": ratio,
                }
            )
        if rows:
            rows.sort(key=lambda row: row["drawdown_pct"])
            levels = rows
    preset = str(payload.get("preset") or "").strip().lower()
    if preset not in ADD_PLAN_PRESETS:
        preset = "custom" if levels else "auto"
    if preset == "custom" and not levels:
        preset = "auto"
    if preset != "custom":
        levels = None
    return {"enabled": enabled, "anchor": anchor, "preset": preset, "levels": levels}


def normalize_cash_reserve(payload):
    """纯增量：旧数据缺字段时补默认现金池。"""
    base = {"balance": 0.0, "history": []}
    if not isinstance(payload, dict):
        return base
    balance = _nonnegative_number(payload.get("balance"), 0)
    history = []
    for item in payload.get("history") or []:
        if not isinstance(item, dict):
            continue
        period = str(item.get("period") or "").strip()
        if len(period) != 10 or period[4] != "-" or period[7] != "-":
            continue
        entry_type = str(item.get("type") or "").strip().lower()
        if entry_type not in ("keep", "release", "sell"):
            continue
        amount = _nonnegative_number(item.get("amount"), 0)
        if amount <= 0:
            continue
        history.append({"period": period, "amount": round(amount, 2), "type": entry_type})
    return {"balance": round(balance, 2), "history": history}


def normalize_plan(payload):
    base = dict(DEFAULT_WORKSPACE["plan"])
    if not isinstance(payload, dict):
        return {
            **base,
            "strategy_config": normalize_strategy_config(base.get("strategy_config")),
            "strategy_overrides": {},
            "add_plan": normalize_add_plan(base.get("add_plan")),
            "cash_reserve": normalize_cash_reserve(base.get("cash_reserve")),
            "execution_policy": normalize_execution_policy(base.get("execution_policy")),
            "signal_snapshots": {},
        }
    name = str(payload.get("name") or base["name"]).strip() or base["name"]
    cadence = str(payload.get("cadence") or base["cadence"]).strip().lower()
    if cadence not in ("weekly", "biweekly", "monthly"):
        cadence = base["cadence"]
    try:
        day = int(payload.get("day", base["day"]))
    except (TypeError, ValueError):
        day = base["day"]
    if cadence == "monthly":
        day = min(28, max(1, day))
    else:
        day = min(7, max(1, day))
    strategy = str(payload.get("strategy") or base.get("strategy") or "valuation").strip().lower()
    if strategy not in STRATEGY_IDS:
        strategy = "valuation"
    raw_config = payload.get("strategy_config")
    if raw_config is None:
        raw_config = payload.get("strategyConfig")
    raw_overrides = payload.get("strategy_overrides")
    if raw_overrides is None:
        raw_overrides = payload.get("strategyOverrides")
    raw_add_plan = payload.get("add_plan")
    if raw_add_plan is None:
        raw_add_plan = payload.get("addPlan")
    return {
        "name": name,
        "amount": _positive_number(payload.get("amount")) or 0,
        "capital_base": _nonnegative_number(payload.get("capital_base")),
        "initial_target_pct": _clamp_weight(payload.get("initial_target_pct")),
        "initial_months": _clamp_initial_months(
            payload.get("initial_months", payload.get("initialMonths"))
        ),
        "initial_build_started_at": (
            str(payload.get("initial_build_started_at") or "").strip() or None
        ),
        "initial_build_completed_at": (
            str(payload.get("initial_build_completed_at") or "").strip() or None
        ),
        "cadence": cadence,
        "day": day,
        "note": str(payload.get("note") or "").strip(),
        "strategy": strategy,
        "strategy_config": normalize_strategy_config(raw_config),
        "strategy_overrides": normalize_strategy_overrides(raw_overrides),
        "add_plan": normalize_add_plan(raw_add_plan),
        "trading_cost": normalize_trading_cost(payload.get("trading_cost")),
        "pending_orders": normalize_pending_orders(payload.get("pending_orders")),
        "cash_reserve": normalize_cash_reserve(payload.get("cash_reserve")),
        "execution_policy": normalize_execution_policy(
            payload.get("execution_policy")
            if payload.get("execution_policy") is not None
            else payload.get("executionPolicy")
        ),
        "signal_snapshots": normalize_signal_snapshots(
            payload.get("signal_snapshots")
            if payload.get("signal_snapshots") is not None
            else payload.get("signalSnapshots")
        ),
    }


def normalize_trade_entry(item, kind="buy"):
    if not isinstance(item, dict):
        return None
    digits = "".join(ch for ch in str(item.get("symbol") or "") if ch.isdigit())
    symbol = digits.zfill(6)
    if len(symbol) != 6 or not digits:
        return None
    date = str(item.get("date") or "").strip()
    if len(date) != 10 or date[4] != "-" or date[7] != "-":
        return None
    try:
        year, month, day = (int(part) for part in date.split("-"))
        if not (1990 <= year <= 2100):
            return None
        datetime.date(year, month, day)
    except (TypeError, ValueError):
        return None
    shares = _positive_number(item.get("shares"))
    price = _positive_number(item.get("price"))
    if shares <= 0 or price <= 0:
        return None
    trade_id = str(item.get("id") or "").strip()
    if not trade_id:
        trade_id = f"{kind}_{symbol}_{date}_{int(shares)}_{int(price * 10000)}"
    return {
        "id": trade_id,
        "symbol": symbol,
        "date": date,
        "price": round(price, 6),
        "shares": round(shares, 4),
        "fee": round(_nonnegative_number(item.get("fee")), 2),
        "note": str(item.get("note") or "").strip(),
    }


def normalize_buy_entry(item):
    return normalize_trade_entry(item, "buy")


def normalize_sell_entry(item):
    return normalize_trade_entry(item, "sell")


def normalize_workspace(payload):
    workspace = empty_workspace()
    if not isinstance(payload, dict):
        return workspace

    raw_etfs = payload.get("etfs") or []
    had_any_target = any(
        isinstance(item, dict)
        and (item.get("target_weight") is not None or item.get("targetWeight") is not None)
        for item in raw_etfs
    )

    seen = set()
    etfs = []
    for item in raw_etfs:
        entry = normalize_etf_entry(item)
        if entry and entry["symbol"] not in seen:
            seen.add(entry["symbol"])
            etfs.append(entry)

    # 旧版 workspace 无目标仓位字段时，按种子默认比例补齐
    if etfs and not had_any_target:
        for entry in etfs:
            entry["target_weight"] = float(DEFAULT_TARGET_WEIGHTS.get(entry["symbol"], 0))

    workspace["etfs"] = etfs
    workspace["plan"] = normalize_plan(payload.get("plan"))
    workspace["execution_drafts"] = normalize_execution_drafts(payload.get("execution_drafts"))
    workspace["execution_drafts_meta"] = normalize_execution_drafts_meta(
        payload.get("execution_drafts_meta")
    )
    workspace["decision_history"] = normalize_decision_history(payload.get("decision_history"))

    buys = []
    seen_buy_ids = set()
    for item in payload.get("buys") or []:
        entry = normalize_buy_entry(item)
        if not entry or entry["id"] in seen_buy_ids:
            continue
        seen_buy_ids.add(entry["id"])
        buys.append(entry)
    buys.sort(key=lambda row: (row["date"], row["symbol"], row["id"]), reverse=True)
    workspace["buys"] = buys

    sells = []
    seen_sell_ids = set()
    for item in payload.get("sells") or []:
        entry = normalize_sell_entry(item)
        if not entry or entry["id"] in seen_sell_ids:
            continue
        seen_sell_ids.add(entry["id"])
        sells.append(entry)
    sells.sort(key=lambda row: (row["date"], row["symbol"], row["id"]), reverse=True)
    workspace["sells"] = sells

    if isinstance(payload.get("prefs"), dict):
        workspace["prefs"] = payload["prefs"]

    workspace["version"] = 9
    workspace["updated_at"] = payload.get("updated_at") or as_of(None)
    return workspace


def workspace_has_user_data(workspace):
    if not isinstance(workspace, dict):
        return False
    return bool(workspace.get("etfs") or workspace.get("buys") or workspace.get("sells"))


def get_workspace():
    with WORKSPACE_LOCK:
        from .blob_store import (
            WORKSPACE_BLOB_PATH,
            BlobHydrateError,
            blob_enabled,
            hydrate_local_json,
        )

        if blob_enabled():
            # 已配置 Blob 时读失败必须上抛，避免返回空工作区后被默认种子盖写远端。
            hydrate_local_json(WORKSPACE_BLOB_PATH, WORKSPACE_PATH)
        else:
            try:
                hydrate_local_json(WORKSPACE_BLOB_PATH, WORKSPACE_PATH)
            except BlobHydrateError:
                pass
            except Exception:
                pass
        if not WORKSPACE_PATH.exists():
            return empty_workspace()
        try:
            with WORKSPACE_PATH.open(encoding="utf-8") as handle:
                loaded = json.load(handle)
            return normalize_workspace(loaded)
        except Exception:
            return empty_workspace()


def _workspace_updated_at(payload):
    """Prefer client ISO timestamps so local/server clocks compare fairly."""
    raw = ""
    if isinstance(payload, dict):
        raw = str(payload.get("updated_at") or "").strip()
    if raw:
        candidate = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
        try:
            datetime.datetime.fromisoformat(candidate)
            return raw
        except ValueError:
            pass
    return (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
        + "Z"
    )


def save_workspace(payload):
    with WORKSPACE_LOCK:
        workspace = normalize_workspace(payload)
        workspace["updated_at"] = _workspace_updated_at(payload)
        temp_path = WORKSPACE_PATH.with_suffix(".json.tmp")
        temp_path.write_text(json.dumps(workspace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp_path.replace(WORKSPACE_PATH)
        try:
            from .blob_store import WORKSPACE_BLOB_PATH, persist_json

            persist_json(WORKSPACE_BLOB_PATH, workspace)
        except Exception as exc:
            # 有 Blob 凭证却写失败时向上抛，避免调用方误以为已持久化
            from .blob_store import blob_enabled

            if blob_enabled():
                raise RuntimeError(f"durable workspace save failed: {exc}") from exc
        return workspace


def default_target_weight(symbol):
    return float(DEFAULT_TARGET_WEIGHTS.get(symbol, 0))
