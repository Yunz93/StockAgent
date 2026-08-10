/**
 * 本期执行清单草稿：战略分配 → 交易安全 → 整手 → 确认入账 / 跳过。
 */

import { state } from "./state.js";
import {
  planExecutionContext,
  planPeriod,
  stampInitialBuildStarted,
} from "./decision-support.js";
import { buildPoolHoldingsForAllocation, prepareHoldingsForAllocation } from "./pool-alloc.js";
import { buildRebalanceSellSuggestions } from "./rebalance-sell.js";
import { buildTradePlan } from "./trade-plan.js";
import {
  buildSignalSnapshot,
  getCurrentSignalSnapshot,
  invalidatePendingDraftsForSnapshot,
  signalSnapshotFingerprint,
  upsertSignalSnapshot,
} from "./signal-snapshot.js";
import {
  normalizeCashReserve,
  normalizeDecisionHistory,
  normalizeExecutionDrafts,
  normalizeExecutionDraftsMeta,
  normalizePlan,
  normalizeTradingCost,
} from "./workspace_model.js";
import {
  analysisRegistryFromConfig,
  sentimentByMarketFromState,
} from "./market-sentiment.js";
import { executionPolicyFingerprint } from "./execution-policy.js";

function draftId(period, symbol, side = "buy") {
  return side === "sell" ? `draft_${period}_${symbol}_sell` : `draft_${period}_${symbol}`;
}

function ensurePeriodSignalSnapshot({ plan, holdings, period, now, force = false }) {
  const existing = getCurrentSignalSnapshot(plan, period.start);
  if (existing && !force) {
    return { plan, snapshot: existing, created: false };
  }
  const previousKeys = Object.keys(plan.signal_snapshots || {})
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k < period.start)
    .sort();
  const previous =
    previousKeys.length > 0 ? plan.signal_snapshots[previousKeys[previousKeys.length - 1]] : null;
  const snapshot = buildSignalSnapshot({
    plan,
    period: period.start,
    holdings,
    previousSnapshot: force ? existing : previous,
    sentimentByMarket: sentimentByMarketFromState(),
    now,
  });
  return {
    plan: upsertSignalSnapshot(plan, snapshot),
    snapshot,
    created: true,
  };
}

/** 根据当前全池分配生成/刷新本期 pending 草稿（保留已确认/跳过）。 */
export function buildExecutionDraftsFromAllocation({
  now = new Date(),
  forceResnapshot = false,
} = {}) {
  const stamped = stampInitialBuildStarted(state.plan || {}, now);
  if (stamped.changed) state.plan = stamped.plan;
  let plan = normalizePlan(state.plan || {});
  const period = planPeriod(plan, now);
  const rawHoldings = buildPoolHoldingsForAllocation();
  const holdings = prepareHoldingsForAllocation(rawHoldings);
  const snap = ensurePeriodSignalSnapshot({
    plan,
    holdings: rawHoldings,
    period,
    now,
    force: forceResnapshot,
  });
  plan = snap.plan;
  state.plan = plan;
  const snapshot = snap.snapshot;

  const frozenBySymbol = {};
  for (const [symbol, row] of Object.entries(snapshot.holdings || {})) {
    frozenBySymbol[symbol] = row;
  }

  const tradePlan = buildTradePlan({
    plan,
    holdings,
    quotes: state.quotesBySymbol,
    tradingCost: plan.trading_cost,
    existingDrafts: state.executionDrafts || [],
    now,
    sentimentByMarket: sentimentByMarketFromState(),
    analysisRegistry: analysisRegistryFromConfig(),
    signalSnapshotId: snapshot.id,
    strategyFrozenBySymbol: frozenBySymbol,
  });

  const otherPeriods = normalizeExecutionDrafts(state.executionDrafts || []).filter(
    (item) => item.period !== period.start,
  );
  return normalizeExecutionDrafts([
    ...otherPeriods,
    ...tradePlan.kept,
    ...tradePlan.buyDrafts,
    ...tradePlan.sellDrafts,
  ]);
}

