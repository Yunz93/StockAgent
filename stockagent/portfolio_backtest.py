#!/usr/bin/env python3
"""组合历史回测（标准库）：fixed / rebalance / current。

无未来函数：信号 as_of 不得晚于交易日。
跨境/缺历史估值序列时返回 insufficient_history，不输出伪收益。
"""

from __future__ import annotations

import datetime
import math
from typing import Dict, List, Optional, Tuple


MIN_MONTHS = 36
CROSS_BORDER = {"SPX", "NDX", "HSI", "HSTECH"}


def _round2(value: float) -> float:
    return round(float(value) + 1e-12, 2)


def _round4(value: float) -> float:
    return round(float(value) + 1e-12, 4)


def _month_ends(dates: List[str]) -> List[str]:
    """Pick last available trading date in each YYYY-MM."""
    by_month: Dict[str, str] = {}
    for day in dates:
        if len(day) < 7:
            continue
        key = day[:7]
        if key not in by_month or day > by_month[key]:
            by_month[key] = day
    return [by_month[k] for k in sorted(by_month)]


def _lot_buy(cash: float, price: float, lot_size: int, min_commission: float, rate: float, max_fee_ratio: float):
    if not (cash > 0 and price > 0 and lot_size > 0):
        return 0, 0.0, 0.0
    affordable = int(cash // (price * lot_size)) * lot_size
    while affordable >= lot_size:
        notional = affordable * price
        fee = max(min_commission, notional * rate)
        if max_fee_ratio > 0 and notional > 0 and fee / notional > max_fee_ratio + 1e-12:
            affordable -= lot_size
            continue
        if notional + fee <= cash + 1e-9:
            return affordable, _round2(notional), _round2(fee)
        affordable -= lot_size
    return 0, 0.0, 0.0


def _metrics(equity_curve: List[float], fees: float, turnover: float, cash_ratios: List[float]):
    if len(equity_curve) < 2:
        return {
            "ending_value": _round2(equity_curve[-1] if equity_curve else 0),
            "annualized_return_pct": 0.0,
            "max_drawdown_pct": 0.0,
            "annualized_volatility_pct": 0.0,
            "turnover_pct": 0.0,
            "fees": _round2(fees),
            "average_cash_pct": 0.0,
        }
    start = equity_curve[0]
    end = equity_curve[-1]
    months = max(1, len(equity_curve) - 1)
    years = months / 12.0
    total_return = (end / start - 1.0) if start > 0 else 0.0
    ann = (1.0 + total_return) ** (1.0 / years) - 1.0 if years > 0 else 0.0
    peak = equity_curve[0]
    max_dd = 0.0
    rets = []
    for value in equity_curve:
        if value > peak:
            peak = value
        if peak > 0:
            max_dd = max(max_dd, (peak - value) / peak)
    for prev, cur in zip(equity_curve, equity_curve[1:]):
        if prev > 0:
            rets.append(cur / prev - 1.0)
    vol = 0.0
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        vol = math.sqrt(var) * math.sqrt(12)
    avg_cash = sum(cash_ratios) / len(cash_ratios) if cash_ratios else 0.0
    avg_equity = sum(equity_curve) / len(equity_curve)
    turnover_pct = (turnover / avg_equity * 100.0) if avg_equity > 0 else 0.0
    return {
        "ending_value": _round2(end),
        "annualized_return_pct": _round4(ann * 100.0),
        "max_drawdown_pct": _round4(max_dd * 100.0),
        "annualized_volatility_pct": _round4(vol * 100.0),
        "turnover_pct": _round4(turnover_pct),
        "fees": _round2(fees),
        "average_cash_pct": _round4(avg_cash * 100.0),
    }


def _run_strategy(
    *,
    mode: str,
    month_dates: List[str],
    prices: Dict[str, Dict[str, float]],
    pe_series: Dict[str, Dict[str, float]],
    weights: Dict[str, float],
    monthly_budget: float,
    lot_size: int,
    min_commission: float,
    commission_rate: float,
    max_fee_ratio: float,
    pe_bands: List[dict],
):
    symbols = [s for s, w in weights.items() if w > 0]
    shares = {s: 0.0 for s in symbols}
    cash = 0.0
    fees = 0.0
    turnover = 0.0
    equity_curve = []
    cash_ratios = []

    def pe_mult(symbol: str, day: str) -> float:
        if mode == "fixed":
            return 1.0
        series = pe_series.get(symbol) or {}
        # signal must be <= trade day
        usable = [d for d in series if d <= day]
        if not usable:
            return 0.0
        pe = series[max(usable)]
        pct = pe * 100.0 if pe <= 1 else pe
        for band in pe_bands:
            if pct <= float(band.get("max_pct", 100)):
                return float(band.get("mult", 1) or 0)
        return 0.0

    for day in month_dates:
        cash += monthly_budget
        # mark-to-market
        values = {}
        total_pos = 0.0
        for symbol in symbols:
            px = prices.get(symbol, {}).get(day)
            if px is None:
                # carry previous if missing
                earlier = [d for d in prices.get(symbol, {}) if d <= day]
                px = prices[symbol][max(earlier)] if earlier else None
            if px is None or px <= 0:
                values[symbol] = 0.0
                continue
            values[symbol] = shares[symbol] * px
            total_pos += values[symbol]
        equity = total_pos + cash

        if mode == "rebalance" and total_pos > 0:
            # January-like annual rebalance each year-start month (01)
            if day[5:7] == "01":
                for symbol in symbols:
                    target_w = weights[symbol] / 100.0
                    target_val = equity * target_w
                    px = prices.get(symbol, {}).get(day)
                    if not px:
                        earlier = [d for d in prices.get(symbol, {}) if d <= day]
                        px = prices[symbol][max(earlier)] if earlier else None
                    if not px:
                        continue
                    diff = values[symbol] - target_val
                    if diff > px * lot_size:
                        sell_shares = int(diff / px / lot_size) * lot_size
                        sell_shares = min(sell_shares, int(shares[symbol] // lot_size) * lot_size)
                        if sell_shares > 0:
                            notional = sell_shares * px
                            fee = max(min_commission, notional * commission_rate)
                            shares[symbol] -= sell_shares
                            cash += notional - fee
                            fees += fee
                            turnover += notional

        # deploy budget by weights * multiplier
        deploy_budget = cash
        if deploy_budget > 0:
            scores = {}
            for symbol in symbols:
                mult = pe_mult(symbol, day) if mode == "current" else 1.0
                if mode == "rebalance":
                    # prefer underweight
                    tw = weights[symbol] / 100.0
                    aw = (values[symbol] / equity) if equity > 0 else tw
                    gap = max(0.0, tw - aw)
                    scores[symbol] = gap * mult
                else:
                    scores[symbol] = (weights[symbol] / 100.0) * mult
            score_sum = sum(scores.values())
            if score_sum > 0:
                for symbol in symbols:
                    alloc = deploy_budget * (scores[symbol] / score_sum)
                    px = prices.get(symbol, {}).get(day)
                    if not px:
                        earlier = [d for d in prices.get(symbol, {}) if d <= day]
                        px = prices[symbol][max(earlier)] if earlier else None
                    if not px:
                        continue
                    buy_shares, notional, fee = _lot_buy(
                        alloc, px, lot_size, min_commission, commission_rate, max_fee_ratio
                    )
                    if buy_shares > 0:
                        shares[symbol] += buy_shares
                        cash -= notional + fee
                        fees += fee
                        turnover += notional

        total_pos = 0.0
        for symbol in symbols:
            px = prices.get(symbol, {}).get(day)
            if not px:
                earlier = [d for d in prices.get(symbol, {}) if d <= day]
                px = prices[symbol][max(earlier)] if earlier else None
            if px:
                total_pos += shares[symbol] * px
        equity = total_pos + cash
        equity_curve.append(equity)
        cash_ratios.append((cash / equity) if equity > 0 else 1.0)

    return _metrics(equity_curve, fees, turnover, cash_ratios)


def evaluate_backtest_request(payload: dict, *, price_history=None, pe_history=None) -> Tuple[int, dict]:
    """
    price_history: {symbol: [{"date": "YYYY-MM-DD", "close": float}, ...]}
    pe_history: {symbol: [{"date": "YYYY-MM-DD", "pe_percentile": float}, ...]}  # as_of <= trade day
    """
    if not isinstance(payload, dict):
        return 422, {
            "status": "insufficient_history",
            "required_months": MIN_MONTHS,
            "available_by_symbol": {},
            "missing_symbols": [],
            "limitations": ["请求无效"],
        }

    symbols = [str(s).zfill(6)[-6:] for s in (payload.get("symbols") or []) if str(s).strip()]
    weights_raw = payload.get("target_weights") or {}
    weights = {}
    for key, value in weights_raw.items():
        digits = "".join(ch for ch in str(key) if ch.isdigit())
        symbol = digits.zfill(6)
        try:
            w = float(value)
        except (TypeError, ValueError):
            continue
        if len(symbol) == 6 and w > 0:
            weights[symbol] = w
    if not weights:
        for symbol in symbols:
            weights[symbol] = 0
    target_symbols = [s for s, w in weights.items() if w > 0]
    if not target_symbols:
        return 422, {
            "status": "insufficient_history",
            "required_months": MIN_MONTHS,
            "available_by_symbol": {},
            "missing_symbols": [],
            "limitations": ["缺少目标权重大于 0 的品种"],
        }

    price_history = price_history or {}
    pe_history = pe_history or {}
    available_by_symbol = {}
    missing = []
    limitations = []

    prices: Dict[str, Dict[str, float]] = {}
    pe_series: Dict[str, Dict[str, float]] = {}
    month_sets = []

    for symbol in target_symbols:
        rows = price_history.get(symbol) or []
        closes = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            day = str(row.get("date") or "").strip()
            try:
                close = float(row.get("close"))
            except (TypeError, ValueError):
                continue
            if len(day) == 10 and close > 0:
                closes[day] = close
        months = _month_ends(sorted(closes))
        available_by_symbol[symbol] = len(months)
        if len(months) < MIN_MONTHS:
            missing.append(symbol)
        prices[symbol] = closes
        month_sets.append(set(m[:7] for m in months))

        pe_rows = pe_history.get(symbol) or []
        pe_map = {}
        for row in pe_rows:
            if not isinstance(row, dict):
                continue
            day = str(row.get("date") or row.get("as_of") or "").strip()
            try:
                pe = float(row.get("pe_percentile") if row.get("pe_percentile") is not None else row.get("pe_pct"))
            except (TypeError, ValueError):
                continue
            if len(day) == 10 and pe == pe:
                pe_map[day] = pe
        pe_series[symbol] = pe_map

    if missing:
        return 422, {
            "status": "insufficient_history",
            "required_months": MIN_MONTHS,
            "available_by_symbol": available_by_symbol,
            "missing_symbols": missing,
            "limitations": [
                "任一目标品种历史行情不足 36 个完整月",
                "缺少无未来函数的历史估值/评分数据，不能验证当前分档策略",
            ],
        }

    # Require PE coverage for current strategy validation
    pe_missing = [s for s in target_symbols if len(pe_series.get(s) or {}) < MIN_MONTHS]
    if pe_missing:
        return 422, {
            "status": "insufficient_history",
            "required_months": MIN_MONTHS,
            "available_by_symbol": available_by_symbol,
            "missing_symbols": pe_missing,
            "limitations": [
                "缺少无未来函数的历史估值/评分数据，不能验证当前分档策略",
            ],
        }

    common_months = set.intersection(*month_sets) if month_sets else set()
    month_dates = []
    for ym in sorted(common_months):
        # pick min of each symbol's month-end on that ym (aligned)
        candidates = []
        for symbol in target_symbols:
            ends = [d for d in prices[symbol] if d.startswith(ym)]
            if ends:
                candidates.append(max(ends))
        if len(candidates) == len(target_symbols):
            month_dates.append(min(candidates))
    if len(month_dates) < MIN_MONTHS:
        return 422, {
            "status": "insufficient_history",
            "required_months": MIN_MONTHS,
            "available_by_symbol": available_by_symbol,
            "missing_symbols": target_symbols,
            "limitations": ["对齐后的完整月份不足 36"],
        }

    trading_cost = payload.get("trading_cost") or {}
    try:
        lot_size = max(1, int(trading_cost.get("lot_size") or 100))
    except (TypeError, ValueError):
        lot_size = 100
    min_commission = float(trading_cost.get("min_commission") or 5)
    commission_rate = float(trading_cost.get("commission_rate_pct") or 0.03) / 100.0
    max_fee_ratio = float(trading_cost.get("max_fee_ratio_pct") or 0.25) / 100.0
    monthly_budget = float(payload.get("monthly_budget") or 0)
    if not (monthly_budget > 0):
        monthly_budget = 2000.0

    strategy_config = payload.get("strategy_config") or {}
    pe_bands = strategy_config.get("pe_bands") or [
        {"max_pct": 20, "mult": 1.5},
        {"max_pct": 40, "mult": 1.2},
        {"max_pct": 60, "mult": 1.0},
        {"max_pct": 80, "mult": 0.5},
        {"max_pct": 100, "mult": 0},
    ]

    strategies = []
    for mode in ("fixed", "rebalance", "current"):
        metrics = _run_strategy(
            mode=mode,
            month_dates=month_dates[-60:],
            prices=prices,
            pe_series=pe_series,
            weights=weights,
            monthly_budget=monthly_budget,
            lot_size=lot_size,
            min_commission=min_commission,
            commission_rate=commission_rate,
            max_fee_ratio=max_fee_ratio,
            pe_bands=pe_bands,
        )
        strategies.append({"id": mode, **metrics})

    return 200, {
        "status": "ready",
        "as_of": month_dates[-1],
        "months": len(month_dates[-60:]),
        "strategies": strategies,
        "limitations": [
            "策略参数仍属实验",
            "回测结果不是未来收益预测或最优参数证明",
        ],
    }


def run_backtest_from_workspace_symbols(payload: dict) -> Tuple[int, dict]:
    """API facade：当前仓库若无完整估值历史，直接 insufficient_history。"""
    # Prefer explicit histories in payload for tests; production path is conservative.
    if payload.get("price_history") is not None or payload.get("pe_history") is not None:
        return evaluate_backtest_request(
            payload,
            price_history=payload.get("price_history") or {},
            pe_history=payload.get("pe_history") or {},
        )

    # Without injectable history series we cannot guarantee no-lookahead PE.
    symbols = []
    weights = payload.get("target_weights") or {}
    for key, value in weights.items():
        digits = "".join(ch for ch in str(key) if ch.isdigit())
        symbol = digits.zfill(6)
        try:
            w = float(value)
        except (TypeError, ValueError):
            w = 0
        if len(symbol) == 6 and w > 0:
            symbols.append(symbol)
    return 422, {
        "status": "insufficient_history",
        "required_months": MIN_MONTHS,
        "available_by_symbol": {s: 0 for s in symbols},
        "missing_symbols": symbols,
        "limitations": [
            "缺少无未来函数的历史估值/评分数据，不能验证当前分档策略",
            "策略参数仍属实验",
        ],
    }
