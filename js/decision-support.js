const DAY_MS = 86_400_000;

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const value = startOfDay(date);
  const weekday = value.getDay() || 7;
  value.setDate(value.getDate() - weekday + 1);
  return value;
}

export function planPeriod(plan = {}, now = new Date()) {
  const cadence = plan.cadence || "monthly";
  const day = Math.max(1, Number(plan.day) || 1);
  const today = startOfDay(now);
  let start;
  let end;
  let scheduled;

  if (cadence === "monthly") {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    scheduled = new Date(today.getFullYear(), today.getMonth(), Math.min(28, day));
  } else {
    const weekStart = startOfWeek(today);
    if (cadence === "biweekly") {
      const anchor = new Date(1970, 0, 5);
      const weeks = Math.floor((weekStart - anchor) / (7 * DAY_MS));
      start = new Date(weekStart);
      if (Math.abs(weeks % 2) === 1) start.setDate(start.getDate() - 7);
      end = new Date(start);
      end.setDate(end.getDate() + 14);
    } else {
      start = weekStart;
      end = new Date(start);
      end.setDate(end.getDate() + 7);
    }
    scheduled = new Date(start);
    scheduled.setDate(scheduled.getDate() + Math.min(7, day) - 1);
  }

  return {
    start: localDateKey(start),
    end: localDateKey(end),
    scheduled: localDateKey(scheduled),
    daysToScheduled: Math.round((scheduled - today) / DAY_MS),
  };
}

export function cycleExecution({ plan, buys = [], symbol, recommendedAmount = 0, now = new Date() } = {}) {
  const period = planPeriod(plan, now);
  const matching = buys.filter(
    (buy) => buy.symbol === symbol && buy.date >= period.start && buy.date < period.end,
  );
  const executedAmount = matching.reduce(
    (sum, buy) => sum + Number(buy.price) * Number(buy.shares) + Math.max(0, Number(buy.fee) || 0),
    0,
  );
  const remainingAmount = Math.max(0, Number(recommendedAmount) - executedAmount);
  const lastBuy = buys.find((buy) => buy.symbol === symbol) || null;
  let status = "waiting";
  if (!(recommendedAmount > 0)) status = "not_required";
  else if (executedAmount >= recommendedAmount * 0.98) status = "completed";
  else if (executedAmount > 0) status = "partial";
  else if (period.daysToScheduled < 0) status = "overdue";
  else if (period.daysToScheduled === 0) status = "due";

  return {
    ...period,
    status,
    executedAmount,
    remainingAmount,
    matchingCount: matching.length,
    lastBuy,
  };
}

export function estimatedTradeFee(amount, tradingCost = {}) {
  const gross = Math.max(0, Number(amount) || 0);
  if (!(gross > 0)) return 0;
  const minCommission = Math.max(0, Number(tradingCost.min_commission) || 0);
  const rate = Math.max(0, Number(tradingCost.commission_rate_pct) || 0) / 100;
  return Math.max(minCommission, gross * rate);
}

/** 建仓月数：1–36，缺省 1（一期打满缺口，兼容旧计划）。 */
export function normalizeInitialMonths(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(36, number);
}

/** 将月额度换算到当前执行频率下的每期额度。 */
export function periodsPerMonth(cadence) {
  const id = String(cadence || "monthly").toLowerCase();
  if (id === "weekly") return 4;
  if (id === "biweekly") return 2;
  return 1;
}

/** 自建仓起始日起已过整月数（不足一月计 0）。 */
export function initialBuildMonthsElapsed(startedAt, now = new Date()) {
  if (!startedAt) return 0;
  const start = new Date(startedAt);
  const end = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

/** 剩余建仓月数：至少 1，逾期后一期打满剩余缺口。 */
export function remainingInitialMonths(initialMonths, startedAt, now = new Date()) {
  const total = normalizeInitialMonths(initialMonths);
  const elapsed = initialBuildMonthsElapsed(startedAt, now);
  return Math.max(1, total - elapsed);
}

/**
 * 若已配置初期建仓且尚未完成、尚未打戳，写入 initial_build_started_at。
 * 纯函数：返回是否变更后的 plan 副本。
 */
export function stampInitialBuildStarted(plan = {}, now = new Date()) {
  const source = plan && typeof plan === "object" ? plan : {};
  if (source.initial_build_started_at || source.initial_build_completed_at) {
    return { plan: source, changed: false };
  }
  const capitalBase = Math.max(0, Number(source.capital_base) || 0);
  const initialTargetPct = Math.min(100, Math.max(0, Number(source.initial_target_pct) || 0));
  if (!(capitalBase > 0 && initialTargetPct > 0)) {
    return { plan: source, changed: false };
  }
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    plan: { ...source, initial_build_started_at: stamp },
    changed: true,
  };
}

