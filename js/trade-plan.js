/**
 * 统一买卖规划：战略分配 → 交易安全 → 整手 → 投影持仓 → 卖出纪律 → 冲突检测。
 */

import { orderPreview, planExecutionContext, planPeriod } from "./decision-support.js";
import {
  evaluateExecutionPolicy,
  normalizeExecutionPolicy,
} from "./execution-policy.js";
import { buildRebalanceSellSuggestions } from "./rebalance-sell.js";
import { allocatePoolBudget } from "./strategy.js";
import { normalizeExecutionDrafts, normalizeTradingCost } from "./workspace_model.js";

function todayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function draftId(period, symbol, side = "buy") {
  return side === "sell" ? `draft_${period}_${symbol}_sell` : `draft_${period}_${symbol}`;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundPrice(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

function absoluteTargetAmount(plan, targetWeight) {
  const capitalBase = Math.max(0, Number(plan.capital_base) || 0);
  const initialTargetPct = Math.min(100, Math.max(0, Number(plan.initial_target_pct) || 0));
  const tw = Math.max(0, Number(targetWeight) || 0);
  return round2(capitalBase * (initialTargetPct / 100) * (tw / 100));
}

const ORDER_SIZING_BLOCK_REASONS = new Set([
  "insufficient_lot",
  "fee_inefficient",
  "fee_rate_exceeds_limit",
]);

/** 战略金额买不进高效整手时：降为待确认，并写明手续费原因。 */
function applyOrderSizingReadiness(policy, preview) {
  if (!ORDER_SIZING_BLOCK_REASONS.has(preview?.blockedReason)) return policy;
  const reasons = [...(policy.reasons || [])];
  if (!reasons.some((row) => String(row).includes("手续费率超过限制"))) {
    reasons.push("手续费率超过限制");
  }
  // 已有更严状态时保留；否则标为 warning（待确认）。零份额不可人工放行。
  const status =
    policy.status === "blocked" || policy.status === "preview" ? policy.status : "warning";
  return {
    ...policy,
    status,
    reasons,
    canOverride: false,
  };
}

function quoteFields(quote) {
  const pq = quote?.product_quality && typeof quote.product_quality === "object" ? quote.product_quality : {};
  return {
    price: Number(quote?.price) || 0,
    as_of: quote?.as_of || quote?.tencent_as_of || null,
    market_timestamp: quote?.market_timestamp || null,
    provider: quote?.provider || null,
    iopv: pq.iopv ?? null,
    premium_discount_pct:
      pq.premium_discount_pct != null ? Number(pq.premium_discount_pct) : null,
    bid_ask_spread_pct:
      pq.bid_ask_spread_pct != null ? Number(pq.bid_ask_spread_pct) : null,
  };
}

function buildDecisionSnapshot({
  phase,
  strategicAmount,
  targetAmount,
  currentMarketValue,
  targetGap,
  strategy,
  band,
  baseMult,
  sentimentMult,
  effectiveMult,
  quote,
  analysisUsable,
  policy,
  signalSnapshotId,
  now,
}) {
  const q = quoteFields(quote);
  return {
    phase,
    strategic_amount: round2(strategicAmount),
    target_amount: round2(targetAmount),
    current_market_value: round2(currentMarketValue),
    target_gap: round2(targetGap),
    strategy: String(strategy || ""),
    band: String(band || ""),
    base_mult: Number.isFinite(Number(baseMult)) ? Number(baseMult) : null,
    sentiment_mult: Number.isFinite(Number(sentimentMult)) ? Number(sentimentMult) : null,
    effective_mult: Number.isFinite(Number(effectiveMult)) ? Number(effectiveMult) : null,
    quote_price: q.price > 0 ? roundPrice(q.price) : 0,
    quote_as_of: q.as_of,
    market_timestamp: q.market_timestamp,
    provider: q.provider,
    iopv: q.iopv,
    premium_discount_pct: q.premium_discount_pct,
    bid_ask_spread_pct: q.bid_ask_spread_pct,
    analysis_usable: Boolean(analysisUsable),
    policy_status: policy.status,
    policy_reasons: [...(policy.reasons || [])],
    policy_fingerprint: policy.metrics?.policy_fingerprint || "",
    signal_snapshot_id: signalSnapshotId || null,
    created_at: now instanceof Date ? now.toISOString() : String(now || ""),
  };
}

function makeDraft({
  id,
  period,
  symbol,
  name,
  side,
  strategicAmount,
  price,
  shares,
  fee,
  totalCash,
  date,
  note,
  readiness,
  decisionSnapshot,
  stale = false,
}) {
  const orderAmount = round2((Number(shares) || 0) * (Number(price) || 0));
  return {
    id,
    period,
    symbol,
    name,
    side,
    suggested_amount: round2(strategicAmount),
    order_amount: orderAmount,
    total_cash: round2(totalCash),
    price: price > 0 ? roundPrice(price) : 0,
    shares: shares > 0 ? Math.round(shares * 1e4) / 1e4 : 0,
    fee: round2(fee),
    date,
    status: "pending",
    skip_reason: "",
    confirmed_trade_id: null,
    note: String(note || "").trim(),
    readiness_status: readiness.status,
    readiness_reasons: [...(readiness.reasons || [])],
    stale: Boolean(stale),
    decision_snapshot: decisionSnapshot,
  };
}

/**
 * 将潜在买入投影到持仓市值/权重（不改原数组）。
 */
export function projectPortfolioAfterBuys({ holdings = [], buyDrafts = [], quotes = {} } = {}) {
  const map = new Map();
  for (const item of holdings || []) {
    const symbol = String(item.symbol || "").trim();
    if (!symbol) continue;
    map.set(symbol, {
      ...item,
      marketValue: Math.max(0, Number(item.marketValue) || 0),
      shares: Math.max(0, Number(item.shares) || 0),
    });
  }
  for (const draft of buyDrafts || []) {
    if (!draft || draft.side === "sell") continue;
    const symbol = String(draft.symbol || "").trim();
    if (!symbol) continue;
    const price =
      Number(draft.price) ||
      Number(quotes?.[symbol]?.price) ||
      0;
    const shares = Math.max(0, Number(draft.shares) || 0);
    if (!(price > 0) || !(shares > 0)) continue;
    const addMv = shares * price;
    const current = map.get(symbol) || {
      symbol,
      name: draft.name || symbol,
      targetWeight: 0,
      actualWeight: 0,
      marketValue: 0,
      shares: 0,
    };
    current.marketValue = round2(current.marketValue + addMv);
    current.shares = (Number(current.shares) || 0) + shares;
    map.set(symbol, current);
  }
  const rows = [...map.values()];
  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.marketValue) || 0), 0);
  return rows.map((row) => ({
    ...row,
    actualWeight: total > 0 ? (Math.max(0, Number(row.marketValue) || 0) / total) * 100 : 0,
  }));
}

