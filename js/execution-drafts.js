/**
 * 本期执行清单草稿：建议金额 → 整手份额 → 确认入账 / 跳过。
 */

import { state } from "./state.js";
import {
  orderPreview,
  planExecutionContext,
  planPeriod,
} from "./decision-support.js";
import { allocatePoolBudget } from "./strategy.js";
import { buildPoolHoldingsForAllocation, prepareHoldingsForAllocation } from "./pool-alloc.js";
import { buildRebalanceSellSuggestions } from "./rebalance-sell.js";
import {
  normalizeCashReserve,
  normalizeExecutionDrafts,
  normalizePlan,
  normalizeTradingCost,
} from "./workspace_model.js";
import {
  analysisRegistryFromConfig,
  sentimentByMarketFromState,
} from "./market-sentiment.js";

function todayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function draftId(period, symbol, side = "buy") {
  return side === "sell" ? `draft_${period}_${symbol}_sell` : `draft_${period}_${symbol}`;
}

/** 根据当前全池分配生成/刷新本期 pending 草稿（保留已确认/跳过）。 */
export function buildExecutionDraftsFromAllocation({ now = new Date() } = {}) {
  const plan = state.plan || {};
  const period = planPeriod(plan, now);
  const rawHoldings = buildPoolHoldingsForAllocation();
  const holdings = prepareHoldingsForAllocation(rawHoldings);
  const execution = planExecutionContext({ plan, holdings: rawHoldings });
  const pool = allocatePoolBudget({
    budget: execution.budget,
    holdings,
    strategy: plan.strategy,
    strategyConfig: plan.strategy_config,
    strategyOverrides: plan.strategy_overrides,
    preferTargetGap: execution.phase === "initial",
    buildTargetAmount: execution.phase === "initial" ? execution.targetAmount : null,
    sentimentByMarket: sentimentByMarketFromState(),
    analysisRegistry: analysisRegistryFromConfig(),
    cashReserve: Number(plan.cash_reserve?.balance) || 0,
  });
  const tradingCost = normalizeTradingCost(plan.trading_cost);
  const existing = normalizeExecutionDrafts(state.executionDrafts || []);
  const kept = existing.filter(
    (item) => item.period === period.start && (item.status === "confirmed" || item.status === "skipped"),
  );
  const keptIds = new Set(kept.map((item) => item.id));
  const otherPeriods = existing.filter((item) => item.period !== period.start);
  const date = todayKey(now);
  const created = [];

  for (const row of pool.allocations || []) {
    if (!(row.amount > 0)) continue;
    const id = draftId(period.start, row.symbol, "buy");
    if (keptIds.has(id)) continue;
    const quote = state.quotesBySymbol[row.symbol];
    const cached = state.analysisCache[row.symbol];
    const price = Number(quote?.price ?? cached?.etf?.price ?? cached?.price) || 0;
    const preview = orderPreview(row.amount, price, tradingCost);
    if (!(preview.shares > 0) || !(price > 0)) continue;
    created.push({
      id,
      period: period.start,
      symbol: row.symbol,
      name: row.name || quote?.name || row.symbol,
      side: "buy",
      suggested_amount: Math.round(row.amount * 100) / 100,
      price: Math.round(price * 1e6) / 1e6,
      shares: preview.shares,
      fee: preview.fee,
      date,
      status: "pending",
      skip_reason: "",
      confirmed_trade_id: null,
      note: "",
    });
  }

  // 卖出纪律建议（确认制，绝不自动下单）
  const holdingsWithShares = holdings.map((item) => {
    const etf = (state.etfs || []).find((row) => row.symbol === item.symbol);
    return {
      ...item,
      shares: Math.max(0, Number(etf?.shares) || 0) || undefined,
    };
  });
  const sellSuggestions = buildRebalanceSellSuggestions({
    holdings: holdingsWithShares,
    quotes: state.quotesBySymbol,
    plan,
    now,
  });
  for (const row of sellSuggestions) {
    const id = draftId(period.start, row.symbol, "sell");
    if (keptIds.has(id)) continue;
    created.push({
      id,
      period: period.start,
      symbol: row.symbol,
      name: row.name,
      side: "sell",
      suggested_amount: row.suggested_amount,
      price: row.price,
      shares: row.shares,
      fee: row.fee,
      date,
      status: "pending",
      skip_reason: "",
      confirmed_trade_id: null,
      note: row.hint || row.band || "",
    });
  }

  return normalizeExecutionDrafts([...otherPeriods, ...kept, ...created]);
}

/**
 * 单标的卖出纪律建议：与执行清单同源规则；附带本期草稿状态（若已生成）。
 * @returns {null | object}
 */
export function sellSuggestionForSymbol(symbol, { now = new Date(), preferLive = null } = {}) {
  const code = String(symbol || "").trim();
  if (!code) return null;
  const plan = state.plan || {};
  const period = planPeriod(plan, now);
  const rawHoldings = buildPoolHoldingsForAllocation({ preferLive: preferLive || null });
  const holdings = prepareHoldingsForAllocation(rawHoldings).map((item) => {
    const etf = (state.etfs || []).find((row) => row.symbol === item.symbol);
    return {
      ...item,
      shares: Math.max(0, Number(etf?.shares) || 0) || undefined,
    };
  });
  const live =
    buildRebalanceSellSuggestions({
      holdings,
      quotes: state.quotesBySymbol,
      plan,
      now,
    }).find((row) => row.symbol === code) || null;
  if (!live) return null;
  const draft =
    normalizeExecutionDrafts(state.executionDrafts || []).find(
      (item) =>
        item.period === period.start &&
        item.symbol === code &&
        item.side === "sell" &&
        item.status !== "skipped",
    ) || null;
  return {
    ...live,
    draftId: draft?.id || null,
    draftStatus: draft?.status || null,
  };
}

