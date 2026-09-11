#!/usr/bin/env python3
"""ETF 行情与历史 K 线：腾讯行情主源，东方财富补齐/兜底，Yahoo/东财历史。"""

import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from .defaults import *
from .state import *
from .config_store import quote_settings
from .symbols import *
from .market_time import *


# ---------------------------------------------------------------------------
# ETF 批量行情
# ---------------------------------------------------------------------------

def _quote_symbol_cache_key(symbol):
    return f"sym:{symbol}"


def _store_quote_symbols(quotes, ttl):
    """按标的写入行情缓存，供批量/单只路径共享。"""
    now = time.time()
    for quote in quotes or []:
        symbol = str((quote or {}).get("symbol") or "").strip()
        if not symbol:
            continue
        QUOTE_MARKET_CACHE[_quote_symbol_cache_key(symbol)] = {
            "expires": now + ttl,
            "quote": quote,
        }


def get_etf_quotes(symbols):
    """按代码列表返回 A 股场内 ETF 行情（带名称）。

    缓存按标的拆分：主页批量拉取后，详情单只可直接命中。
    """
    cleaned = []
    seen = set()
    for raw in symbols or []:
        symbol = normalize_symbol(raw, "A")
        if not symbol or not symbol.isdigit() or len(symbol) != 6 or symbol in seen:
            continue
        seen.add(symbol)
        cleaned.append(symbol)
    if not cleaned:
        return {"quotes": [], "error": "需要至少一个有效的 6 位 ETF 代码", "updated_at": as_of(None)}

    now = time.time()
    quotes_by_symbol = {}
    missing = []
    for symbol in cleaned:
        entry = QUOTE_MARKET_CACHE.get(_quote_symbol_cache_key(symbol))
        if entry and entry.get("expires", 0) > now and entry.get("quote"):
            quotes_by_symbol[symbol] = entry["quote"]
        else:
            missing.append(symbol)

    provider = quote_settings().get("provider_name", "腾讯行情")
    source_url = "https://gu.qq.com/"
    error = None
    if missing:
        stocks = [(symbol, "A", infer_yahoo_symbol(symbol, "A")) for symbol in missing]
        response = fetch_quotes_for_stocks(stocks, "A")
        provider = response.get("provider") or provider
        source_url = response.get("source_url") or source_url
        error = response.get("error")
        ttl = 60 if response.get("quotes") and not response.get("error") else 10
        _store_quote_symbols(response.get("quotes"), ttl)
        for quote in response.get("quotes") or []:
            symbol = str((quote or {}).get("symbol") or "").strip()
            if symbol:
                quotes_by_symbol[symbol] = quote

    quotes = [quotes_by_symbol[symbol] for symbol in cleaned if symbol in quotes_by_symbol]
    payload = {
        "quotes": quotes,
        "symbols": cleaned,
        "provider": provider,
        "source_url": source_url,
        "updated_at": as_of(None),
        "requested": len(cleaned),
        "returned": len(quotes),
        "cache_hits": len(cleaned) - len(missing),
    }
    if error and not quotes:
        payload["error"] = error
    elif error:
        payload["warning"] = error
    # 兼容旧的整串 cache key（AI 快照等仍可能按批读取）
    batch_key = ",".join(cleaned)
    QUOTE_MARKET_CACHE[batch_key] = {
        "expires": now + (60 if quotes else 10),
        "payload": payload,
    }
    return payload



def fetch_quotes_for_stocks(stocks, market=None):
    if not stocks:
        return {
            "quotes": [],
            "provider": quote_settings().get("provider_name", "腾讯行情"),
            "source_url": "https://gu.qq.com/",
            "updated_at": as_of(None),
            "market": market,
            "error": "标的列表为空",
        }
    try:
        by_tencent = fetch_tencent_quotes(stocks)
        quotes = []
        missing = []
        for symbol, item_market, yahoo_symbol in stocks:
            item = by_tencent.get((item_market, symbol))
            if not item:
                missing.append((symbol, item_market, yahoo_symbol))
                continue
            quotes.append(quote_from_tencent_item(symbol, item_market, yahoo_symbol, item))
        filled = 0
        if missing:
            try:
                by_eastmoney = fetch_eastmoney_quotes(missing)
                for symbol, item_market, yahoo_symbol in missing:
                    item = by_eastmoney.get((item_market, symbol))
                    if not item:
                        continue
                    quote = quote_from_eastmoney_item(symbol, item_market, yahoo_symbol, item)
                    quote["note"] = "腾讯未返回该标的，东方财富补齐"
                    quotes.append(quote)
                    filled += 1
            except Exception:
                pass
        response = {
            "quotes": quotes,
            "provider": quote_settings().get("provider_name", "腾讯行情"),
            "source_url": "https://gu.qq.com/",
            "updated_at": as_of(None),
            "market": market,
            "requested": len(stocks),
            "returned": len(quotes),
        }
        if filled:
            response["provider"] = "腾讯行情 + 东方财富补齐"
            response["fallback_filled"] = filled
        if not quotes:
            raise RuntimeError("腾讯行情未返回任何有效行情")
        return response
    except Exception as exc:
        return get_eastmoney_fallback_quotes(exc, stocks, market)