/**
 * 用户主动「重新评估本期策略」：新 snapshot + pending 失效重建。
 */
export function reevaluatePeriodStrategy({ now = new Date() } = {}) {
  const period = planPeriod(state.plan || {}, now);
  const invalidated = invalidatePendingDraftsForSnapshot(
    state.executionDrafts || [],
    "__force__",
  ).map((draft) =>
    draft.status === "pending" && draft.period === period.start
      ? { ...draft, stale: true }
      : draft,
  );
  // 丢掉本期 pending，保留 confirmed/skipped
  state.executionDrafts = invalidated.filter(
    (item) =>
      item.period !== period.start ||
      item.status === "confirmed" ||
      item.status === "skipped",
  );
  const drafts = buildExecutionDraftsFromAllocation({ now, forceResnapshot: true });
  state.executionDrafts = drafts;
  const fingerprint = executionDraftFingerprint(drafts);
  state.execDraftsMeta = normalizeExecutionDraftsMeta({
    synced_at: now.toISOString(),
    fingerprint,
    signal_snapshot_id: getCurrentSignalSnapshot(state.plan, period.start)?.id || null,
  });
  return { drafts, fingerprint, snapshot: getCurrentSignalSnapshot(state.plan, period.start) };
}

/**
 * 单标的卖出纪律建议：与执行清单同源规则；附带本期草稿状态（若已生成）。
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
  const execution = planExecutionContext({ plan, holdings: rawHoldings, now });
  const capitalBase = Math.max(0, Number(plan.capital_base) || 0);
  const initialTargetPct = Math.min(100, Math.max(0, Number(plan.initial_target_pct) || 0));
  const absoluteTargetsBySymbol = Object.fromEntries(
    holdings.map((h) => [
      h.symbol,
      Math.round(capitalBase * (initialTargetPct / 100) * (Math.max(0, Number(h.targetWeight) || 0) / 100) * 100) /
        100,
    ]),
  );
  const live =
    buildRebalanceSellSuggestions({
      holdings,
      quotes: state.quotesBySymbol,
      plan,
      now,
      phase: execution.phase,
      absoluteTargetsBySymbol,
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
    readinessStatus: draft?.readiness_status || null,
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
  const pending = drafts.filter((item) => item.status === "pending");
  const pendingBuys = pending.filter((item) => item.side !== "sell");
  const pendingSells = pending.filter((item) => item.side === "sell");
  const isExecutable = (item) => {
    const status = item.readiness_status || "";
    return status === "ready" || status === "warning" || status === "";
  };
  const isWaiting = (item) => {
    const status = item.readiness_status || "";
    return status === "preview" || status === "blocked";
  };
  const readyBuys = pendingBuys.filter((item) => (item.readiness_status || "ready") === "ready");
  const warningBuys = pendingBuys.filter((item) => item.readiness_status === "warning");
  const waitingBuys = pendingBuys.filter((item) => isWaiting(item));
  const draftCash = (item, side) => {
    if (Number(item.total_cash) > 0) return Number(item.total_cash);
    const notional = (Number(item.price) || 0) * (Number(item.shares) || 0);
    const fee = Math.max(0, Number(item.fee) || 0);
    return side === "sell" ? Math.max(0, notional - fee) : notional + fee;
  };
  const readyBuyCash = pendingBuys
    .filter((item) => isExecutable(item))
    .reduce((sum, item) => sum + draftCash(item, "buy"), 0);
  const waitingCash = waitingBuys.reduce(
    (sum, item) => sum + (Number(item.suggested_amount) || 0),
    0,
  );
  const sellProceeds = pendingSells
    .filter((item) => isExecutable(item))
    .reduce((sum, item) => sum + draftCash(item, "sell"), 0);
  const buyFee = pendingBuys.reduce((sum, item) => sum + Math.max(0, Number(item.fee) || 0), 0);
  const sellFee = pendingSells.reduce((sum, item) => sum + Math.max(0, Number(item.fee) || 0), 0);
  const suggested = drafts.reduce((sum, item) => sum + (Number(item.suggested_amount) || 0), 0);
  const executed = drafts
    .filter((item) => item.status === "confirmed")
    .reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.shares) || 0), 0);
  const plan = state.plan || {};
  const holdings = buildPoolHoldingsForAllocation();
  const execution = planExecutionContext({ plan, holdings, now });
  const keptCash = Math.max(0, (Number(execution.budget) || 0) - readyBuyCash - waitingCash);
  const stale = pending.some((item) => item.stale);
  return {
    period: planPeriod(plan, now).start,
    phase: execution.phase,
    phaseLabel: execution.phaseLabel,
    suggested: Math.round(suggested * 100) / 100,
    executed: Math.round(executed * 100) / 100,
    pending: pending.length,
    pendingBuys,
    pendingSells,
    readyBuys,
    warningBuys,
    waitingBuys,
    buyCash: Math.round(readyBuyCash * 100) / 100,
    waitingCash: Math.round(waitingCash * 100) / 100,
    keptCash: Math.round(keptCash * 100) / 100,
    sellProceeds: Math.round(sellProceeds * 100) / 100,
    buyFee: Math.round(buyFee * 100) / 100,
    sellFee: Math.round(sellFee * 100) / 100,
    total: drafts.length,
    drafts,
    stale,
    signalSnapshot: getCurrentSignalSnapshot(plan, planPeriod(plan, now).start),
  };
}

/** 待执行草稿指纹：纳入快照与政策指纹。 */
export function executionDraftFingerprint(drafts = [], { signalSnapshotId = null, plan = null } = {}) {
  const policyFp = executionPolicyFingerprint(plan?.execution_policy);
  const snapFp = signalSnapshotId || "";
  const body = (Array.isArray(drafts) ? drafts : [])
    .filter((item) => item && item.status === "pending")
    .map(
      (item) =>
        `${item.side === "sell" ? "sell" : "buy"}:${item.symbol}:${item.shares}:${item.price}:${item.fee}:${item.readiness_status || ""}:${item.decision_snapshot?.policy_fingerprint || ""}`,
    )
    .sort()
    .join("|");
  return `${snapFp}::${policyFp}::${body}`;
}