export function planExecutionContext({ plan = {}, holdings = [], now = new Date() } = {}) {
  const capitalBase = Math.max(0, Number(plan.capital_base) || 0);
  const initialTargetPct = Math.min(100, Math.max(0, Number(plan.initial_target_pct) || 0));
  const initialMonths = normalizeInitialMonths(plan.initial_months ?? plan.initialMonths);
  const currentValue = holdings.reduce(
    (sum, item) => sum + Math.max(0, Number(item.marketValue) || 0),
    0,
  );
  const targetAmount = capitalBase * (initialTargetPct / 100);
  const initialGap = Math.max(0, targetAmount - currentValue);
  const configured = capitalBase > 0 && initialTargetPct > 0;
  const reached = configured && initialGap < 0.01;
  const markedComplete = Boolean(plan.initial_build_completed_at);
  const phase = configured && !markedComplete && !reached ? "initial" : "recurring";
  const recurringBudget = Math.max(0, Number(plan.amount) || 0);
  // 按「剩余缺口 ÷ 剩余月数」重算，逾期剩 1 个月则打满缺口；不再按原始目标均分。
  const monthsLeft = remainingInitialMonths(initialMonths, plan.initial_build_started_at, now);
  const monthlyInstallment =
    monthsLeft > 0 ? Math.round((initialGap / monthsLeft) * 100) / 100 : initialGap;
  const periodInstallment =
    Math.round((monthlyInstallment / periodsPerMonth(plan.cadence)) * 100) / 100;
  const initialBudget =
    phase === "initial" ? Math.min(initialGap, periodInstallment) : 0;
  return {
    phase,
    phaseLabel: phase === "initial" ? "初期建仓" : "周期定投",
    budget: phase === "initial" ? initialBudget : recurringBudget,
    capitalBase,
    initialTargetPct,
    initialMonths,
    remainingMonths: monthsLeft,
    monthlyInstallment,
    periodInstallment,
    targetAmount,
    currentValue,
    currentPositionPct: capitalBase > 0 ? (currentValue / capitalBase) * 100 : null,
    initialGap,
    configured,
    reached,
    markedComplete,
  };
}

/** 执行面板现金池提示：余额 >0 才展示（返回展示金额，否则 0）。 */
export function cashReserveHintBalance(plan) {
  const balance = Math.max(0, Number(plan?.cash_reserve?.balance) || 0);
  return balance > 0.009 ? Math.round(balance * 100) / 100 : 0;
}

export function pendingOrderState({
  plan = {},
  buys = [],
  symbol = "",
  recommendedAmount = 0,
  now = new Date(),
  phase = null,
} = {}) {
  const period = planPeriod(plan, now);
  const existing = plan.pending_orders?.[symbol] || {};
  // Phase 7：废弃通用跨期 carry（旧字段读入视为 0）。
  // 建仓期例外：上期未花完的「不足一手」余量滚入本期，避免每月薄切永远买不进。
  const baseScheduled = Math.max(0, Number(recommendedAmount) || 0);
  let rolled = 0;
  if (
    phase === "initial" &&
    existing.period &&
    existing.period !== period.start &&
    Number(existing.remaining) > 0
  ) {
    rolled = Math.max(0, Number(existing.remaining) || 0);
  }
  const scheduled = Math.round((baseScheduled + rolled) * 100) / 100;
  const executed = buys
    .filter((buy) => buy.symbol === symbol && buy.date >= period.start && buy.date < period.end)
    .reduce(
      (sum, buy) => sum + Number(buy.price) * Number(buy.shares) + Math.max(0, Number(buy.fee) || 0),
      0,
    );
  const remaining = Math.max(0, scheduled - executed);
  const record = {
    period: period.start,
    carry: 0,
    scheduled,
    remaining: Math.round(remaining * 100) / 100,
    rolled: Math.round(rolled * 100) / 100,
  };
  return {
    ...record,
    executed,
    changed:
      existing.period !== record.period ||
      Number(existing.carry) !== record.carry ||
      Number(existing.scheduled) !== record.scheduled ||
      Number(existing.remaining) !== record.remaining,
  };
}