def get_eastmoney_fallback_quotes(primary_error, stocks, market=None):
    try:
        by_eastmoney = fetch_eastmoney_quotes(stocks)
        quotes = []
        for symbol, item_market, yahoo_symbol in stocks:
            item = by_eastmoney.get((item_market, symbol))
            if item:
                quote = quote_from_eastmoney_item(symbol, item_market, yahoo_symbol, item)
                quote["note"] = f"腾讯行情不可用，东方财富兜底；主源错误：{primary_error}"
                quotes.append(quote)
        return {
            "quotes": quotes,
            "provider": "东方财富（兜底）",
            "source_url": "https://quote.eastmoney.com/",
            "warning": str(primary_error),
            "updated_at": as_of(None),
            "market": market,
            "requested": len(stocks),
            "returned": len(quotes),
        }
    except Exception as fallback_error:
        return {
            "quotes": [],
            "provider": quote_settings().get("provider_name", "腾讯行情"),
            "error": f"腾讯行情：{primary_error}；东方财富：{fallback_error}",
            "updated_at": as_of(None),
            "market": market,
        }


def get_single_quote(symbol, market="A"):
    if not symbol or market not in {"A", "HK", "US"}:
        return {"error": "需要有效的 market 与 symbol", "quote": None}
    symbol, market, yahoo_symbol = stock_tuple(symbol, market)
    payload = fetch_quotes_for_stocks([(symbol, market, yahoo_symbol)], market)
    quotes = payload.get("quotes") or []
    if not quotes:
        return {"error": payload.get("error") or "未找到行情", "quote": None}
    quote = quotes[0]
    return {
        "quote": quote,
        "meta": {
            "symbol": symbol,
            "market": market,
            "name": quote.get("name") or symbol,
            "currency": {"A": "CNY", "HK": "HKD", "US": "USD"}[market],
        },
        "provider": quote.get("provider"),
        "updated_at": as_of(None),
    }


# ---------------------------------------------------------------------------
# 历史 K 线（Yahoo 主源，东方财富兜底）
# ---------------------------------------------------------------------------