/**
 * 按最新分配刷新本期 pending 草稿；保留已确认/跳过。
 */
export function syncExecutionDraftsFromAllocation({ now = new Date() } = {}) {
  const period = planPeriod(state.plan || {}, now);
  const snapshot = getCurrentSignalSnapshot(state.plan || {}, period.start);
  const next = buildExecutionDraftsFromAllocation({ now });
  const before = executionDraftFingerprint(state.executionDrafts, {
    signalSnapshotId: state.execDraftsMeta?.signal_snapshot_id || snapshot?.id,
    plan: state.plan,
  });
  const after = executionDraftFingerprint(next, {
    signalSnapshotId: getCurrentSignalSnapshot(state.plan || {}, period.start)?.id,
    plan: state.plan,
  });
  const changed = before !== after;
  state.executionDrafts = next;
  state.execDraftsMeta = normalizeExecutionDraftsMeta({
    synced_at: now.toISOString(),
    fingerprint: after,
    signal_snapshot_id: getCurrentSignalSnapshot(state.plan || {}, period.start)?.id || null,
  });
  return {
    drafts: next,
    changed,
    fingerprint: after,
    count: next.filter((item) => item.status === "pending").length,
  };
}

export function updateExecutionDraft(id, patch) {
  const drafts = normalizeExecutionDrafts(state.executionDrafts || []);
  const next = drafts.map((item) => (item.id === id ? { ...item, ...patch, id: item.id } : item));
  return normalizeExecutionDrafts(next);
}

export function appendDecisionHistory(entry, history = state.decisionHistory) {
  return normalizeDecisionHistory([entry, ...(history || [])]);
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

export { normalizeExecutionDrafts, draftId, signalSnapshotFingerprint };
