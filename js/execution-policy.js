/**
 * 交易执行安全策略：确定性规则，优先级高于 AI。
 * blocked > preview > warning > ready
 */

export const EXECUTION_STATUSES = Object.freeze(["ready", "warning", "preview", "blocked"]);

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  premium_warn_pct: 2,
  premium_block_pct: 5,
  discount_warn_pct: 2,
  discount_block_pct: 5,
  spread_warn_pct: 0.2,
  spread_block_pct: 0.3,
  quote_max_age_minutes: 15,
  pe_hysteresis_pp: 3,
  allow_warning_override: true,
});

const CROSS_BORDER_INDEX_CODES = new Set(["SPX", "NDX", "HSI", "HSTECH"]);

const STATUS_RANK = Object.freeze({
  ready: 0,
  warning: 1,
  preview: 2,
  blocked: 3,
});

export function normalizeExecutionPolicy(value) {
  const source = value && typeof value === "object" ? value : {};
  const num = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    premium_warn_pct: num(source.premium_warn_pct, DEFAULT_EXECUTION_POLICY.premium_warn_pct),
    premium_block_pct: num(source.premium_block_pct, DEFAULT_EXECUTION_POLICY.premium_block_pct),
    discount_warn_pct: num(source.discount_warn_pct, DEFAULT_EXECUTION_POLICY.discount_warn_pct),
    discount_block_pct: num(source.discount_block_pct, DEFAULT_EXECUTION_POLICY.discount_block_pct),
    spread_warn_pct: num(source.spread_warn_pct, DEFAULT_EXECUTION_POLICY.spread_warn_pct),
    spread_block_pct: num(source.spread_block_pct, DEFAULT_EXECUTION_POLICY.spread_block_pct),
    quote_max_age_minutes: Math.max(
      1,
      Math.round(num(source.quote_max_age_minutes, DEFAULT_EXECUTION_POLICY.quote_max_age_minutes)),
    ),
    pe_hysteresis_pp: num(source.pe_hysteresis_pp, DEFAULT_EXECUTION_POLICY.pe_hysteresis_pp),
    allow_warning_override:
      source.allow_warning_override == null
        ? DEFAULT_EXECUTION_POLICY.allow_warning_override
        : Boolean(source.allow_warning_override),
  };
}

export function isCrossBorderIndex(indexCode) {
  const code = String(indexCode || "")
    .trim()
    .toUpperCase();
  return CROSS_BORDER_INDEX_CODES.has(code);
}

export function policyStatusLabel(status) {
  switch (String(status || "").toLowerCase()) {
    case "ready":
      return "可执行";
    case "warning":
      return "待确认";
    case "preview":
      return "盘后/预览";
    case "blocked":
      return "不可执行";
    default:
      return "未知";
  }
}

export function executionPolicyFingerprint(policy) {
  const p = normalizeExecutionPolicy(policy);
  return [
    p.premium_warn_pct,
    p.premium_block_pct,
    p.discount_warn_pct,
    p.discount_block_pct,
    p.spread_warn_pct,
    p.spread_block_pct,
    p.quote_max_age_minutes,
    p.pe_hysteresis_pp,
    p.allow_warning_override ? 1 : 0,
  ].join("|");
}

