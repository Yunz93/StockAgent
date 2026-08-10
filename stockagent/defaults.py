#!/usr/bin/env python3
"""Static defaults and provider constants for the index-ETF workbench."""

DEFAULT_ETF_POOL = [
    {"symbol": "563360", "name": "A500ETF华泰柏瑞"},
    {"symbol": "513390", "name": "纳指100ETF博时"},
    {"symbol": "513500", "name": "标普500ETF博时"},
    # 红利低波同指数只保留一只（512890），避免默认双开重复敞口
    {"symbol": "512890", "name": "红利低波ETF华泰柏瑞"},
    {"symbol": "513010", "name": "恒生科技ETF易方达"},
    {"symbol": "159937", "name": "黄金ETF博时"},
]

# 完整估值分析需要指数日线 +（尽量）蛋卷估值；未收录 ETF 使用自身行情做技术面分析。
ETF_ANALYSIS_REGISTRY = {
    "512890": {
        "index_code": "H30269",
        "index_name": "红利低波",
        "index_full_name": "中证红利低波",
        "danjuan_code": "CSIH30269",
        "etf_name": "红利低波ETF",
    },
    "563020": {
        "index_code": "H30269",
        "index_name": "红利低波",
        "index_full_name": "中证红利低波",
        "danjuan_code": "CSIH30269",
        "etf_name": "红利低波ETF易方达",
    },
    "510300": {
        "index_code": "000300",
        "index_name": "沪深300",
        "index_full_name": "沪深300",
        "danjuan_code": "CSI000300",
        "etf_name": "沪深300ETF",
    },
    "510500": {
        "index_code": "000905",
        "index_name": "中证500",
        "index_full_name": "中证500",
        "danjuan_code": "CSI000905",
        "etf_name": "中证500ETF",
    },
    "159915": {
        "index_code": "399006",
        "index_name": "创业板指",
        "index_full_name": "创业板指数",
        "danjuan_code": "SZ399006",
        "etf_name": "创业板ETF",
        "history_source": "sina",
    },
    "563360": {
        "index_code": "000510",
        "index_name": "中证A500",
        "index_full_name": "中证A500",
        "danjuan_code": "",
        "etf_name": "A500ETF华泰柏瑞",
        "history_source": "csindex",
    },
    "510050": {
        "index_code": "000016",
        "index_name": "上证50",
        "index_full_name": "上证50",
        "danjuan_code": "CSI000016",
        "etf_name": "上证50ETF",
    },
    "588000": {
        "index_code": "000688",
        "index_name": "科创50",
        "index_full_name": "上证科创板50成份",
        "danjuan_code": "SH000688",
        "etf_name": "科创50ETF",
        "history_source": "csindex",
    },
    "515080": {
        "index_code": "000922",
        "index_name": "中证红利",
        "index_full_name": "中证红利",
        "danjuan_code": "SH000922",
        "etf_name": "中证红利ETF",
        "history_source": "csindex",
    },
    "159920": {
        "index_code": "HSI",
        "index_name": "恒生指数",
        "index_full_name": "恒生指数",
        "danjuan_code": "HKHSI",
        "etf_name": "恒生ETF",
        "history_source": "tencent",
        "history_symbol": "hkHSI",
    },
    "159919": {
        "index_code": "000300",
        "index_name": "沪深300",
        "index_full_name": "沪深300",
        "danjuan_code": "CSI000300",
        "etf_name": "沪深300ETF",
    },
    "512100": {
        "index_code": "000852",
        "index_name": "中证1000",
        "index_full_name": "中证1000",
        "danjuan_code": "CSI000852",
        "etf_name": "中证1000ETF",
    },
    "513010": {
        "index_code": "HSTECH",
        "index_name": "恒生科技",
        "index_full_name": "恒生科技指数",
        "danjuan_code": "HKHSTECH",
        "etf_name": "恒生科技ETF易方达",
        "history_source": "tencent",
        "history_symbol": "hkHSTECH",
    },
    "513500": {
        "index_code": "SPX",
        "index_name": "标普500",
        "index_full_name": "标普500",
        "danjuan_code": "SP500",
        "etf_name": "标普500ETF博时",
        "history_source": "tencent",
        "history_symbol": "us.INX",
    },
    "513100": {
        "index_code": "NDX",
        "index_name": "纳斯达克100",
        "index_full_name": "纳斯达克100",
        "danjuan_code": "NDX",
        "etf_name": "纳指100ETF博时",
        "history_source": "tencent",
        "history_symbol": "us.NDX",
    },
    "513390": {
        "index_code": "NDX",
        "index_name": "纳斯达克100",
        "index_full_name": "纳斯达克100",
        "danjuan_code": "NDX",
        "etf_name": "纳指100ETF博时",
        "history_source": "tencent",
        "history_symbol": "us.NDX",
    },
}

ETF_ANALYSIS_FIELDS = (
    "index_code",
    "index_name",
    "index_full_name",
    "danjuan_code",
    "etf_name",
    "history_source",
    "history_symbol",
)

ETF_PRODUCT_FIELDS = (
    "fund_size_yi",
    "annual_fee_pct",
    "tracking_error_pct",
    "premium_discount_pct",
    "bid_ask_spread_pct",
)

