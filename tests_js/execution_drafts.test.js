import test from "node:test";
import assert from "node:assert/strict";

import { state } from "../js/state.js";
import { normalizeExecutionDrafts } from "../js/workspace_model.js";
import {
  bookCashReserveSell,
  buildExecutionDraftsFromAllocation,
  executionDraftSummary,
  sellSuggestionForSymbol,
  settleCashReserveOnPeriodComplete,
  updateExecutionDraft,
} from "../js/execution-drafts.js";
import { normalizePlan } from "../js/workspace_model.js";

test("execution draft normalization pads symbols and drops invalid rows", () => {
  const drafts = normalizeExecutionDrafts([
    {
      id: "draft_1",
      period: "2026-07-01",
      symbol: "512890",
      suggested_amount: 1200,
      price: 1.2,
      shares: 1000,
      fee: 5,
      date: "2026-07-30",
      status: "pending",
    },
    { period: "bad", symbol: "512890", suggested_amount: 100 },
    {
      period: "2026-07-01",
      symbol: "sh510300",
      suggested_amount: 800,
      price: 4,
      shares: 200,
      status: "skipped",
      skip_reason: "已手动下单",
    },
  ]);
  assert.equal(drafts.length, 2);
  assert.equal(drafts.find((item) => item.symbol === "510300").status, "skipped");
  assert.equal(drafts[0].period, "2026-07-01");
});

test("buildExecutionDraftsFromAllocation creates lot-sized pending drafts", () => {
  state.etfs = [
    { symbol: "512890", name: "红利低波ETF", shares: 0, target_weight: 60 },
    { symbol: "510300", name: "沪深300ETF", shares: 0, target_weight: 40 },
  ];
  state.quotesBySymbol = {
    "512890": { price: 1.0 },
    "510300": { price: 4.0 },
  };
  state.analysisCache = {
    "512890": { supported: true, valuation: { pe_percentile_10y: 0.15 }, score: { grade: "A" }, asset_class: "dividend" },
    "510300": { supported: true, valuation: { pe_percentile_10y: 0.55 }, score: { grade: "C" }, asset_class: "equity_core" },
  };
  state.plan = {
    name: "测试",
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
    },
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.03,
      max_fee_ratio_pct: 0.25,
      lot_size: 100,
    },
    pending_orders: {},
  };
  state.executionDrafts = [];
  state.buys = [];
  state.sells = [];

  const drafts = buildExecutionDraftsFromAllocation({ now: new Date("2026-07-15T10:00:00") });
  assert.ok(drafts.length >= 1);
  assert.ok(drafts.every((item) => item.shares % 100 === 0));
  assert.ok(drafts.every((item) => item.status === "pending"));
  assert.ok(drafts.every((item) => item.period === "2026-07-01"));
  assert.ok(drafts.every((item) => item.side === "buy"));
});

test("buildExecutionDraftsFromAllocation includes sell-side drafts when overweight rich", () => {
  state.etfs = [
    { symbol: "512890", name: "红利低波ETF", shares: 40000, target_weight: 20, cost: 1 },
    { symbol: "510300", name: "沪深300ETF", shares: 15000, target_weight: 80, cost: 4 },
  ];
  state.quotesBySymbol = {
    "512890": { price: 1.0 },
    "510300": { price: 4.0 },
  };
  // 512890 MV 40000 / total 100000 = 40% vs target 20%, pe rich
  state.analysisCache = {
    "512890": {
      supported: true,
      valuation: { pe_percentile_10y: 0.92 },
      score: { grade: "E" },
      asset_class: "dividend",
    },
    "510300": {
      supported: true,
      valuation: { pe_percentile_10y: 0.4 },
      score: { grade: "C" },
      asset_class: "equity_core",
    },
  };
  state.plan = {
    amount: 2000,
    capital_base: 0,
    initial_target_pct: 0,
    cadence: "monthly",
    day: 1,
    strategy: "fixed",
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.03,
      max_fee_ratio_pct: 0.25,
      lot_size: 100,
    },
    pending_orders: {},
  };
  state.executionDrafts = [];
  const drafts = buildExecutionDraftsFromAllocation({ now: new Date("2026-07-15T10:00:00") });
  const sell = drafts.find((item) => item.side === "sell" && item.symbol === "512890");
  assert.ok(sell);
  assert.equal(sell.id, "draft_2026-07-01_512890_sell");
  assert.ok(sell.shares >= 100);
  assert.match(sell.note, /止盈|高出目标/);
});

test("sellSuggestionForSymbol mirrors checklist sell advice for the ETF detail", () => {
  state.etfs = [
    { symbol: "512890", name: "红利低波ETF", shares: 40000, target_weight: 20, cost: 1 },
    { symbol: "510300", name: "沪深300ETF", shares: 15000, target_weight: 80, cost: 4 },
  ];
  state.quotesBySymbol = {
    "512890": { price: 1.0 },
    "510300": { price: 4.0 },
  };
  state.analysisCache = {
    "512890": {
      supported: true,
      valuation: { pe_percentile_10y: 0.92 },
      score: { grade: "E" },
      asset_class: "dividend",
    },
    "510300": {
      supported: true,
      valuation: { pe_percentile_10y: 0.4 },
      score: { grade: "C" },
      asset_class: "equity_core",
    },
  };
  state.plan = {
    amount: 2000,
    capital_base: 0,
    initial_target_pct: 0,
    cadence: "monthly",
    day: 1,
    strategy: "fixed",
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.03,
      max_fee_ratio_pct: 0.25,
      lot_size: 100,
    },
    pending_orders: {},
  };
  state.executionDrafts = buildExecutionDraftsFromAllocation({
    now: new Date("2026-07-15T10:00:00"),
  });
  const advice = sellSuggestionForSymbol("512890", {
    now: new Date("2026-07-15T10:00:00"),
  });
  assert.ok(advice);
  assert.equal(advice.side, "sell");
  assert.equal(advice.band, "估值止盈");
  assert.ok(advice.shares >= 100);
  assert.equal(advice.draftStatus, "pending");
  assert.equal(advice.draftId, "draft_2026-07-01_512890_sell");
  assert.equal(
    sellSuggestionForSymbol("510300", { now: new Date("2026-07-15T10:00:00") }),
    null,
  );
});