export function orderPreview(amount, price, options = {}) {
  const budget = Number(amount);
  const quote = Number(price);
  const tradingCost = typeof options === "number" ? { lot_size: options } : options || {};
  const allowInefficient = Boolean(tradingCost.allowInefficient);
  const lotSize = Math.max(1, Math.round(Number(tradingCost.lot_size) || 100));
  const minCommission = Math.max(0, Number(tradingCost.min_commission) || 0);
  const maxFeeRatio = Math.max(0, Number(tradingCost.max_fee_ratio_pct) || 0) / 100;
  const minimumEconomicAmount =
    minCommission > 0 && maxFeeRatio > 0 ? minCommission / maxFeeRatio : 0;
  const minimumEfficientShares =
    minimumEconomicAmount > 0 && quote > 0
      ? Math.max(lotSize, Math.ceil(minimumEconomicAmount / quote / lotSize) * lotSize)
      : lotSize;
  if (!(budget > 0) || !(quote > 0)) {
    return {
      shares: 0,
      estimatedAmount: 0,
      fee: 0,
      totalCash: 0,
      feeRatioPct: null,
      cashRemainder: Math.max(0, budget || 0),
      lotSize,
      minimumEfficientShares: 0,
      minimumEconomicAmount,
      inefficient: false,
      blockedReason: "invalid",
    };
  }
  let affordableShares = Math.floor(Math.max(0, budget - minCommission) / quote / lotSize) * lotSize;
  while (
    affordableShares > 0 &&
    affordableShares * quote + estimatedTradeFee(affordableShares * quote, tradingCost) > budget
  ) {
    affordableShares -= lotSize;
  }
  const affordableAmount = Math.round(affordableShares * quote * 100) / 100;
  const affordableFee = estimatedTradeFee(affordableAmount, tradingCost);
  const affordableFeeRatio = affordableAmount > 0 ? affordableFee / affordableAmount : null;
  const feeRatioAllowed =
    maxFeeRatio <= 0 ||
    (affordableFeeRatio != null && affordableFeeRatio <= maxFeeRatio + 1e-12);
  const efficient =
    affordableShares >= minimumEfficientShares && feeRatioAllowed;
  const shares = efficient || (allowInefficient && affordableShares >= lotSize) ? affordableShares : 0;
  const estimatedAmount = Math.round(shares * quote * 100) / 100;
  const fee = Math.round(estimatedTradeFee(estimatedAmount, tradingCost) * 100) / 100;
  const totalCash = Math.round((estimatedAmount + fee) * 100) / 100;
  const blockedReason =
    shares > 0
      ? null
      : affordableShares < lotSize
        ? "insufficient_lot"
        : affordableShares < minimumEfficientShares
          ? "fee_inefficient"
          : !feeRatioAllowed
            ? "fee_rate_exceeds_limit"
            : null;
  return {
    shares,
    estimatedAmount,
    fee,
    totalCash,
    feeRatioPct: estimatedAmount > 0 ? (fee / estimatedAmount) * 100 : null,
    cashRemainder: Math.round(Math.max(0, budget - totalCash) * 100) / 100,
    lotSize,
    minimumEfficientShares,
    minimumEconomicAmount,
    maxAffordableShares: affordableShares,
    inefficient: shares > 0 && !efficient,
    blockedReason,
  };
}