DEFAULT_SENTIMENT_CONFIG = {
    "enabled": True,
    "mode": "overlay",
    "extremes_only": True,
    "extreme_low": 25,
    "extreme_high": 75,
    "apply_to": ["valuation", "grade", "custom"],
    "bands": [
        {"max_score": 20, "mult": 1.30, "label": "极端恐慌"},
        {"max_score": 40, "mult": 1.15, "label": "偏恐慌"},
        {"max_score": 60, "mult": 1.00, "label": "中性"},
        {"max_score": 80, "mult": 0.75, "label": "偏热"},
        {"max_score": 100, "mult": 0.40, "label": "极端狂热"},
    ],
    "market_by_asset_class": {
        "dividend": "A",
        "equity_core": "A",
        "equity_growth": "auto",
        "commodity": "off",
        "bond": "off",
    },
}

DEFAULT_STRATEGY_CONFIG = {
    "pe_bands": [
        {"max_pct": 20, "mult": 1.5, "label": "低估区"},
        {"max_pct": 40, "mult": 1.2, "label": "偏低区"},
        {"max_pct": 60, "mult": 1.0, "label": "正常区"},
        {"max_pct": 80, "mult": 0.5, "label": "偏高区"},
        {"max_pct": 100, "mult": 0, "label": "高估区"},
    ],
    "grade_mult": {"A": 1.5, "B": 1.2, "C": 1.0, "D": 0.5, "E": 0},
    "use_rebalance": True,
    "sentiment": DEFAULT_SENTIMENT_CONFIG,
}

DEFAULT_WORKSPACE = {
    "version": 9,
    "updated_at": None,
    "etfs": [],
    "buys": [],
    "sells": [],
    "execution_drafts": [],
    "execution_drafts_meta": {
        "synced_at": None,
        "fingerprint": "",
        "signal_snapshot_id": None,
    },
    "decision_history": [],
    "plan": {
        "name": "默认定投计划",
        "amount": 2000,
        "capital_base": 0,
        "initial_target_pct": 0,
        "initial_months": 1,
        "initial_build_started_at": None,
        "initial_build_completed_at": None,
        "cadence": "monthly",
        "day": 1,
        "note": "",
        "strategy": "valuation",
        "strategy_config": DEFAULT_STRATEGY_CONFIG,
        "strategy_overrides": {},
        "add_plan": {"enabled": True, "anchor": "price", "preset": "auto", "levels": None},
        "trading_cost": {
            "min_commission": 5,
            "commission_rate_pct": 0.03,
            "max_fee_ratio_pct": 0.25,
            "lot_size": 100,
        },
        "pending_orders": {},
        "cash_reserve": {"balance": 0, "history": []},
        "execution_policy": {
            "premium_warn_pct": 2,
            "premium_block_pct": 5,
            "discount_warn_pct": 2,
            "discount_block_pct": 5,
            "spread_warn_pct": 0.2,
            "spread_block_pct": 0.3,
            "quote_max_age_minutes": 15,
            "pe_hysteresis_pp": 3,
            "allow_warning_override": True,
        },
        "signal_snapshots": {},
    },
    "prefs": {},
}

# 种子池目标仓位（合计 100），仅用于首次初始化；同指数不双开
DEFAULT_TARGET_WEIGHTS = {
    "563360": 20,
    "513390": 15,
    "513500": 15,
    "512890": 35,
    "513010": 10,
    "159937": 5,
}

DEFAULT_CONFIG = {
    "server": {"port": 5174},
    "ai": {
        "enabled": False,
        "provider": "deepseek",
        "models": {
            "deepseek": "deepseek-v4-flash",
            "openai": "gpt-5.6-luna",
        },
        "timeout_seconds": 60,
        "max_output_tokens": 1800,
        "cache_minutes": 30,
        "max_increase_multiplier": 1.5,
    },
    "quotes": {
        "provider": "tencent",
        "provider_name": "腾讯行情",
        "note": "腾讯公开行情；缺失补齐与整批失败时东方财富兜底",
        "batch_size": 80,
        "max_age_seconds": 1800,
        "auto_refresh_enabled": True,
        "refresh_interval_seconds": 300,
    },
    "etf": {
        "pool": DEFAULT_ETF_POOL,
        "analysis": {},
        "products": {},
        "note": "定投计划默认 ETF 种子；计划与持仓保存在 workspace.json。完整估值分析见内置 ETF_ANALYSIS_REGISTRY。",
    },
    "dividend": {
        "index_code": "H30269",
        "index_name": "红利低波",
        "index_full_name": "中证红利低波",
        "danjuan_code": "CSIH30269",
        "etf_symbol": "512890",
        "etf_name": "红利低波ETF华泰柏瑞",
        "cache_seconds": 1800,
        "note": "红利低波日度决策：中证指数官网 + 蛋卷估值 + 东方财富国债收益率",
    },
    "sources": {
        "QUOTE": [
            {
                "name": "腾讯行情",
                "url": "https://gu.qq.com/",
                "role": "ETF 实时/延迟行情",
            }
        ],
    },
}

YAHOO_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Eastmoney US ulist needs the NYSE prefix for these tickers (kept for HK/US quote parity).
EASTMONEY_NYSE = {
    "JPM", "V", "UNH", "XOM", "HD", "KO", "WMT", "PG", "JNJ", "MA", "DIS", "BA",
    "CAT", "IBM", "GS", "AXP", "MMM", "CVX", "MRK", "NKE", "TRV", "DOW", "CRM",
}