def get_price_history(symbol, market="A", range_key="1y"):
    if not symbol or market not in {"A", "HK", "US"}:
        return {"error": "需要有效的 market 与 symbol", "points": []}
    symbol, market, yahoo_symbol = stock_tuple(symbol, market)
    allowed = {"1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y", "5y": "5y"}
    yahoo_range = allowed.get(range_key, "1y")
    cache_key = f"{market}:{symbol}:{yahoo_range}"
    now = time.time()
    cached = HISTORY_CACHE.get(cache_key)
    if cached and cached["expires"] > now:
        return cached["payload"]

    errors = []
    points = []
    provider_name = "Yahoo Finance"
    source_url = f"https://finance.yahoo.com/quote/{urllib.parse.quote(yahoo_symbol)}"

    url = (
        "https://query2.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(yahoo_symbol, safe='')}?interval=1d&range={yahoo_range}"
    )
    try:
        opener = get_yahoo_bootstrap_opener()
        request = urllib.request.Request(url, headers=yahoo_headers())
        with opener.open(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        chart_result = (payload.get("chart") or {}).get("result") or []
        if not chart_result:
            raise RuntimeError("Yahoo chart 无数据")
        result = chart_result[0]
        timestamps = result.get("timestamp") or []
        closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
        for ts, close in zip(timestamps, closes):
            if close is None:
                continue
            points.append(
                {
                    "date": time.strftime("%Y-%m-%d", time.gmtime(ts)),
                    "close": round(float(close), 4),
                }
            )
        if not points:
            raise RuntimeError("Yahoo chart 无有效收盘价")
    except Exception as exc:
        errors.append(f"Yahoo: {exc}")
        fallbacks = (
            ("腾讯行情", "https://gu.qq.com/", fetch_tencent_history),
            ("东方财富", "https://quote.eastmoney.com/", fetch_eastmoney_history),
        )
        points = []
        for name, url_root, fetcher in fallbacks:
            try:
                points = fetcher(symbol, market, yahoo_symbol, range_key)
                if not points:
                    raise RuntimeError("K 线无数据")
                provider_name = name
                source_url = url_root
                break
            except Exception as fallback_error:
                errors.append(f"{name}: {fallback_error}")
        if not points:
            return {
                "symbol": symbol,
                "market": market,
                "yahoo_symbol": yahoo_symbol,
                "range": range_key,
                "points": [],
                "error": "；".join(errors),
                "updated_at": as_of(None),
            }

    response_payload = {
        "symbol": symbol,
        "market": market,
        "yahoo_symbol": yahoo_symbol,
        "range": range_key,
        "points": points,
        "provider": provider_name,
        "source_url": source_url,
        "updated_at": as_of(None),
    }
    if errors:
        response_payload["warning"] = "；".join(errors)
    HISTORY_CACHE[cache_key] = {"expires": now + 300, "payload": response_payload}
    return response_payload


def history_limit(range_key):
    return {"1m": 30, "3m": 90, "6m": 180, "1y": 260, "5y": 1300}.get(range_key, 260)


def fetch_tencent_history(symbol, market, yahoo_symbol, range_key="1y"):
    """腾讯前复权日 K（A/HK 可用）。返回 [{date, close}] 升序。"""
    code = tencent_code(symbol, market, yahoo_symbol)
    limit = history_limit(range_key)
    url = (
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
        + urllib.parse.urlencode({"param": f"{code},day,,,{limit},qfq"})
    )
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": YAHOO_UA,
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://gu.qq.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = (payload.get("data") or {}).get(code) or {}
    rows = data.get("qfqday") or data.get("day") or []
    points = []
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        try:
            points.append({"date": str(row[0]), "close": round(float(row[2]), 4)})
        except (TypeError, ValueError):
            continue
    return points[-limit:]


def fetch_eastmoney_history(symbol, market, yahoo_symbol, range_key="1y"):
    secid = eastmoney_secid(symbol, market, yahoo_symbol)
    limit = history_limit(range_key)
    params = {
        "secid": secid,
        "klt": "101",
        "fqt": "1",
        "lmt": str(limit),
        "end": "20500101",
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }
    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": YAHOO_UA,
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://quote.eastmoney.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    klines = ((payload.get("data") or {}).get("klines")) or []
    points = []
    for row in klines:
        parts = str(row).split(",")
        if len(parts) < 3:
            continue
        try:
            points.append({"date": parts[0], "close": round(float(parts[2]), 4)})
        except (TypeError, ValueError):
            continue
    return points[-limit:]


# ---------------------------------------------------------------------------
# 腾讯行情
# ---------------------------------------------------------------------------

def fetch_tencent_quotes(stocks):
    result = {}
    batch_size = int(quote_settings().get("batch_size", 80))
    for index in range(0, len(stocks), batch_size):
        batch = stocks[index : index + batch_size]
        codes = [tencent_code(symbol, market, yahoo) for symbol, market, yahoo in batch]
        url = "https://qt.gtimg.cn/q=" + ",".join(codes)
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": YAHOO_UA,
                "Accept": "text/plain,*/*",
                "Referer": "https://gu.qq.com/",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            text = response.read().decode("gb18030", errors="replace")
        parsed = parse_tencent_response(text)
        for symbol, market, yahoo in batch:
            item = parsed.get(tencent_code(symbol, market, yahoo).lower())
            if item:
                result[(market, symbol)] = item
        if index + batch_size < len(stocks):
            time.sleep(0.05)
    return result


def parse_tencent_response(text):
    parsed = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        variable, raw = line.split("=", 1)
        code = variable.removeprefix("v_").strip().lower()
        value = raw.strip().strip(";").strip('"')
        fields = value.split("~")
        if len(fields) > 6 and fields[3] not in ("", "0"):
            parsed[code] = fields
    return parsed


def tencent_numeric(fields, *indexes):
    """Return the first parseable numeric field; skip blanks and non-numeric labels."""
    for index in indexes:
        value = clean_market_value(field_at(fields, index))
        if value is not None:
            return value
    return None


def tencent_valuation_fields(market, fields):
    """
    Tencent qt.gtimg.cn field layout differs by market after the shared price block.

    Shared: [3]=price, [32]=change%, [36]/[6]=volume, [39]=PE, [44]/[45]=mkt cap (亿元)
    A:      [46]=PB, [67]/[68]≈52w high/low
    HK:     [46]=ticker text, [57]=PE(alt), [58]=PB, [48]/[49]=52w high/low
    US:     [46]=company name, [51]=PB, [48]/[49]=52w high/low
    """
    market_cap_yi = tencent_numeric(fields, 45, 44)
    market_cap = market_cap_yi * 100_000_000 if market_cap_yi is not None else None
    if market == "A":
        return {
            "market_cap": market_cap,
            "pe": tencent_numeric(fields, 39),
            "pb": tencent_numeric(fields, 46),
            "week_52_high": tencent_numeric(fields, 67),
            "week_52_low": tencent_numeric(fields, 68),
        }
    if market == "HK":
        return {
            "market_cap": market_cap,
            "pe": tencent_numeric(fields, 57, 39),
            "pb": tencent_numeric(fields, 58),
            "week_52_high": tencent_numeric(fields, 48),
            "week_52_low": tencent_numeric(fields, 49),
        }
    return {
        "market_cap": market_cap,
        "pe": tencent_numeric(fields, 39),
        "pb": tencent_numeric(fields, 51),
        "week_52_high": tencent_numeric(fields, 48),
        "week_52_low": tencent_numeric(fields, 49),
    }


def quote_from_tencent_item(symbol, market, yahoo_symbol, fields):
    market_time = parse_market_timestamp(field_at(fields, 30), market)
    valuation = tencent_valuation_fields(market, fields)
    product_quality = {}
    if market == "A" and str(field_at(fields, 61) or "").strip().upper() == "ETF":
        bid = clean_market_value(field_at(fields, 9))
        ask = clean_market_value(field_at(fields, 19))
        midpoint = (bid + ask) / 2 if bid and ask else None
        spread = ((ask - bid) / midpoint * 100) if midpoint and ask >= bid else None
        fund_size_yi = valuation["market_cap"] / 100_000_000 if valuation["market_cap"] else None
        product_quality = {
            "fund_size_yi": round(fund_size_yi, 2) if fund_size_yi is not None else None,
            "premium_discount_pct": tencent_numeric(fields, 77),
            "bid_ask_spread_pct": round(spread, 4) if spread is not None else None,
            "iopv": tencent_numeric(fields, 78),
        }
    return {
        "symbol": symbol,
        "market": market,
        "yahoo_symbol": yahoo_symbol,
        "name": field_at(fields, 1) or symbol,
        "price": clean_market_value(field_at(fields, 3)),
        "change_pct": clean_market_value(field_at(fields, 32)),
        "volume": clean_market_value(field_at(fields, 36) or field_at(fields, 6)),
        "market_cap": valuation["market_cap"],
        "pe": valuation["pe"],
        "pb": valuation["pb"],
        "ps": None,
        "dividend_yield": None,
        "week_52_low": valuation["week_52_low"],
        "week_52_high": valuation["week_52_high"],
        "earnings_date": None,
        "ex_dividend_date": None,
        "as_of": format_market_time(market_time, market),
        "market_timestamp": market_time,
        "provider": quote_settings().get("provider_name", "腾讯行情"),
        "source_url": "https://gu.qq.com/",
        "note": quote_settings().get("note", ""),
        "product_quality": product_quality,
    }


# ---------------------------------------------------------------------------
# 东方财富行情
# ---------------------------------------------------------------------------

def eastmoney_quote_hosts():
    return ("push2delay.eastmoney.com", "push2.eastmoney.com")


def fetch_eastmoney_ulist_rows(secids, fields, batch_size=40):
    rows = []
    for index in range(0, len(secids), batch_size):
        batch = secids[index : index + batch_size]
        params = urllib.parse.urlencode(
            {
                "secids": ",".join(batch),
                "fields": fields,
                "fltt": 2,
                "invt": 2,
            }
        )
        last_error = None
        for host in eastmoney_quote_hosts():
            url = f"https://{host}/api/qt/ulist.np/get?{params}"
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": YAHOO_UA,
                    "Accept": "application/json,text/plain,*/*",
                    "Referer": "https://quote.eastmoney.com/",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=18) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                diff = (payload.get("data") or {}).get("diff") or []
                rows.extend(diff.values() if isinstance(diff, dict) else diff)
                last_error = None
                break
            except Exception as exc:
                last_error = exc
        if last_error and not rows:
            raise last_error
        time.sleep(0.03)
    return rows