function worseStatus(a, b) {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 行情时间戳 → epoch ms。兼容 Unix 秒/毫秒与 ISO 字符串。 */
export function parseQuoteTimestampMs(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const text = String(raw).trim();
  if (!text) return NaN;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return NaN;
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(text);
}

export function quoteAgeMinutes(quote, now = new Date()) {
  const raw = quote?.market_timestamp ?? quote?.marketTimestamp ?? null;
  const ts = parseQuoteTimestampMs(raw);
  if (!Number.isFinite(ts)) return null;
  const nowMs = now instanceof Date ? now.getTime() : parseQuoteTimestampMs(now);
  const basis = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.max(0, (basis - ts) / 60000);
}

/**
 * @returns {{ status: string, reasons: string[], canOverride: boolean, metrics: object }}
 */
export function evaluateExecutionPolicy({
  side = "buy",
  phase = "recurring",
  strategy = "valuation",
  quote = null,
  analysisUsable = true,
  indexCode = "",
  price = null,
  now = new Date(),
  executionPolicy = null,
} = {}) {
  const policy = normalizeExecutionPolicy(executionPolicy);
  const tradeSide = String(side || "buy").toLowerCase() === "sell" ? "sell" : "buy";
  const strategyId = String(strategy || "valuation").toLowerCase();
  const reasons = [];
  let status = "ready";
  const pq = quote?.product_quality && typeof quote.product_quality === "object" ? quote.product_quality : {};
  const resolvedPrice = finiteOrNull(price ?? quote?.price);
  const premium = finiteOrNull(pq.premium_discount_pct ?? quote?.premium_discount_pct);
  const spread = finiteOrNull(pq.bid_ask_spread_pct ?? quote?.bid_ask_spread_pct);
  const ageMin = quoteAgeMinutes(quote, now);

  if (!(resolvedPrice > 0)) {
    status = "blocked";
    reasons.push("缺少有效成交价格");
  }

  if (premium == null) {
    if (isCrossBorderIndex(indexCode)) {
      status = worseStatus(status, "blocked");
      reasons.push("跨境 ETF 缺少折溢价数据");
    } else {
      status = worseStatus(status, "warning");
      reasons.push("缺少折溢价数据");
    }
  } else if (tradeSide === "buy") {
    if (premium >= policy.premium_block_pct) {
      status = worseStatus(status, "blocked");
      reasons.push(`买入溢价 ${premium.toFixed(2)}% 超过硬顶`);
    } else if (premium >= policy.premium_warn_pct) {
      status = worseStatus(status, "warning");
      reasons.push(`买入溢价 ${premium.toFixed(2)}% 偏高`);
    }
  } else if (premium <= -policy.discount_block_pct) {
    status = worseStatus(status, "blocked");
    reasons.push(`卖出折价 ${premium.toFixed(2)}% 超过硬顶`);
  } else if (premium <= -policy.discount_warn_pct) {
    status = worseStatus(status, "warning");
    reasons.push(`卖出折价 ${premium.toFixed(2)}% 偏深`);
  }

  if (spread == null) {
    status = worseStatus(status, "warning");
    reasons.push("缺少买卖价差数据");
  } else if (spread > policy.spread_block_pct) {
    status = worseStatus(status, "blocked");
    reasons.push(`买卖价差 ${spread.toFixed(2)}% 过大`);
  } else if (spread >= policy.spread_warn_pct) {
    status = worseStatus(status, "warning");
    reasons.push(`买卖价差 ${spread.toFixed(2)}% 偏宽`);
  }

  const needsAnalysis = ["valuation", "grade", "custom"].includes(strategyId);
  if (needsAnalysis && !analysisUsable) {
    status = worseStatus(status, "preview");
    reasons.push("分析数据不完整，仅供预览");
  }

  // quote 完全缺失时（无对象且无价格）已在价格规则 blocked；此处不额外降级。
  void phase;

  const canOverride =
    status === "warning" && policy.allow_warning_override === true;

  return {
    status,
    reasons,
    canOverride,
    metrics: {
      price: resolvedPrice,
      premium_discount_pct: premium,
      bid_ask_spread_pct: spread,
      quote_age_minutes: ageMin == null ? null : Math.round(ageMin * 10) / 10,
      index_code: String(indexCode || "").trim() || null,
      strategy: strategyId,
      side: tradeSide,
      policy_fingerprint: executionPolicyFingerprint(policy),
    },
  };
}

/** warning 人工放行：原因至少 3 个字符；blocked/preview 永不可放行。 */
export function canSubmitWithOverride({ status, overrideReason = "", allowWarningOverride = true } = {}) {
  const s = String(status || "").toLowerCase();
  if (s === "ready") return { ok: true, reason: null };
  if (s === "blocked" || s === "preview") {
    return { ok: false, reason: "当前状态不可人工放行" };
  }
  if (s === "warning") {
    if (!allowWarningOverride) return { ok: false, reason: "未允许人工放行" };
    if (String(overrideReason || "").trim().length < 3) {
      return { ok: false, reason: "请填写至少 3 个字符的放行原因" };
    }
    return { ok: true, reason: null };
  }
  return { ok: false, reason: "未知状态" };
}