test("updateExecutionDraft preserves confirmed rows when regenerating", () => {
  state.etfs = [{ symbol: "512890", name: "红利低波ETF", shares: 0, target_weight: 100 }];
  state.quotesBySymbol = { "512890": { price: 1.0 } };
  state.analysisCache = {
    "512890": { supported: true, valuation: { pe_percentile_10y: 0.15 }, score: { grade: "A" } },
  };
  state.plan = {
    amount: 3000,
    capital_base: 0,
    initial_target_pct: 0,
    cadence: "monthly",
    day: 1,
    strategy: "fixed",
    strategy_config: null,
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.03,
      max_fee_ratio_pct: 0.25,
      lot_size: 100,
    },
    pending_orders: {},
  };
  state.executionDrafts = [];
  const created = buildExecutionDraftsFromAllocation({ now: new Date("2026-07-15T10:00:00") });
  assert.ok(created.length >= 1);
  const firstId = created[0].id;
  state.executionDrafts = created;
  state.executionDrafts = updateExecutionDraft(firstId, { status: "confirmed", confirmed_trade_id: "buy_1" });
  const regenerated = buildExecutionDraftsFromAllocation({ now: new Date("2026-07-15T10:00:00") });
  const kept = regenerated.find((item) => item.id === firstId);
  assert.equal(kept.status, "confirmed");
  state.executionDrafts = regenerated;
  const summary = executionDraftSummary(new Date("2026-07-15T10:00:00"));
  assert.equal(summary.pending, regenerated.filter((item) => item.status === "pending").length);
});

test("cash reserve books keep once when period completes under budget", () => {
  state.etfs = [{ symbol: "512890", name: "红利", shares: 0, target_weight: 100 }];
  state.quotesBySymbol = { "512890": { price: 1 } };
  state.analysisCache = {};
  state.plan = normalizePlan({
    amount: 3000,
    cadence: "monthly",
    day: 1,
    strategy: "fixed",
    cash_reserve: { balance: 100, history: [] },
  });
  state.executionDrafts = [
    {
      id: "draft_2026-07-01_512890",
      period: "2026-07-01",
      symbol: "512890",
      side: "buy",
      price: 1,
      shares: 1000,
      fee: 5,
      status: "confirmed",
      date: "2026-07-15",
    },
  ];
  const settled = settleCashReserveOnPeriodComplete({ now: new Date("2026-07-15") });
  assert.ok(settled);
  // buyExecuted = 1000×1 + fee5 = 1005；keep = 3000-1005 = 1995
  assert.equal(settled.cash_reserve.balance, 2095);
  assert.equal(settled.cash_reserve.history.length, 1);
  assert.equal(settled.cash_reserve.history[0].type, "keep");
  state.plan = settled;
  assert.equal(settleCashReserveOnPeriodComplete({ now: new Date("2026-07-15") }), null);
});

test("cash reserve keep uses price*shares+fee as buyExecuted", () => {
  state.etfs = [{ symbol: "512890", shares: 0, target_weight: 100 }];
  state.plan = normalizePlan({
    amount: 2000,
    cadence: "monthly",
    day: 1,
    strategy: "fixed",
    cash_reserve: { balance: 0, history: [] },
  });
  state.executionDrafts = [
    {
      id: "draft_2026-08-01_512890",
      period: "2026-08-01",
      symbol: "512890",
      side: "buy",
      price: 2,
      shares: 500,
      fee: 5,
      status: "confirmed",
      date: "2026-08-10",
    },
  ];
  const settled = settleCashReserveOnPeriodComplete({ now: new Date("2026-08-10") });
  // buyExecuted = 1000 + 5；keep = 2000 - 1005 = 995
  assert.equal(settled.cash_reserve.history[0].amount, 995);
  assert.equal(settled.cash_reserve.balance, 995);
});

test("cash reserve books sell proceeds and release over budget", () => {
  const sellBooked = bookCashReserveSell({
    draft: {
      side: "sell",
      status: "confirmed",
      period: "2026-07-01",
      price: 2,
      shares: 500,
      fee: 5,
    },
    plan: normalizePlan({ cash_reserve: { balance: 0, history: [] } }),
  });
  assert.equal(sellBooked.cash_reserve.balance, 995);
  assert.equal(sellBooked.cash_reserve.history[0].type, "sell");

  state.etfs = [{ symbol: "512890", shares: 0, target_weight: 100 }];
  state.plan = normalizePlan({
    amount: 1000,
    cadence: "monthly",
    day: 1,
    strategy: "fixed",
    cash_reserve: { balance: 5000, history: [] },
  });
  state.executionDrafts = [
    {
      id: "draft_2026-07-01_512890",
      period: "2026-07-01",
      symbol: "512890",
      side: "buy",
      price: 1,
      shares: 2500,
      status: "confirmed",
      date: "2026-07-15",
    },
  ];
  const released = settleCashReserveOnPeriodComplete({ now: new Date("2026-07-15") });
  assert.ok(released);
  assert.equal(released.cash_reserve.history.some((row) => row.type === "release"), true);
  assert.equal(released.cash_reserve.balance, 3500); // 5000 - (2500-1000)
});
