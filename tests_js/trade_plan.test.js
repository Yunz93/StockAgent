import test from "node:test";
import assert from "node:assert/strict";

import { buildRebalanceSellSuggestions } from "../js/rebalance-sell.js";
import {
  buildTradePlan,
  projectPortfolioAfterBuys,
  validateTradePlanConflicts,
} from "../js/trade-plan.js";

const COST = {
  min_commission: 5,
  commission_rate_pct: 0.03,
  max_fee_ratio_pct: 0.25,
  lot_size: 100,
};

test("initial phase relative overweight without absolute excess does not sell", () => {
  // A500 ~21088 / total ~39909 ≈ 52.8% vs target 30%, but absolute target 36000
  const holdings = [
    {
      symbol: "563360",
      name: "A500",
      targetWeight: 30,
      actualWeight: 52.8,
      marketValue: 21088,
      pePct: 0.9,
      grade: "E",
      assetClass: "equity_core",
      shares: 10000,
      analyzed: true,
      indexCode: "000510",
    },
    {
      symbol: "512890",
      name: "红利",
      targetWeight: 70,
      actualWeight: 47.2,
      marketValue: 18821,
      pePct: 0.4,
      grade: "C",
      assetClass: "dividend",
      shares: 10000,
      analyzed: true,
      indexCode: "H30269",
    },
  ];
  const quotes = {
    "563360": {
      price: 2.1,
      market_timestamp: new Date().toISOString(),
      product_quality: { premium_discount_pct: 0.1, bid_ask_spread_pct: 0.05 },
    },
    "512890": {
      price: 1.0,
      market_timestamp: new Date().toISOString(),
      product_quality: { premium_discount_pct: 0.1, bid_ask_spread_pct: 0.05 },
    },
  };
  const plan = {
    capital_base: 200000,
    initial_target_pct: 60,
    strategy: "fixed",
    trading_cost: COST,
    execution_policy: {},
  };
  const sells = buildRebalanceSellSuggestions({
    holdings,
    quotes,
    plan,
    now: new Date("2026-07-15"),
    phase: "initial",
    absoluteTargetsBySymbol: { "563360": 36000, "512890": 84000 },
  });
  assert.equal(sells.length, 0);
});

test("initial phase sells only absolute excess when rich", () => {
  const holdings = [
    {
      symbol: "563360",
      targetWeight: 30,
      actualWeight: 60,
      marketValue: 50000,
      pePct: 0.92,
      grade: "E",
      assetClass: "equity_core",
      shares: 25000,
      analyzed: true,
    },
    {
      symbol: "512890",
      targetWeight: 70,
      actualWeight: 40,
      marketValue: 33333,
      pePct: 0.4,
      assetClass: "dividend",
      shares: 30000,
      analyzed: true,
    },
  ];
  const quotes = {
    "563360": {
      price: 2,
      market_timestamp: new Date().toISOString(),
      product_quality: { premium_discount_pct: 0.1, bid_ask_spread_pct: 0.05 },
    },
    "512890": {
      price: 1,
      market_timestamp: new Date().toISOString(),
      product_quality: { premium_discount_pct: 0.1, bid_ask_spread_pct: 0.05 },
    },
  };
  const sells = buildRebalanceSellSuggestions({
    holdings,
    quotes,
    plan: { trading_cost: COST, capital_base: 200000, initial_target_pct: 60 },
    now: new Date("2026-07-15"),
    phase: "initial",
    absoluteTargetsBySymbol: { "563360": 36000, "512890": 84000 },
  });
  assert.equal(sells.length, 1);
  assert.ok(sells[0].suggested_amount <= 14000 + 1e-6);
  assert.ok(50000 - sells[0].suggested_amount >= 36000 - 1);
});

test("initial phase disables January annual rebalance", () => {
  const holdings = [
    {
      symbol: "512890",
      targetWeight: 20,
      actualWeight: 40,
      marketValue: 40000,
      pePct: 0.5,
      grade: "C",
      assetClass: "dividend",
      shares: 40000,
    },
    {
      symbol: "510300",
      targetWeight: 80,
      actualWeight: 60,
      marketValue: 60000,
      pePct: 0.5,
      assetClass: "equity_core",
      shares: 15000,
    },
  ];
  const quotes = {
    "512890": { price: 1, market_timestamp: new Date().toISOString(), product_quality: { premium_discount_pct: 0, bid_ask_spread_pct: 0.05 } },
    "510300": { price: 4, market_timestamp: new Date().toISOString(), product_quality: { premium_discount_pct: 0, bid_ask_spread_pct: 0.05 } },
  };
  const sells = buildRebalanceSellSuggestions({
    holdings,
    quotes,
    plan: { trading_cost: COST },
    now: new Date("2026-01-15"),
    phase: "initial",
    absoluteTargetsBySymbol: { "512890": 50000, "510300": 200000 },
  });
  assert.equal(sells.length, 0);
});