def fetch_eastmoney_quotes(stocks):
    # ulist.np uses clist-style fields (f2/f3/...), not stock/get fields (f43/f170/...).
    fields = ",".join(["f2", "f3", "f5", "f9", "f12", "f14", "f20", "f23", "f124"])
    prepared = []
    for symbol, market, yahoo in stocks:
        secid = eastmoney_secid(symbol, market, yahoo)
        if secid:
            prepared.append((symbol, market, yahoo, secid))
    if not prepared:
        return {}
    rows = fetch_eastmoney_ulist_rows([item[3] for item in prepared], fields, batch_size=20)
    by_code = {}
    for item in rows:
        code = str(item.get("f12", "")).upper()
        if not code:
            continue
        by_code[code] = item
        by_code[code.lstrip("0") or "0"] = item
    result = {}
    for symbol, market, _, _ in prepared:
        key = symbol.upper()
        item = by_code.get(key) or by_code.get(key.lstrip("0") or "0")
        if item:
            result[(market, symbol)] = item
    return result


def quote_from_eastmoney_item(symbol, market, yahoo_symbol, item):
    timestamp = item.get("f124")
    return {
        "symbol": symbol,
        "market": market,
        "yahoo_symbol": yahoo_symbol,
        "name": item.get("f14") or symbol,
        "price": clean_market_value(item.get("f2")),
        "change_pct": clean_market_value(item.get("f3")),
        "volume": clean_market_value(item.get("f5")),
        "market_cap": clean_market_value(item.get("f20")),
        "pe": clean_market_value(item.get("f9")),
        "pb": clean_market_value(item.get("f23")),
        "ps": None,
        "dividend_yield": None,
        "week_52_low": None,
        "week_52_high": None,
        "earnings_date": None,
        "ex_dividend_date": None,
        "as_of": format_market_time(timestamp, market) if timestamp else as_of(timestamp),
        "market_timestamp": timestamp,
        "provider": "东方财富（兜底）",
        "source_url": "https://quote.eastmoney.com/",
        "note": quote_settings().get("note", ""),
    }


