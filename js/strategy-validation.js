/**
 * 从 decision_history 汇总策略执行验证指标（纯函数）。
 */

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round4(value) {
  return Math.round((Number(value) || 0) * 1e4) / 1e4;
}

/**
 * @param {Array} decisionHistory
 * @param {{ period?: string, keptCashByPeriod?: Record<string, number> }} [options]
 */
export function summarizeDecisionHistory(decisionHistory = [], options = {}) {
  const rows = Array.isArray(decisionHistory) ? decisionHistory : [];
  const periodFilter = options.period ? String(options.period) : null;
  const filtered = periodFilter ? rows.filter((row) => row.period === periodFilter) : rows;

  const byPeriod = new Map();
  for (const row of filtered) {
    const p = row.period || "";
    if (!byPeriod.has(p)) byPeriod.set(p, []);
    byPeriod.get(p).push(row);
  }

  let confirmed = 0;
  let skipped = 0;
  let blocked = 0;
  let override = 0;
  let blockedAmount = 0;
  let premiumAvoided = 0;
  let fees = 0;
  let tradedNotional = 0;
  let turnover = 0;
  const symbolPeriod = new Map();

  for (const row of filtered) {
    const action = String(row.action || "").toLowerCase();
    const strategic = Math.max(0, Number(row.strategic_amount) || 0);
    const orderAmt = Math.max(0, Number(row.order_amount) || 0);
    const fee = Math.max(0, Number(row.fee) || 0);
    const premium = Number(row.premium_discount_pct);
    if (action === "confirmed") confirmed += 1;
    else if (action === "skipped") skipped += 1;
    else if (action === "blocked") blocked += 1;
    else if (action === "override") override += 1;

    if (action === "blocked") {
      blockedAmount += strategic;
      if (Number.isFinite(premium) && premium >= 2) premiumAvoided += strategic;
    }
    if (action === "confirmed" || action === "override") {
      fees += fee;
      tradedNotional += orderAmt;
      turnover += orderAmt;
    }
    const key = `${row.period}|${row.symbol}|${row.side}`;
    symbolPeriod.set(key, (symbolPeriod.get(key) || 0) + 1);
  }

  let repeatTrades = 0;
  for (const count of symbolPeriod.values()) {
    if (count > 1) repeatTrades += count - 1;
  }

  const actionable = confirmed + skipped + blocked + override;
  const completionRate = actionable > 0 ? (confirmed + override) / actionable : null;
  const keptCash = periodFilter
    ? Number(options.keptCashByPeriod?.[periodFilter]) || 0
    : Object.values(options.keptCashByPeriod || {}).reduce((s, v) => s + (Number(v) || 0), 0);

  return {
    periods: byPeriod.size,
    entries: filtered.length,
    completion_rate: completionRate == null ? null : round4(completionRate),
    blocked_amount: round2(blockedAmount),
    warning_overrides: override,
    premium_avoided_amount: round2(premiumAvoided),
    total_fees: round2(fees),
    fee_ratio_pct: tradedNotional > 0 ? round4((fees / tradedNotional) * 100) : null,
    turnover_amount: round2(turnover),
    kept_cash: round2(keptCash),
    repeat_trades: repeatTrades,
    confirmed,
    skipped,
    blocked,
  };
}

/** UI 文案：明确实验性，非收益预测。 */
export function strategyValidationDisclaimer() {
  return "策略参数仍属实验。以下指标仅复盘历史决策执行，不构成未来收益预测或最优参数证明。";
}
