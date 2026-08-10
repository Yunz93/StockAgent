import test from "node:test";
import assert from "node:assert/strict";

import { state } from "../js/state.js";
import { buildExecutionDraftsFromAllocation } from "../js/execution-drafts.js";
import { confirmDraftIntoLedger } from "../js/trade-apply.js";

function seedPlanState() {
  state.etfs = [
    { symbol: "512890", name: "红利低波ETF", shares: 0, cost: 0, target_weight: 60 },
    { symbol: "510300", name: "沪深300ETF", shares: 0, cost: 0, target_weight: 40 },
  ];
  state.quotesBySymbol = {
    "512890": {
      price: 1.0,
      market_timestamp: "2026-07-15T10:00:00.000Z",
      product_quality: { premium_discount_pct: 0.1, bid_ask_spread_pct: 0.05 },
    },
    "510300": {
      price: 4.0,
      market_timestamp: "2026-07-15T10:00:00.000Z",
      product_quality: { premium_discount_pct: 0.1, bid_ask_spread_pct: 0.05 },
    },
  };
  state.analysisCache = {
    "512890": {
      supported: true,
      valuation: { pe_percentile_10y: 0.15 },
      score: { grade: "A" },
      asset_class: "dividend",
    },
    "510300": {
      supported: true,
      valuation: { pe_percentile_10y: 0.55 },
      score: { grade: "C" },
      asset_class: "equity_core",
    },
  };
  state.plan = {
    name: "E2E",
    amount: 5000,
    capital_base: 0,
    initial_target_pct: 0,
    cadence: "monthly",
    day: 1,
    strategy: "valuation",
    strategy_config: {
      pe_bands: [
        { max_pct: 20, mult: 1.5, label: "低估区" },
        { max_pct: 40, mult: 1.2, label: "偏低区" },
        { max_pct: 60, mult: 1.0, label: "正常区" },
        { max_pct: 80, mult: 0.5, label: "偏高区" },
        { max_pct: 100, mult: 0, label: "高估区" },
      ],
      grade_mult: { A: 1.5, B: 1.2, C: 1.0, D: 0.5, E: 0 },
      use_rebalance: true,
      sentiment: { enabled: false },
    },
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.03,
      max_fee_ratio_pct: 0.25,
      lot_size: 100,
    },
    pending_orders: {},
    cash_reserve: { balance: 0, history: [] },
  };
  state.executionDrafts = [];
  state.buys = [];
  state.sells = [];
}

test("E2E: generate drafts → confirm → holdings shares/cost update", () => {
  seedPlanState();
  const now = new Date("2026-07-15T10:00:00");
  const drafts = buildExecutionDraftsFromAllocation({ now });
  state.executionDrafts = drafts;

  const pendingBuys = drafts.filter(
    (item) => item.status === "pending" && item.side !== "sell" && Number(item.shares) > 0,
  );
  assert.ok(pendingBuys.length >= 1, "should create at least one buy draft");

  const draft = pendingBuys[0];
  const before = state.etfs.find((item) => item.symbol === draft.symbol);
  assert.equal(before.shares, 0);

  const result = confirmDraftIntoLedger({
    draft,
    etfs: state.etfs,
    buys: state.buys,
    sells: state.sells,
    executionDrafts: state.executionDrafts,
    plan: state.plan,
    tradingCost: state.plan.trading_cost,
    now,
  });

  state.etfs = result.etfs;
  state.buys = result.buys;
  state.sells = result.sells;
  state.executionDrafts = result.executionDrafts;

  const after = state.etfs.find((item) => item.symbol === draft.symbol);
  assert.equal(after.shares, draft.shares);
  assert.ok(after.cost > 0, "cost should sync from trade including fee");
  assert.equal(result.trade.symbol, draft.symbol);
  assert.equal(result.confirmedDraft.status, "confirmed");
  assert.equal(result.confirmedDraft.confirmed_trade_id, result.trade.id);
  assert.equal(state.buys.length, 1);
  assert.equal(state.buys[0].shares, draft.shares);
});