export function validateTradePlanConflicts({ buyDrafts = [], sellDrafts = [] } = {}) {
  const buySymbols = new Set(
    (buyDrafts || []).filter((d) => d && d.status !== "skipped").map((d) => d.symbol),
  );
  const conflicts = [];
  for (const sell of sellDrafts || []) {
    if (!sell || sell.status === "skipped") continue;
    if (buySymbols.has(sell.symbol)) {
      conflicts.push({
        symbol: sell.symbol,
        reason: "组合计划方向冲突",
      });
    }
  }
  return conflicts;
}

/**
 * @returns {{
 *   buyDrafts, sellDrafts, blockedDrafts, projectedHoldings, conflicts, summary
 * }}
 */
export function buildTradePlan({
  plan = {},
  phase = null,
  holdings = [],
  poolAllocation = null,
  quotes = {},
  tradingCost = null,
  existingDrafts = [],
  now = new Date(),
  sentimentByMarket = null,
  analysisRegistry = null,
  signalSnapshotId = null,
  strategyFrozenBySymbol = null,
} = {}) {
  const period = planPeriod(plan, now);
  const cost = normalizeTradingCost(tradingCost || plan.trading_cost);
  const policyCfg = normalizeExecutionPolicy(plan.execution_policy);
  const execution = planExecutionContext({ plan, holdings, now });
  const resolvedPhase = phase || execution.phase;
  const date = todayKey(now);

  const existing = normalizeExecutionDrafts(existingDrafts || []);
  const kept = existing.filter(
    (item) => item.period === period.start && (item.status === "confirmed" || item.status === "skipped"),
  );
  const keptIds = new Set(kept.map((item) => item.id));

  let pool = poolAllocation;
  if (!pool) {
    pool = allocatePoolBudget({
      budget: execution.budget,
      holdings,
      strategy: plan.strategy,
      strategyConfig: plan.strategy_config,
      strategyOverrides: plan.strategy_overrides,
      preferTargetGap: resolvedPhase === "initial",
      buildTargetAmount: resolvedPhase === "initial" ? execution.targetAmount : null,
      sentimentByMarket,
      analysisRegistry,
      cashReserve: Number(plan.cash_reserve?.balance) || 0,
    });
  }

  const buyDrafts = [];
  const waitingCashParts = [];
  const readyBuyCashParts = [];

  for (const row of pool.allocations || []) {
    const strategic = round2(row.amount);
    if (!(strategic > 0)) continue;
    const symbol = row.symbol;
    const id = draftId(period.start, symbol, "buy");
    if (keptIds.has(id)) continue;

    const holding = (holdings || []).find((h) => h.symbol === symbol) || {};
    const quote = quotes?.[symbol] || null;
    const q = quoteFields(quote);
    const price = q.price;
    const frozen = strategyFrozenBySymbol?.[symbol] || null;
    const analysisUsable = frozen
      ? frozen.analysis_usable !== false
      : Boolean(holding.analyzed ?? holding.analysisUsable ?? row.analyzed);
    const strategyId =
      frozen?.strategy ||
      plan.strategy_overrides?.[symbol] ||
      plan.strategy ||
      "valuation";

    const policyBase = evaluateExecutionPolicy({
      side: "buy",
      phase: resolvedPhase,
      strategy: strategyId,
      quote,
      analysisUsable,
      indexCode: holding.indexCode || frozen?.index_code || "",
      price,
      now,
      executionPolicy: policyCfg,
    });

    // blocked/preview 仍可保留预览整手；ready/warning 正常计算
    const preview = orderPreview(strategic, price, {
      ...cost,
      allowInefficient: policyBase.status === "blocked" || policyBase.status === "preview",
    });
    const policy = applyOrderSizingReadiness(policyBase, preview);
    const shares = preview.shares;
    const fee = preview.fee;
    const orderAmount = preview.estimatedAmount;
    const totalCash = preview.totalCash;

    const absTarget = absoluteTargetAmount(plan, holding.targetWeight ?? row.targetWeight);
    const mv = Math.max(0, Number(holding.marketValue) || 0);
    const snapshot = buildDecisionSnapshot({
      phase: resolvedPhase,
      strategicAmount: strategic,
      targetAmount: absTarget,
      currentMarketValue: mv,
      targetGap: Math.max(0, absTarget - mv),
      strategy: strategyId,
      band: frozen?.band || row.band || "",
      baseMult: frozen?.base_mult ?? row.baseMult ?? row.mult,
      sentimentMult: frozen?.sentiment_mult ?? row.sentimentMult,
      effectiveMult: frozen?.effective_mult ?? row.effectiveMult ?? row.mult,
      quote,
      analysisUsable,
      policy,
      signalSnapshotId,
      now,
    });

    const draft = makeDraft({
      id,
      period: period.start,
      symbol,
      name: row.name || holding.name || symbol,
      side: "buy",
      strategicAmount: strategic,
      price,
      shares,
      fee,
      totalCash: policy.status === "ready" || policy.status === "warning" ? totalCash : 0,
      date,
      note: row.band || "",
      readiness: policy,
      decisionSnapshot: snapshot,
    });

    // 缺行情：冻结（仍进清单，blocked）
    if (holding.quoteMissing) {
      draft.readiness_status = "blocked";
      draft.readiness_reasons = ["持仓行情缺失，冻结交易"];
      draft.decision_snapshot = {
        ...snapshot,
        policy_status: "blocked",
        policy_reasons: ["持仓行情缺失，冻结交易"],
      };
      draft.total_cash = 0;
    }

    if (draft.readiness_status === "ready" || draft.readiness_status === "warning") {
      if (shares > 0) readyBuyCashParts.push(draft.total_cash);
      else waitingCashParts.push(strategic);
    } else {
      waitingCashParts.push(strategic);
      draft.total_cash = 0;
    }
    buyDrafts.push(draft);
  }

  const projectedHoldings = projectPortfolioAfterBuys({
    holdings,
    buyDrafts,
    quotes,
  });

  const sellSuggestions = buildRebalanceSellSuggestions({
    holdings: projectedHoldings,
    quotes,
    plan,
    now,
    phase: resolvedPhase,
    absoluteTargetsBySymbol: Object.fromEntries(
      (holdings || []).map((h) => [h.symbol, absoluteTargetAmount(plan, h.targetWeight)]),
    ),
  });

  const sellDrafts = [];
  for (const row of sellSuggestions) {
    const id = draftId(period.start, row.symbol, "sell");
    if (keptIds.has(id)) continue;
    const holding = (holdings || []).find((h) => h.symbol === row.symbol) || {};
    const quote = quotes?.[row.symbol] || null;
    const analysisUsable = Boolean(holding.analyzed);
    const strategyId = plan.strategy_overrides?.[row.symbol] || plan.strategy || "valuation";
    const policy = evaluateExecutionPolicy({
      side: "sell",
      phase: resolvedPhase,
      strategy: strategyId,
      quote,
      analysisUsable,
      indexCode: holding.indexCode || "",
      price: row.price,
      now,
      executionPolicy: policyCfg,
    });
    const snapshot = buildDecisionSnapshot({
      phase: resolvedPhase,
      strategicAmount: row.suggested_amount,
      targetAmount: absoluteTargetAmount(plan, holding.targetWeight),
      currentMarketValue: Math.max(0, Number(holding.marketValue) || 0),
      targetGap: 0,
      strategy: strategyId,
      band: row.band,
      baseMult: null,
      sentimentMult: null,
      effectiveMult: null,
      quote,
      analysisUsable,
      policy,
      signalSnapshotId,
      now,
    });
    const notional = round2((row.shares || 0) * (row.price || 0));
    const fee = round2(row.fee);
    const net = round2(Math.max(0, notional - fee));
    sellDrafts.push(
      makeDraft({
        id,
        period: period.start,
        symbol: row.symbol,
        name: row.name,
        side: "sell",
        strategicAmount: row.suggested_amount,
        price: row.price,
        shares: row.shares,
        fee,
        totalCash:
          policy.status === "ready" || policy.status === "warning" ? net : 0,
        date,
        note: row.hint || row.band || "",
        readiness: policy,
        decisionSnapshot: snapshot,
      }),
    );
  }

  const conflicts = validateTradePlanConflicts({ buyDrafts, sellDrafts });
  const conflictSymbols = new Set(conflicts.map((c) => c.symbol));
  for (const draft of [...buyDrafts, ...sellDrafts]) {
    if (!conflictSymbols.has(draft.symbol)) continue;
    draft.readiness_status = "blocked";
    draft.readiness_reasons = ["组合计划方向冲突"];
    draft.total_cash = 0;
    if (draft.decision_snapshot) {
      draft.decision_snapshot = {
        ...draft.decision_snapshot,
        policy_status: "blocked",
        policy_reasons: ["组合计划方向冲突"],
      };
    }
  }

  const allPending = [...buyDrafts, ...sellDrafts];
  const blockedDrafts = allPending.filter(
    (d) => d.readiness_status === "blocked" || d.readiness_status === "preview",
  );
  const readyBuyCash = round2(
    buyDrafts
      .filter((d) => d.readiness_status === "ready" || d.readiness_status === "warning")
      .reduce((sum, d) => sum + (Number(d.total_cash) || 0), 0),
  );
  const waitingCash = round2(waitingCashParts.reduce((a, b) => a + b, 0));
  const keptCash = round2(Math.max(0, (Number(execution.budget) || 0) - readyBuyCash - waitingCash));

  return {
    buyDrafts,
    sellDrafts,
    blockedDrafts,
    projectedHoldings,
    conflicts,
    period: period.start,
    phase: resolvedPhase,
    kept,
    summary: {
      readyBuyCount: buyDrafts.filter((d) => d.readiness_status === "ready").length,
      warningBuyCount: buyDrafts.filter((d) => d.readiness_status === "warning").length,
      waitingBuyCount: buyDrafts.filter(
        (d) => d.readiness_status === "preview" || d.readiness_status === "blocked",
      ).length,
      sellCount: sellDrafts.length,
      readyBuyCash,
      waitingCash,
      keptCash,
      budget: round2(execution.budget),
    },
  };
}