export function currentPeriodDrafts(now = new Date()) {
  const period = planPeriod(state.plan || {}, now);
  return normalizeExecutionDrafts(state.executionDrafts || []).filter(
    (item) => item.period === period.start,
  );
}

export function executionDraftSummary(now = new Date()) {
  const drafts = currentPeriodDrafts(now);
  const suggested = drafts.reduce((sum, item) => sum + (Number(item.suggested_amount) || 0), 0);
  const executed = drafts
    .filter((item) => item.status === "confirmed")
    .reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.shares) || 0), 0);
  const pending = drafts.filter((item) => item.status === "pending").length;
  return {
    period: planPeriod(state.plan || {}, now).start,
    suggested: Math.round(suggested * 100) / 100,
    executed: Math.round(executed * 100) / 100,
    pending,
    total: drafts.length,
    drafts,
  };
}

export function updateExecutionDraft(id, patch) {
  const drafts = normalizeExecutionDrafts(state.executionDrafts || []);
  const next = drafts.map((item) => (item.id === id ? { ...item, ...patch, id: item.id } : item));
  return normalizeExecutionDrafts(next);
}

function appendCashHistory(reserve, { period, amount, type }) {
  const next = normalizeCashReserve(reserve);
  const amt = Math.round(Math.max(0, Number(amount) || 0) * 100) / 100;
  if (!(amt > 0) || !period) return next;
  if (type === "keep" && next.history.some((row) => row.period === period && row.type === "keep")) {
    return next;
  }
  if (type === "release" && next.history.some((row) => row.period === period && row.type === "release")) {
    return next;
  }
  let balance = next.balance;
  if (type === "release") balance = Math.max(0, Math.round((balance - amt) * 100) / 100);
  else balance = Math.round((balance + amt) * 100) / 100;
  return {
    balance,
    history: [...next.history, { period, amount: amt, type }],
  };
}

/**
 * 卖出草稿确认后：卖出所得入账现金池（type sell）。
 * @returns {object|null} 更新后的 plan，若无需变更则 null
 */
export function bookCashReserveSell({ draft, plan = state.plan } = {}) {
  if (!draft || draft.side !== "sell" || draft.status !== "confirmed") return null;
  const period = draft.period;
  const gross = (Number(draft.price) || 0) * (Number(draft.shares) || 0);
  const fee = Math.max(0, Number(draft.fee) || 0);
  const proceeds = Math.round(Math.max(0, gross - fee) * 100) / 100;
  if (!(proceeds > 0) || !period) return null;
  const current = normalizePlan(plan);
  const cash_reserve = appendCashHistory(current.cash_reserve, {
    period,
    amount: proceeds,
    type: "sell",
  });
  return { ...current, cash_reserve };
}

/**
 * 本期全部草稿处理完毕时：未用预算入账 keep；超预算买入扣减 release。
 * @returns {object|null} 更新后的 plan
 */
export function settleCashReserveOnPeriodComplete({ now = new Date(), plan = state.plan } = {}) {
  const current = normalizePlan(plan);
  const period = planPeriod(current, now).start;
  const drafts = normalizeExecutionDrafts(state.executionDrafts || []).filter(
    (item) => item.period === period,
  );
  if (!drafts.length) return null;
  if (drafts.some((item) => item.status === "pending")) return null;

  const holdings = buildPoolHoldingsForAllocation();
  const execution = planExecutionContext({ plan: current, holdings });
  const budget = Math.max(0, Number(execution.budget) || 0);

  const buyExecuted = drafts
    .filter((item) => item.side !== "sell" && item.status === "confirmed")
    .reduce((sum, item) => {
      const notional = (Number(item.price) || 0) * (Number(item.shares) || 0);
      const fee = Math.max(0, Number(item.fee) || 0);
      return sum + notional + fee;
    }, 0);

  let cash_reserve = normalizeCashReserve(current.cash_reserve);
  const keepAmt = Math.round(Math.max(0, budget - buyExecuted) * 100) / 100;
  if (keepAmt > 0) {
    cash_reserve = appendCashHistory(cash_reserve, { period, amount: keepAmt, type: "keep" });
  }
  const overBudget = Math.round(Math.max(0, buyExecuted - budget) * 100) / 100;
  if (overBudget > 0) {
    const releaseAmt = Math.min(cash_reserve.balance, overBudget);
    if (releaseAmt > 0) {
      cash_reserve = appendCashHistory(cash_reserve, {
        period,
        amount: releaseAmt,
        type: "release",
      });
    }
  }
  if (
    cash_reserve.balance === (current.cash_reserve?.balance || 0) &&
    cash_reserve.history.length === (current.cash_reserve?.history || []).length
  ) {
    return null;
  }
  return { ...current, cash_reserve };
}

export { normalizeExecutionDrafts };