/** 按买卖记录推算含手续费的平均成本（移动加权平均）。 */
export function holdingFromTrades(buys = [], sells = [], symbol = "") {
  const events = [
    ...(buys || [])
      .filter((item) => item?.symbol === symbol)
      .map((item) => ({ ...item, side: "buy" })),
    ...(sells || [])
      .filter((item) => item?.symbol === symbol)
      .map((item) => ({ ...item, side: "sell" })),
  ].sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
  let shares = 0;
  let costValue = 0;
  let realizedPnl = 0;
  for (const event of events) {
    const qty = Math.max(0, Number(event.shares) || 0);
    const price = Math.max(0, Number(event.price) || 0);
    const fee = Math.max(0, Number(event.fee) || 0);
    if (!(qty > 0) || !(price > 0)) continue;
    if (event.side === "buy") {
      costValue += price * qty + fee;
      shares += qty;
      continue;
    }
    if (!(shares > 0)) continue;
    const sold = Math.min(shares, qty);
    const avg = costValue / shares;
    const proceeds = price * sold - fee * (sold / qty);
    realizedPnl += proceeds - avg * sold;
    costValue -= avg * sold;
    shares -= sold;
  }
  const roundedShares = Math.round(shares * 1e4) / 1e4;
  return {
    shares: roundedShares,
    cost: roundedShares > 0 ? Math.round((costValue / roundedShares) * 1e6) / 1e6 : 0,
    costValue: Math.round(costValue * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
  };
}

export function projectedPosition({
  currentValue = 0,
  portfolioValue = 0,
  buyAmount = 0,
  targetWeight = null,
  tolerance = 5,
  enforceCeiling = true,
} = {}) {
  const nextPortfolioValue = Math.max(0, Number(portfolioValue)) + Math.max(0, Number(buyAmount));
  const nextValue = Math.max(0, Number(currentValue)) + Math.max(0, Number(buyAmount));
  const currentWeight = portfolioValue > 0 ? (Number(currentValue) / Number(portfolioValue)) * 100 : null;
  const projectedWeight = nextPortfolioValue > 0 ? (nextValue / nextPortfolioValue) * 100 : null;
  const maxWeight = targetWeight == null ? null : Number(targetWeight) + tolerance;
  const overTarget = currentWeight != null && maxWeight != null && currentWeight > maxWeight;
  const atOrOverCeiling = currentWeight != null && maxWeight != null && currentWeight >= maxWeight;
  const wouldOverTarget =
    projectedWeight != null && maxWeight != null && projectedWeight > maxWeight;
  return {
    currentWeight,
    projectedWeight,
    projectedDrift: projectedWeight != null && targetWeight != null ? projectedWeight - Number(targetWeight) : null,
    maxWeight,
    overweight: overTarget,
    blocked: enforceCeiling ? atOrOverCeiling : false,
    wouldExceed: enforceCeiling ? wouldOverTarget : false,
  };
}

function dailyReturns(points = []) {
  const returns = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = Number(points[index - 1]?.close);
    const current = Number(points[index]?.close);
    if (previous > 0 && current > 0) returns.push({ date: points[index].date, value: current / previous - 1 });
  }
  return returns;
}

export function riskMetrics(points = []) {
  const clean = points.filter((point) => Number(point?.close) > 0);
  if (clean.length < 2) return null;
  const returns = dailyReturns(clean);
  const mean = returns.reduce((sum, item) => sum + item.value, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((sum, item) => sum + (item.value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  let peak = Number(clean[0].close);
  let maxDrawdown = 0;
  let underwater = 0;
  let longestUnderwater = 0;
  for (const point of clean) {
    const close = Number(point.close);
    if (close >= peak) {
      peak = close;
      underwater = 0;
    } else {
      underwater += 1;
      longestUnderwater = Math.max(longestUnderwater, underwater);
      maxDrawdown = Math.min(maxDrawdown, close / peak - 1);
    }
  }
  const years = Math.max(1 / 252, returns.length / 252);
  const annualizedReturn = (Number(clean.at(-1).close) / Number(clean[0].close)) ** (1 / years) - 1;
  return {
    annualizedVolatilityPct: Math.sqrt(variance * 252) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    longestUnderwaterDays: longestUnderwater,
    annualizedReturnPct: annualizedReturn * 100,
    samples: clean.length,
  };
}

export function returnCorrelation(leftPoints = [], rightPoints = []) {
  const left = new Map(dailyReturns(leftPoints).map((item) => [item.date, item.value]));
  const pairs = dailyReturns(rightPoints)
    .filter((item) => left.has(item.date))
    .map((item) => [left.get(item.date), item.value]);
  if (pairs.length < 20) return null;
  const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const [leftValue, rightValue] of pairs) {
    covariance += (leftValue - leftMean) * (rightValue - rightMean);
    leftVariance += (leftValue - leftMean) ** 2;
    rightVariance += (rightValue - rightMean) ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? { value: covariance / denominator, samples: pairs.length } : null;
}
