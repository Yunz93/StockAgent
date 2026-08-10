import test from "node:test";
import assert from "node:assert/strict";

import {
  cycleExecution,
  estimatedTradeFee,
  holdingFromTrades,
  orderPreview,
  cashReserveHintBalance,
  pendingOrderState,
  planExecutionContext,
  planPeriod,
  projectedPosition,
  returnCorrelation,
  riskMetrics,
  stampInitialBuildStarted,
} from "../js/decision-support.js";

test("monthly plan exposes current cycle and scheduled day", () => {
  const period = planPeriod({ cadence: "monthly", day: 15 }, new Date(2026, 6, 10));
  assert.deepEqual(period, {
    start: "2026-07-01",
    end: "2026-08-01",
    scheduled: "2026-07-15",
    daysToScheduled: 5,
  });
});

test("cycle execution subtracts recorded buys and detects completion", () => {
  const cycle = cycleExecution({
    plan: { cadence: "monthly", day: 1 },
    symbol: "512890",
    recommendedAmount: 1000,
    now: new Date(2026, 6, 28),
    buys: [
      { symbol: "512890", date: "2026-07-02", price: 1, shares: 1000 },
      { symbol: "512890", date: "2026-06-02", price: 1, shares: 1000 },
    ],
  });
  assert.equal(cycle.executedAmount, 1000);
  assert.equal(cycle.remainingAmount, 0);
  assert.equal(cycle.status, "completed");
  assert.equal(cycle.matchingCount, 1);
});

test("order preview uses board lots and preserves residual cash", () => {
  const preview = orderPreview(1548, 1.266);
  assert.equal(preview.shares, 1200);
  assert.equal(preview.estimatedAmount, 1519.2);
  assert.ok(Math.abs(preview.cashRemainder - 28.8) < 1e-8);
});

test("order preview includes minimum commission and blocks inefficient small orders", () => {
  const tradingCost = {
    min_commission: 5,
    commission_rate_pct: 0.03,
    max_fee_ratio_pct: 0.25,
    lot_size: 100,
  };
  const blocked = orderPreview(2000, 1.275, tradingCost);
  assert.equal(blocked.shares, 0);
  assert.equal(blocked.minimumEfficientShares, 1600);
  assert.equal(blocked.blockedReason, "fee_inefficient");

  const executable = orderPreview(2045, 1.275, tradingCost);
  assert.equal(executable.shares, 1600);
  assert.equal(executable.estimatedAmount, 2040);
  assert.equal(executable.fee, 5);
  assert.equal(executable.totalCash, 2045);
  assert.ok(executable.feeRatioPct < 0.25);
  assert.equal(estimatedTradeFee(2040, tradingCost), 5);

  const forced = orderPreview(2000, 1.275, { ...tradingCost, allowInefficient: true });
  assert.equal(forced.shares, 1500);
  assert.equal(forced.inefficient, true);
  assert.ok(forced.feeRatioPct > 0.25);
});

test("holding cost basis includes buy fees and sell net proceeds", () => {
  const holding = holdingFromTrades(
    [{ id: "b1", symbol: "512890", date: "2026-01-01", price: 1, shares: 1000, fee: 5 }],
    [{ id: "s1", symbol: "512890", date: "2026-02-01", price: 1.1, shares: 400, fee: 5 }],
    "512890",
  );
  assert.equal(holding.shares, 600);
  assert.ok(Math.abs(holding.cost - 1.005) < 1e-9);
  assert.ok(holding.realizedPnl > 0);
});

test("initial build budget is independent from recurring contribution", () => {
  const context = planExecutionContext({
    plan: {
      amount: 5000,
      capital_base: 100000,
      initial_target_pct: 30,
      initial_months: 1,
    },
    holdings: [{ marketValue: 10000 }],
  });
  assert.equal(context.phase, "initial");
  assert.equal(context.targetAmount, 30000);
  assert.equal(context.budget, 20000);
});

test("initial build spreads remaining gap across remaining months", () => {
  const context = planExecutionContext({
    plan: {
      amount: 5000,
      capital_base: 100000,
      initial_target_pct: 30,
      initial_months: 6,
      cadence: "monthly",
    },
    holdings: [{ marketValue: 10000 }],
  });
  assert.equal(context.phase, "initial");
  assert.equal(context.initialMonths, 6);
  assert.equal(context.remainingMonths, 6);
  assert.equal(context.initialGap, 20000);
  // 尚缺 20000 ÷ 剩余 6 个月，不再按原始目标 30000 均分
  assert.equal(context.monthlyInstallment, 3333.33);
  assert.equal(context.budget, 3333.33);
});

test("initial build weekly cadence splits the monthly installment", () => {
  const context = planExecutionContext({
    plan: {
      capital_base: 120000,
      initial_target_pct: 50,
      initial_months: 4,
      cadence: "weekly",
    },
    holdings: [{ marketValue: 0 }],
  });
  // 尚缺 60000 / 4 months = 15000/month / 4 weeks = 3750
  assert.equal(context.monthlyInstallment, 15000);
  assert.equal(context.budget, 3750);
});

test("initial build catch-up uses full remaining gap after horizon elapsed", () => {
  const context = planExecutionContext({
    plan: {
      capital_base: 100000,
      initial_target_pct: 30,
      initial_months: 6,
      cadence: "monthly",
      initial_build_started_at: "2025-01-10T00:00:00.000Z",
    },
    holdings: [{ marketValue: 10000 }],
    now: new Date("2025-08-10T00:00:00.000Z"),
  });
  assert.equal(context.remainingMonths, 1);
  assert.equal(context.budget, 20000);
});