# ---------------------------------------------------------------------------
# 数据准确性交叉校验（供 /api/health 使用）
# ---------------------------------------------------------------------------

def probe_quote_accuracy():
    """腾讯 vs 东方财富对高流动性 ETF 做价格交叉校验，防字段映射回归。"""
    samples = [
        ("512890", "A", "512890.SS"),
        ("510300", "A", "510300.SS"),
    ]
    checks = []
    for symbol, market, yahoo in samples:
        row = {"symbol": symbol, "market": market, "ok": False}
        try:
            by_tencent = fetch_tencent_quotes([(symbol, market, yahoo)])
            tencent_item = by_tencent.get((market, symbol))
            if not tencent_item:
                row["error"] = "腾讯无数据"
                checks.append(row)
                continue
            tencent_quote = quote_from_tencent_item(symbol, market, yahoo, tencent_item)
            row["tencent_price"] = tencent_quote.get("price")
            row["tencent_as_of"] = tencent_quote.get("as_of")
            by_eastmoney = fetch_eastmoney_quotes([(symbol, market, yahoo)])
            east_item = by_eastmoney.get((market, symbol))
            if not east_item:
                row["ok"] = tencent_quote.get("price") is not None
                row["note"] = "东方财富无对照样本，仅校验腾讯价格"
                checks.append(row)
                continue
            east_quote = quote_from_eastmoney_item(symbol, market, yahoo, east_item)
            row["eastmoney_price"] = east_quote.get("price")
            row["ok"] = prices_agree(tencent_quote.get("price"), east_quote.get("price"), rel=0.02, abs_tol=0.02)
            if not row["ok"]:
                row["error"] = "腾讯与东方财富价格偏差过大"
        except Exception as exc:
            row["error"] = str(exc)
        checks.append(row)
    return {
        "ok": all(item.get("ok") for item in checks),
        "checks": checks,
    }


def prices_agree(left, right, rel=0.02, abs_tol=0.5):
    if left is None or right is None:
        return False
    try:
        left = float(left)
        right = float(right)
    except (TypeError, ValueError):
        return False
    if left == 0 and right == 0:
        return True
    scale = max(abs(left), abs(right), 1e-9)
    return abs(left - right) <= max(abs_tol, rel * scale)


# ---------------------------------------------------------------------------
# Yahoo 会话（仅历史 K 线使用）
# ---------------------------------------------------------------------------

def get_yahoo_bootstrap_opener():
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    request = urllib.request.Request("https://finance.yahoo.com/quote/AAPL/", headers=yahoo_headers())
    opener.open(request, timeout=15).read()
    return opener


def yahoo_headers():
    return {
        "User-Agent": YAHOO_UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
