"""Orchestration and caching for the ETF analysis endpoint."""

from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
import time

from .dividend_analysis import analyze_dividend_data, annualized_tracking_error
from .dividend_registry import (
    _normalize_etf_symbol,
    proxy_valuation_note,
    resolve_analysis_settings,
    unsupported_analysis_payload,
    valuation_framework_applicable,
)
from .dividend_sources import (
    fetch_danjuan_valuation,
    fetch_etf_as_index_history,
    fetch_eastmoney_fund_profile,
    fetch_etf_quote,
    fetch_index_history,
    fetch_legulegu_index_valuation,
    fetch_treasury_yield_history,
    fill_missing_pe,
)
from .gold_macro import get_gold_macro
from .symbols import as_of

DIVIDEND_CACHE = {}

def clear_dividend_cache():
    DIVIDEND_CACHE.clear()

_LITE_DROP_KEYS = ("sources", "disclaimer", "note_text", "commentary")


def slim_dividend_payload(payload):
    """预取用瘦身载荷：保留评分/估值/技术面，去掉大图与长文。"""
    if not isinstance(payload, dict):
        return payload
    slim = copy.copy(payload)
    for key in _LITE_DROP_KEYS:
        slim.pop(key, None)
    chart = payload.get("chart")
    if isinstance(chart, dict):
        slim_chart = {
            key: chart.get(key)
            for key in ("name", "symbol", "price_basis", "available_from", "available_to")
        }
        points = chart.get("points") or []
        if len(points) > 60:
            step = max(1, len(points) // 60)
            slim_chart["points"] = points[::step][:60]
        else:
            slim_chart["points"] = points
        slim_chart["markers"] = []
        slim["chart"] = slim_chart
    backtest = payload.get("backtest")
    if isinstance(backtest, dict):
        slim["backtest"] = {
            key: backtest.get(key)
            for key in ("samples", "avg_return_pct", "win_rate_pct", "label")
            if key in backtest
        }
    slim["lite"] = True
    return slim


def missing_danjuan_note(has_daily_pe):
    """蛋卷未收录且兜底估值也失败时的降级说明。"""
    if has_daily_pe:
        return (
            "蛋卷暂未收录该指数，估值兜底也不可用：PE 采用指数源每日序列并自算近 10 年分位；"
            "股息率缺失，股债利差与 PB 暂缺"
        )
    return "蛋卷暂未收录该指数，且指数源无每日 PE：估值与股债利差暂缺，本页以行情技术面为主"


def _apply_legulegu_valuation_fallback(settings, errors):
    """蛋卷缺失/失败时用乐咕乐股（中证口径）补 PE/PB/股息率。成功则清除 valuation 降级。"""
    try:
        valuation = fetch_legulegu_index_valuation(settings.get("index_code"))
    except Exception as exc:
        prior = errors.get("valuation")
        errors["valuation"] = f"{prior}；估值兜底失败：{exc}" if prior else f"估值兜底不可用：{exc}"
        return None
    errors.pop("valuation", None)
    return valuation


def get_dividend_dashboard(refresh=False, symbol=None, lite=False):
    """日度决策仪表盘。

    symbol 为空时走全局 dividend 设置。
    传入 ETF 代码时：注册表/名称推断走完整指数分析；否则用 ETF 行情兜底。
    """
    requested = _normalize_etf_symbol(symbol) if symbol else ""
    if symbol and not requested:
        return unsupported_analysis_payload(str(symbol or ""))

    # 先拿行情名称，便于名称推断（如「黄金ETF」）
    etf_quote = None
    etf_name = ""
    if requested:
        try:
            etf_quote = fetch_etf_quote(requested)
            etf_name = etf_quote.get("name") or ""
        except Exception:
            etf_quote = None

    settings = resolve_analysis_settings(requested or None, name=etf_name)
    if settings is None:
        return unsupported_analysis_payload(requested)

    if etf_name and not settings.get("etf_name"):
        settings["etf_name"] = etf_name
    if etf_quote is not None:
        etf_quote["symbol_name"] = settings.get("etf_name") or etf_quote.get("name") or requested

    cache_key = settings.get("etf_symbol") or settings.get("index_code") or "default"
    now = time.time()
    cached = DIVIDEND_CACHE.get(cache_key)
    if not refresh and cached and cached.get("payload") and cached.get("expires", 0) > now:
        payload = cached["payload"]
        return slim_dividend_payload(payload) if lite else payload

    errors = {}
    proxy = settings.get("analysis_mode") == "etf_proxy"
    index_source = "腾讯行情"
    index_rows = None
    etf_history_rows = None
    valuation = None
    not_applicable = {}
    danjuan_code = str(settings.get("danjuan_code") or "").strip()
    asset_class = settings.get("asset_class")
    treasury_rows = []
    fund_profile = None

    def _load_index():
        if proxy:
            return fetch_etf_as_index_history(settings.get("etf_symbol") or requested)
        return fetch_index_history(
            settings.get("index_code", "H30269"),
            preferred_source=settings.get("history_source"),
            market_symbol=settings.get("history_symbol"),
        )

    def _load_valuation():
        local_errors = {}
        local_na = {}
        local_valuation = None
        if danjuan_code:
            try:
                local_valuation = fetch_danjuan_valuation(danjuan_code)
            except Exception as exc:
                local_errors["valuation"] = f"蛋卷估值不可用，改用指数源 PE：{exc}"
                local_valuation = _apply_legulegu_valuation_fallback(settings, local_errors)
        elif proxy and not valuation_framework_applicable(asset_class):
            local_na["valuation"] = proxy_valuation_note(settings.get("etf_name") or etf_name)
        elif proxy:
            local_errors["valuation"] = proxy_valuation_note(settings.get("etf_name") or etf_name)
        else:
            local_errors["valuation"] = "pending_danjuan_note"
            local_valuation = _apply_legulegu_valuation_fallback(settings, local_errors)
        return local_valuation, local_errors, local_na

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {
            pool.submit(_load_index): "index",
            pool.submit(_load_valuation): "valuation",
            pool.submit(fetch_treasury_yield_history): "treasury",
            pool.submit(fetch_eastmoney_fund_profile, settings.get("etf_symbol") or requested): "fund_profile",
        }
        if not proxy:
            futures[pool.submit(fetch_etf_as_index_history, settings.get("etf_symbol") or requested)] = "etf_history"
        if etf_quote is None:
            futures[pool.submit(fetch_etf_quote, settings.get("etf_symbol", "512890"))] = "etf_quote"

        for future in as_completed(futures):
            kind = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                if kind == "index":
                    return {
                        "supported": True,
                        "error": f"{'ETF' if proxy else '指数'}历史数据获取失败：{exc}",
                        "name": settings.get("index_name") or settings.get("etf_name") or "ETF",
                        "symbol": settings.get("etf_symbol"),
                        "analysis_mode": settings.get("analysis_mode") or "index",
                        "updated_at": as_of(None),
                    }
                if kind == "etf_history":
                    errors["etf_history"] = f"ETF 历史价格暂不可用，走势图临时使用指数点位：{exc}"
                elif kind == "valuation":
                    errors["valuation"] = f"估值获取失败：{exc}"
                elif kind == "treasury":
                    errors["bond"] = f"国债收益率不可用：{exc}"
                elif kind == "etf_quote":
                    errors["etf"] = f"ETF 实时行情不可用：{exc}"
                elif kind == "fund_profile":
                    errors["fund_profile"] = f"基金规模与费率暂不可用：{exc}"
                continue

            if kind == "index":
                index_rows, index_source = result
            elif kind == "etf_history":
                etf_history_rows, _ = result
            elif kind == "valuation":
                valuation, val_errors, val_na = result
                errors.update(val_errors)
                not_applicable.update(val_na)
            elif kind == "treasury":
                treasury_rows = result or []
            elif kind == "etf_quote":
                etf_quote = result
                if etf_quote is not None:
                    etf_quote["symbol_name"] = (
                        settings.get("etf_name") or etf_quote.get("name") or settings.get("etf_symbol")
                    )
            elif kind == "fund_profile":
                fund_profile = result

    if index_rows is None:
        return {
            "supported": True,
            "error": f"{'ETF' if proxy else '指数'}历史数据获取失败",
            "name": settings.get("index_name") or settings.get("etf_name") or "ETF",
            "symbol": settings.get("etf_symbol"),
            "analysis_mode": settings.get("analysis_mode") or "index",
            "updated_at": as_of(None),
        }

    if proxy:
        etf_history_rows = index_rows

    if errors.get("valuation") == "pending_danjuan_note":
        has_daily_pe = any(row.get("pe") is not None for row in index_rows[-30:])
        errors["valuation"] = missing_danjuan_note(has_daily_pe)

    if valuation and valuation.get("pe") is not None:
        fill_missing_pe(index_rows, valuation.get("pe"))

    if etf_quote is not None:
        product_quality = dict(etf_quote.get("product_quality") or {})
        if fund_profile:
            product_quality.update({key: value for key, value in fund_profile.items() if value is not None})
        if not proxy and etf_history_rows:
            tracking_error = annualized_tracking_error(etf_history_rows, index_rows)
            if tracking_error is not None:
                product_quality["tracking_error_pct"] = tracking_error
                product_quality["tracking_error_window"] = "近一年"
        etf_quote["product_quality"] = product_quality

    payload = analyze_dividend_data(
        index_rows,
        valuation,
        treasury_rows,
        etf_quote,
        settings,
        chart_rows=etf_history_rows,
    )
    payload["supported"] = True
    payload["symbol"] = settings.get("etf_symbol")
    payload["analysis_mode"] = settings.get("analysis_mode") or "index"
    if payload.get("index"):
        payload["index"]["source"] = index_source
        if proxy:
            payload["index"]["source_url"] = "https://gu.qq.com/"
            payload["index"]["note"] = "未收录指数映射，使用 ETF 自身行情近似"
        elif index_source != "中证指数官网":
            payload["index"]["source_url"] = (
                "https://finance.sina.com.cn/" if index_source == "新浪财经" else "https://finance.qq.com/"
            )
            # 腾讯/新浪日线本来就无每日 PE；有点位估值时已用价格回推填历史序列。
            # 这是方法近似，不是缺数——写入 index.note，避免「部分数据降级」横幅误伤港美/创业板。
            if "valuation" not in errors and valuation and valuation.get("pe") is not None:
                payload["index"]["note"] = (
                    f"日线来自{index_source}（无每日 PE）；"
                    "历史 PE 按当前估值随价格回推，利差分位与回测为近似"
                )
            elif "valuation" not in errors:
                errors["index_pe"] = (
                    f"该指数日线来自{index_source}，无每日 PE；"
                    "且当前估值也不可用，利差分位与回测暂缺"
                )
    if str(asset_class or "").strip().lower() == "commodity":
        try:
            payload["gold_macro"] = get_gold_macro(refresh=refresh)
        except Exception as exc:
            payload["gold_macro"] = {
                "degraded": True,
                "mult": 1.0,
                "band": "宏观暂缺",
                "hint": f"黄金宏观层不可用：{exc}",
                "score": None,
            }

    if errors:
        payload["errors"] = errors
    if not_applicable:
        payload["not_applicable"] = not_applicable
    index_source_url = {
        "中证指数官网": "https://www.csindex.com.cn/",
        "新浪财经": "https://finance.sina.com.cn/",
        "腾讯行情": "https://gu.qq.com/",
    }.get(index_source, "https://gu.qq.com/")
    valuation_source = (valuation or {}).get("source") or ""
    valuation_source_url = (valuation or {}).get("source_url") or "https://danjuanfunds.com/dj-valuation-table-detail"
    if "乐咕" in valuation_source:
        valuation_role = {
            "name": "乐咕乐股",
            "url": valuation_source_url,
            "role": "蛋卷未收录时的 PE/PB/股息率兜底（中证口径加权）",
        }
    else:
        valuation_role = {
            "name": "蛋卷基金",
            "url": "https://danjuanfunds.com/dj-valuation-table-detail",
            "role": "PE/PB/股息率与近10年PE分位",
        }
    payload["sources"] = [
        {
            "name": index_source,
            "url": index_source_url,
            "role": "ETF 日线（兜底分析）" if proxy else ("指数日线与每日 PE" if index_source == "中证指数官网" else "指数日线（无每日 PE）"),
        },
        valuation_role,
        {"name": "东方财富数据中心", "url": "https://data.eastmoney.com/cjsj/zmgzsyl.html", "role": "中国十年期国债收益率"},
        {"name": "腾讯行情", "url": "https://gu.qq.com/", "role": "ETF 实时价与历史价格"},
        {
            "name": "东方财富基金档案",
            "url": f"https://fundf10.eastmoney.com/jbgk_{settings.get('etf_symbol') or requested}.html",
            "role": "基金规模、管理费与托管费",
        },
    ]
    if payload.get("gold_macro"):
        payload["sources"].append(
            {
                "name": "东方财富（美债/美元指数）",
                "url": "https://data.eastmoney.com/cjsj/zmgzsyl.html",
                "role": "黄金宏观层：美债10年收益率 + 美元指数",
            }
        )

    ttl = int(settings.get("cache_seconds", 1800))
    DIVIDEND_CACHE[cache_key] = {"payload": payload, "expires": now + ttl}
    return slim_dividend_payload(payload) if lite else payload