test("stampInitialBuildStarted writes once for configured plans", () => {
  const first = stampInitialBuildStarted(
    { capital_base: 100000, initial_target_pct: 30 },
    new Date("2026-08-10T00:00:00.000Z"),
  );
  assert.equal(first.changed, true);
  assert.equal(first.plan.initial_build_started_at, "2026-08-10T00:00:00.000Z");
  const second = stampInitialBuildStarted(first.plan, new Date("2026-09-01T00:00:00.000Z"));
  assert.equal(second.changed, false);
  assert.equal(second.plan.initial_build_started_at, "2026-08-10T00:00:00.000Z");
});

test("completed initial build stays in recurring mode after a drawdown", () => {
  const context = planExecutionContext({
    plan: {
      amount: 5000,
      capital_base: 100000,
      initial_target_pct: 30,
      initial_build_completed_at: "2026-07-30T00:00:00Z",
    },
    holdings: [{ marketValue: 24000 }],
  });
  assert.equal(context.phase, "recurring");
  assert.equal(context.budget, 5000);
});

test("recurring pending order does not roll remaining into next period", () => {
  const plan = {
    cadence: "monthly",
    day: 1,
    pending_orders: {
      "512890": {
        period: "2026-06-01",
        carry: 0,
        scheduled: 800,
        remaining: 800,
      },
    },
  };
  const pending = pendingOrderState({
    plan,
    symbol: "512890",
    recommendedAmount: 900,
    buys: [],
    now: new Date(2026, 6, 10),
    phase: "recurring",
  });
  assert.equal(pending.carry, 0);
  assert.equal(pending.rolled, 0);
  assert.equal(pending.scheduled, 900);
  assert.equal(pending.remaining, 900);
});

test("initial build rolls prior-period remaining so sub-lot dust can accumulate", () => {
  const plan = {
    cadence: "monthly",
    day: 1,
    pending_orders: {
      "512890": {
        period: "2026-06-01",
        carry: 0,
        scheduled: 800,
        remaining: 800,
      },
    },
  };
  const pending = pendingOrderState({
    plan,
    symbol: "512890",
    recommendedAmount: 900,
    buys: [],
    now: new Date(2026, 6, 10),
    phase: "initial",
  });
  assert.equal(pending.carry, 0);
  assert.equal(pending.rolled, 800);
  assert.equal(pending.scheduled, 1700);
  assert.equal(pending.remaining, 1700);
});

test("legacy stored carry is ignored within the same period", () => {
  const plan = {
    cadence: "monthly",
    day: 1,
    pending_orders: {
      "512890": {
        period: "2026-07-01",
        carry: 500,
        scheduled: 800,
        remaining: 1300,
      },
    },
  };
  const pending = pendingOrderState({
    plan,
    symbol: "512890",
    recommendedAmount: 1000,
    buys: [{ symbol: "512890", date: "2026-07-05", price: 1, shares: 200, fee: 0 }],
    now: new Date(2026, 6, 10),
  });
  assert.equal(pending.carry, 0);
  assert.equal(pending.scheduled, 1000);
  assert.equal(pending.remaining, 800); // 1000 - 200，不含旧 carry
});

test("cashReserveHintBalance only surfaces positive balances", () => {
  assert.equal(cashReserveHintBalance({}), 0);
  assert.equal(cashReserveHintBalance({ cash_reserve: { balance: 0 } }), 0);
  assert.equal(cashReserveHintBalance({ cash_reserve: { balance: 0.005 } }), 0);
  assert.equal(cashReserveHintBalance({ cash_reserve: { balance: 1500.5 } }), 1500.5);
});

test("projected position enforces the ceiling by default", () => {
  const hard = projectedPosition({
    currentValue: 20_000,
    portfolioValue: 40_000,
    buyAmount: 2_000,
    targetWeight: 30,
  });
  assert.equal(hard.currentWeight, 50);
  assert.ok(hard.projectedWeight > 52);
  assert.equal(hard.maxWeight, 35);
  assert.equal(hard.overweight, true);
  assert.equal(hard.blocked, true);
  assert.equal(hard.wouldExceed, true);

  const advisoryOnly = projectedPosition({
    currentValue: 20_000,
    portfolioValue: 40_000,
    buyAmount: 2_000,
    targetWeight: 30,
    enforceCeiling: false,
  });
  assert.equal(advisoryOnly.blocked, false);
  assert.equal(advisoryOnly.wouldExceed, false);
});

test("risk metrics report drawdown and annualized volatility", () => {
  const points = [
    { date: "2026-01-01", close: 100 },
    { date: "2026-01-02", close: 110 },
    { date: "2026-01-03", close: 88 },
    { date: "2026-01-04", close: 99 },
  ];
  const metrics = riskMetrics(points);
  assert.equal(Math.round(metrics.maxDrawdownPct), -20);
  assert.equal(metrics.longestUnderwaterDays, 2);
  assert.ok(metrics.annualizedVolatilityPct > 0);
});

test("return correlation uses aligned daily returns", () => {
  const left = [];
  const right = [];
  for (let index = 0; index < 30; index += 1) {
    left.push({ date: `2026-01-${String(index + 1).padStart(2, "0")}`, close: 100 + index });
    right.push({ date: `2026-01-${String(index + 1).padStart(2, "0")}`, close: 200 + index * 2 });
  }
  const correlation = returnCorrelation(left, right);
  assert.ok(correlation.value > 0.99);
  assert.equal(correlation.samples, 29);
});
