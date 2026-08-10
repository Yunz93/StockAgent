import test from "node:test";
import assert from "node:assert/strict";

import { getPeriodAdvice, STANCE } from "../js/period-advice.js";
import { setAppConfig } from "../js/state.js";

test("period advice invests when strategy allocation assigns amount", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: { amount: 2000, strategy: "fixed" },
    holdings: [
      { symbol: "512890", name: "红利低波", targetWeight: 40, actualWeight: 44.9, pePct: 0.9, grade: "E" },
      { symbol: "563360", name: "A500", targetWeight: 60, pePct: 0.9, grade: "E" },
    ],
  });
  assert.equal(advice.stance, STANCE.INVEST);
  assert.equal(advice.amount, 800);
  assert.match(advice.headline, /本期建议投入/);
  assert.equal(advice.canAdd, true);
  assert.equal(advice.bullets[0], "定投倍率 1×");
  assert.ok(advice.bullets.includes("约占全池部署 40%"));
  assert.deepEqual(advice.position, {
    targetWeight: 40,
    actualWeight: 44.9,
    drift: 4.9,
    maxWeight: 45,
    overweight: false,
    blocked: false,
  });
});

test("period advice hard-blocks an already overweight holding", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: { amount: 2000, strategy: "fixed" },
    holdings: [
      { symbol: "512890", name: "红利低波", targetWeight: 40, actualWeight: 55 },
      { symbol: "563360", name: "A500", targetWeight: 60, actualWeight: 45 },
    ],
  });
  assert.equal(advice.stance, STANCE.SKIP);
  assert.equal(advice.amount, 0);
  assert.equal(advice.position.blocked, true);
  assert.equal(advice.position.overweight, true);
});

test("period advice applies the same same-index winner as pool allocation", () => {
  setAppConfig({
    etf: {
      analysis_registry: {
        EXPENSIVE: { index_code: "IDX" },
        CHEAP: { index_code: "IDX" },
      },
      products: {
        EXPENSIVE: { annual_fee_pct: 0.6, fund_size_yi: 100 },
        CHEAP: { annual_fee_pct: 0.2, fund_size_yi: 50 },
      },
    },
  });
  const holdings = [
    { symbol: "EXPENSIVE", targetWeight: 50 },
    { symbol: "CHEAP", targetWeight: 50 },
  ];
  const expensive = getPeriodAdvice({
    symbol: "EXPENSIVE",
    plan: { amount: 2000, strategy: "fixed" },
    holdings,
  });
  const cheap = getPeriodAdvice({
    symbol: "CHEAP",
    plan: { amount: 2000, strategy: "fixed" },
    holdings,
  });
  setAppConfig(null);
  assert.equal(expensive.stance, STANCE.SKIP);
  assert.equal(expensive.amount, 0);
  assert.equal(cheap.stance, STANCE.INVEST);
  assert.equal(cheap.amount, 2000);
});

test("period advice holds cash when valuation pauses the whole pool", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: { amount: 2000, strategy: "valuation" },
    holdings: [
      { symbol: "512890", targetWeight: 50, pePct: 0.9, grade: "B" },
      { symbol: "563360", targetWeight: 50, pePct: 0.85, grade: "A" },
    ],
  });
  assert.equal(advice.stance, STANCE.HOLD_CASH);
  assert.equal(advice.amount, 0);
  assert.equal(advice.canAdd, false);
  assert.match(advice.headline, /不投/);
  assert.match(advice.bullets.join(" "), /留现金/);
});

test("period advice skips one name without inventing a buy when others deploy", () => {
  const advice = getPeriodAdvice({
    symbol: "563360",
    plan: { amount: 2000, strategy: "custom", strategy_config: {
      pe_bands: [
        { max_pct: 50, mult: 1.5, label: "便宜" },
        { max_pct: 100, mult: 0, label: "贵" },
      ],
      use_rebalance: false,
    } },
    holdings: [
      { symbol: "512890", targetWeight: 50, pePct: 0.3 },
      { symbol: "563360", targetWeight: 50, pePct: 0.9 },
    ],
  });
  assert.equal(advice.stance, STANCE.SKIP);
  assert.equal(advice.amount, 0);
  assert.equal(advice.canAdd, false);
  assert.match(advice.headline, /本期不投/);
});

test("period advice exposes multiplier breakdown when overlays apply", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: {
      amount: 2000,
      strategy: "valuation",
      strategy_config: {
        pe_bands: [
          { max_pct: 50, mult: 1.5, label: "便宜" },
          { max_pct: 100, mult: 1, label: "正常" },
        ],
        sentiment: {
          enabled: true,
          mode: "overlay",
          extremes_only: false,
          apply_to: ["valuation"],
          bands: [
            { max_score: 50, mult: 1.2, label: "偏冷" },
            { max_score: 100, mult: 1, label: "中性" },
          ],
          market_by_asset_class: { dividend: "A" },
        },
      },
    },
    holdings: [
      {
        symbol: "512890",
        targetWeight: 100,
        pePct: 0.2,
        grade: "A",
        assetClass: "dividend",
      },
    ],
    sentimentByMarket: {
      A: { score: 30, zone: "fear", ok: true },
    },
  });
  assert.match(advice.bullets[0], /倍率拆解：/);
  assert.match(advice.bullets[0], /策略 1\.5×（低估区）/);
  assert.match(advice.bullets[0], /情绪 1\.2×/);
  assert.match(advice.bullets[0], /= 1\.8×/);
  assert.equal(advice.multBreakdown?.factors?.length, 2);
  assert.equal(advice.multBreakdown.factors[0].role, "策略");
  assert.equal(advice.multBreakdown.factors[1].role, "情绪");
  assert.equal(advice.multBreakdown.result, "1.8×");
});

test("period advice asks for budget before inventing amounts", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: { amount: 0, strategy: "valuation" },
    holdings: [{ symbol: "512890", targetWeight: 100, pePct: 0.3 }],
  });
  assert.equal(advice.stance, STANCE.NEED_BUDGET);
  assert.match(advice.headline, /全池每期预算/);
});

test("period advice uses initial build gap instead of recurring budget", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: {
      amount: 5000,
      capital_base: 100000,
      initial_target_pct: 30,
      initial_months: 1,
      strategy: "fixed",
    },
    holdings: [
      {
        symbol: "512890",
        targetWeight: 100,
        actualWeight: 100,
        marketValue: 10000,
      },
    ],
  });
  assert.equal(advice.execution.phase, "initial");
  assert.equal(advice.pool.budget, 20000);
  assert.equal(advice.amount, 20000);
  assert.match(advice.headline, /建议投入/);
});

test("period advice uses monthly installment during multi-month initial build", () => {
  const advice = getPeriodAdvice({
    symbol: "512890",
    plan: {
      amount: 5000,
      capital_base: 100000,
      initial_target_pct: 30,
      initial_months: 6,
      cadence: "monthly",
      strategy: "fixed",
    },
    holdings: [
      {
        symbol: "512890",
        targetWeight: 100,
        actualWeight: 100,
        marketValue: 10000,
      },
    ],
  });
  assert.equal(advice.execution.phase, "initial");
  assert.equal(advice.pool.budget, 5000);
  assert.equal(advice.amount, 5000);
});