test("conflicts block both sides; premium block keeps waiting cash", () => {
  const conflicts = validateTradePlanConflicts({
    buyDrafts: [{ symbol: "512890", status: "pending" }],
    sellDrafts: [{ symbol: "512890", status: "pending" }],
  });
  assert.equal(conflicts.length, 1);

  const holdings = [
    {
      symbol: "513500",
      name: "标普",
      targetWeight: 50,
      actualWeight: 0,
      marketValue: 0,
      pePct: 0.5,
      grade: "C",
      assetClass: "equity_growth",
      analyzed: true,
      indexCode: "SPX",
      shares: 0,
    },
    {
      symbol: "563360",
      name: "A500",
      targetWeight: 50,
      actualWeight: 0,
      marketValue: 0,
      pePct: 0.4,
      grade: "B",
      assetClass: "equity_core",
      analyzed: true,
      indexCode: "000510",
      shares: 0,
    },
  ];
  const now = new Date();
  const quotes = {
    "513500": {
      price: 1,
      market_timestamp: now.toISOString(),
      product_quality: { premium_discount_pct: 8.31, bid_ask_spread_pct: 0.05 },
    },
    "563360": {
      price: 1,
      market_timestamp: now.toISOString(),
      product_quality: { premium_discount_pct: 0.2, bid_ask_spread_pct: 0.05 },
    },
  };
  const poolAllocation = {
    allocations: [
      { symbol: "513500", name: "标普", amount: 5000, band: "定额" },
      { symbol: "563360", name: "A500", amount: 5000, band: "定额" },
    ],
  };
  const plan = buildTradePlan({
    plan: {
      amount: 10000,
      strategy: "fixed",
      trading_cost: COST,
      execution_policy: {},
      cadence: "monthly",
      day: 1,
    },
    phase: "recurring",
    holdings,
    poolAllocation,
    quotes,
    now,
  });
  const blocked = plan.buyDrafts.find((d) => d.symbol === "513500");
  const ok = plan.buyDrafts.find((d) => d.symbol === "563360");
  assert.equal(blocked.readiness_status, "blocked");
  assert.ok(plan.summary.waitingCash >= 5000);
  assert.ok(ok);
  // blocked amount not redistributed: A500 still ~5000 strategic
  assert.ok(Math.abs(ok.suggested_amount - 5000) < 1);
});

test("projectPortfolioAfterBuys updates weights", () => {
  const projected = projectPortfolioAfterBuys({
    holdings: [
      { symbol: "A", marketValue: 1000, shares: 1000, targetWeight: 50 },
      { symbol: "B", marketValue: 1000, shares: 1000, targetWeight: 50 },
    ],
    buyDrafts: [{ symbol: "A", side: "buy", shares: 1000, price: 1 }],
  });
  const a = projected.find((r) => r.symbol === "A");
  assert.ok(a.actualWeight > 50);
});

test("fee/lot blocked sizing becomes warning with reasons and zero shares", () => {
  const now = new Date();
  const holdings = [
    {
      symbol: "513010",
      name: "恒生科技",
      targetWeight: 100,
      actualWeight: 0,
      marketValue: 0,
      pePct: 0.5,
      grade: "C",
      assetClass: "equity_growth",
      analyzed: true,
      indexCode: "HSTECH",
      shares: 0,
    },
  ];
  const plan = buildTradePlan({
    plan: {
      amount: 1726,
      strategy: "fixed",
      trading_cost: COST,
      execution_policy: {},
      cadence: "monthly",
      day: 1,
    },
    phase: "recurring",
    holdings,
    poolAllocation: {
      allocations: [{ symbol: "513010", name: "恒生科技", amount: 1726, band: "正常区" }],
    },
    quotes: {
      "513010": {
        price: 0.637,
        market_timestamp: now.toISOString(),
        product_quality: { premium_discount_pct: -0.76, bid_ask_spread_pct: 0.16 },
      },
    },
    now,
  });
  const draft = plan.buyDrafts.find((d) => d.symbol === "513010");
  assert.ok(draft);
  assert.equal(draft.readiness_status, "warning");
  assert.equal(draft.shares, 0);
  assert.ok(draft.readiness_reasons.some((r) => r.includes("手续费率超过限制")));
  assert.equal(draft.readiness_reasons.filter((r) => r.includes("不满足整手")).length, 0);
});
