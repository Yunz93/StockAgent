import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseWorkspaceSource,
  normalizeBuys,
  normalizeCashReserve,
  normalizeDecisionHistory,
  normalizeExecutionDrafts,
  normalizeExecutionDraftsMeta,
  normalizeSells,
  normalizePlan,
  normalizeWorkspaceEntries,
  parseWorkspaceTimestamp,
  planPersistenceScore,
  upsertBuy,
  upsertSell,
  WORKSPACE_VERSION,
} from "../js/workspace_model.js";

test("workspace source prefers server, then local cache, then defaults", () => {
  const remote = { etfs: [{ symbol: "510300" }], updated_at: "2026-07-30T01:00:00.000Z" };
  const local = { etfs: [{ symbol: "512890" }], updated_at: "2026-07-30T00:00:00.000Z" };
  assert.equal(chooseWorkspaceSource(remote, local).source, "server");
  assert.equal(chooseWorkspaceSource({ etfs: [] }, local).source, "local-cache");
  assert.equal(chooseWorkspaceSource({ etfs: [] }, { etfs: [] }).source, "default-pool");
});

test("workspace source keeps newer local cache when server PUT may have been interrupted", () => {
  const remote = {
    etfs: [{ symbol: "510300" }],
    plan: { amount: 2000, capital_base: 0 },
    updated_at: "2026-07-30T01:00:00.000Z",
  };
  const local = {
    etfs: [{ symbol: "510300" }],
    plan: { amount: 2000, capital_base: 100000, initial_target_pct: 30 },
    updated_at: "2026-07-30T01:00:01.000Z",
  };
  const selected = chooseWorkspaceSource(remote, local);
  assert.equal(selected.source, "local-cache");
  assert.equal(selected.migrate, true);
  assert.equal(selected.payload.plan.capital_base, 100000);
});

test("workspace source keeps server plan when local is newer but weaker/default", () => {
  const remote = {
    etfs: [{ symbol: "510300" }],
    plan: { amount: 20000, capital_base: 200000, initial_target_pct: 30 },
    updated_at: "2026-07-31 00:04",
  };
  const local = {
    etfs: [{ symbol: "510300" }],
    plan: { amount: 2000, capital_base: 0, initial_target_pct: 0 },
    // hydrate 重写 ISO 后几乎总比服务器分钟精度 as_of 新
    updated_at: "2026-07-30T16:04:12.345Z",
  };
  const selected = chooseWorkspaceSource(remote, local);
  assert.equal(selected.source, "server");
  assert.equal(selected.payload.plan.capital_base, 200000);
  assert.equal(selected.payload.plan.initial_target_pct, 30);
});

test("parseWorkspaceTimestamp accepts ISO and space-separated local stamps", () => {
  assert.ok(parseWorkspaceTimestamp("2026-07-30T16:04:12.345Z") > 0);
  assert.ok(parseWorkspaceTimestamp("2026-07-31 00:04") > 0);
  assert.equal(parseWorkspaceTimestamp(""), 0);
});

test("planPersistenceScore treats capital/target as strong signals", () => {
  assert.ok(
    planPersistenceScore({ capital_base: 100000, initial_target_pct: 30, amount: 5000 }) >
      planPersistenceScore({ amount: 2000 }),
  );
  assert.equal(planPersistenceScore(null), 0);
});

test("legacy workspace entries receive default target weights", () => {
  const entries = normalizeWorkspaceEntries([
    { symbol: "512890", shares: 100, cost: 1.2 },
    { symbol: "563360", shares: -1, cost: "bad" },
  ]);
  assert.equal(entries[0].target_weight, 35);
  assert.equal(entries[1].target_weight, 20);
  assert.equal(entries[1].shares, 0);
  assert.equal(entries[1].cost, 0);
});

test("plan normalization clamps execution day by cadence", () => {
  assert.equal(normalizePlan({ cadence: "monthly", day: 31 }).day, 28);
  assert.equal(normalizePlan({ cadence: "weekly", day: 9 }).day, 7);
  assert.equal(normalizePlan({ amount: -1 }).amount, 0);
});

test("plan normalization defaults strategy to valuation and accepts custom config", () => {
  const legacy = normalizePlan({ name: "旧计划", amount: 1000 });
  assert.equal(legacy.strategy, "valuation");
  assert.equal(legacy.strategy_config.pe_bands.length, 5);
  assert.deepEqual(legacy.strategy_overrides, {});

  const custom = normalizePlan({
    strategy: "custom",
    strategy_config: {
      pe_bands: [
        { max_pct: 30, mult: 2, label: "低" },
        { max_pct: 100, mult: 0.2, label: "高" },
      ],
      grade_mult: { A: 2, B: 1, C: 1, D: 0.2, E: 0 },
      use_rebalance: false,
    },
  });
  assert.equal(custom.strategy, "custom");
  assert.equal(custom.strategy_config.pe_bands[0].max_pct, 30);
  assert.equal(custom.strategy_config.use_rebalance, false);
  assert.equal(normalizePlan({ strategy: "nope" }).strategy, "valuation");
});

test("plan normalization keeps valid strategy_overrides and drops illegal ids", () => {
  const plan = normalizePlan({
    strategy_overrides: {
      "512890": "fixed",
      sh510300: "grade",
      "159937": "nope",
      bad: "valuation",
      "513390": "rebalance",
    },
  });
  assert.deepEqual(plan.strategy_overrides, {
    "512890": "fixed",
    "510300": "grade",
    "513390": "rebalance",
  });
  assert.deepEqual(normalizePlan({ strategy_overrides: null }).strategy_overrides, {});
});

test("plan normalization defaults and sanitizes add_plan", () => {
  const legacy = normalizePlan({ name: "旧计划", amount: 1000 });
  assert.deepEqual(legacy.add_plan, { enabled: true, anchor: "price", preset: "auto", levels: null });

  const custom = normalizePlan({
    add_plan: {
      enabled: false,
      anchor: "cost",
      levels: [
        { drawdown_pct: 2, ratio: 1 },
        { drawdown_pct: 8, ratio: 1 },
        { drawdown_pct: 50, ratio: 0 },
        { drawdown_pct: 1, ratio: 2 },
        { drawdown_pct: 12, ratio: 1 },
      ],
    },
  });
  assert.equal(custom.add_plan.enabled, false);
  assert.equal(custom.add_plan.anchor, "cost");
  assert.equal(custom.add_plan.levels.length, 3);
  assert.deepEqual(
    custom.add_plan.levels.map((row) => row.drawdown_pct),
    [1, 2, 8],
  );
  const ratioSum = custom.add_plan.levels.reduce((sum, row) => sum + row.ratio, 0);
  assert.ok(Math.abs(ratioSum - 1) < 1e-9);

  assert.equal(normalizePlan({ add_plan: { anchor: "nope" } }).add_plan.anchor, "price");
  assert.equal(normalizePlan({ addPlan: { enabled: 0 } }).add_plan.enabled, false);
});

test("cash_reserve normalizes and migrates missing field", () => {
  assert.deepEqual(normalizeCashReserve(undefined), { balance: 0, history: [] });
  assert.deepEqual(normalizePlan({}).cash_reserve, { balance: 0, history: [] });
  const plan = normalizePlan({
    cash_reserve: {
      balance: 1500.5,
      history: [
        { period: "2026-06-01", amount: 500, type: "keep" },
        { period: "bad", amount: 1, type: "keep" },
        { period: "2026-06-01", amount: 200, type: "nope" },
        { period: "2026-07-01", amount: 300, type: "release" },
      ],
    },
  });
  assert.equal(plan.cash_reserve.balance, 1500.5);
  assert.equal(plan.cash_reserve.history.length, 2);
  assert.equal(plan.cash_reserve.history[0].type, "keep");
  assert.equal(plan.cash_reserve.history[1].type, "release");
});

test("plan normalization preserves initial build and trading cost settings", () => {
  const plan = normalizePlan({
    amount: 5000,
    capital_base: 100000,
    initial_target_pct: 30,
    initial_months: 6,
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.025,
      max_fee_ratio_pct: 0.2,
      lot_size: 100,
    },
  });
  assert.equal(plan.amount, 5000);
  assert.equal(plan.capital_base, 100000);
  assert.equal(plan.initial_target_pct, 30);
  assert.equal(plan.initial_months, 6);
  assert.equal(normalizePlan({}).initial_months, 1);
  assert.equal(normalizePlan({ initial_months: 99 }).initial_months, 36);
  assert.equal(plan.trading_cost.min_commission, 5);
  assert.equal(plan.trading_cost.max_fee_ratio_pct, 0.2);
});

test("plan normalization does not drop filled capital_base / amount / target", () => {
  const plan = normalizePlan({
    name: "家庭主账户",
    amount: 8888,
    capital_base: 250000,
    initial_target_pct: 40,
    note: "重启后应仍在",
  });
  assert.equal(plan.name, "家庭主账户");
  assert.equal(plan.amount, 8888);
  assert.equal(plan.capital_base, 250000);
  assert.equal(plan.initial_target_pct, 40);
  assert.equal(plan.note, "重启后应仍在");
});

test("buy normalization deduplicates records and rejects impossible dates", () => {
  const buys = normalizeBuys([
    { id: "buy-1", symbol: "sh510300", date: "2026-07-28", shares: 10, price: 4.2 },
    { id: "buy-1", symbol: "510300", date: "2026-07-28", shares: 20, price: 4.1 },
    { symbol: "512890", date: "2026-02-31", shares: 10, price: 1.2 },
  ]);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, "510300");
});

test("buy upsert replaces an existing record without duplicating it", () => {
  const original = { id: "buy-1", symbol: "510300", date: "2026-07-20", shares: 100, price: 4.1 };
  const updated = { ...original, symbol: "512890", date: "2026-07-29", shares: 120, price: 1.23 };
  const buys = upsertBuy([original], updated);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, "512890");
  assert.equal(buys[0].shares, 120);
});

test("buy upsert keeps records sorted by date after editing", () => {
  const older = { id: "buy-1", symbol: "510300", date: "2026-07-20", shares: 100, price: 4.1 };
  const newer = { id: "buy-2", symbol: "512890", date: "2026-07-25", shares: 100, price: 1.2 };
  const buys = upsertBuy([newer, older], { ...older, date: "2026-07-29" });
  assert.deepEqual(buys.map((item) => item.id), ["buy-1", "buy-2"]);
});

test("sell normalization and upsert stay separate from buy records", () => {
  const sell = { id: "sell-1", symbol: "510300", date: "2026-07-20", shares: 50, price: 4.3 };
  assert.equal(normalizeSells([sell]).length, 1);
  const updated = upsertSell([sell], { ...sell, shares: 40 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].shares, 40);
});

test("execution drafts normalize and migrate from missing field", () => {
  assert.deepEqual(normalizeExecutionDrafts(undefined), []);
  const drafts = normalizeExecutionDrafts([
    {
      period: "2026-07-01",
      symbol: "512890",
      suggested_amount: 1000,
      price: 1.1,
      shares: 900,
      status: "pending",
    },
    {
      id: "draft_2026-07-01_512890_sell",
      period: "2026-07-01",
      symbol: "512890",
      side: "sell",
      suggested_amount: 500,
      price: 1.1,
      shares: 400,
      status: "pending",
    },
  ]);
  assert.equal(drafts[0].id, "draft_2026-07-01_512890_sell");
  assert.equal(drafts[0].side, "sell");
  assert.equal(drafts[1].id, "draft_2026-07-01_512890");
  assert.equal(drafts[1].side, "buy"); // 缺省兼容旧数据
  assert.equal(drafts[1].date, "2026-07-01");
  assert.equal(drafts[1].stale, true);
  assert.equal(WORKSPACE_VERSION, 9);
  assert.equal(normalizePlan({}).execution_policy.premium_block_pct, 5);
  assert.deepEqual(normalizeExecutionDraftsMeta(null).fingerprint, "");
  assert.equal(normalizeDecisionHistory([]).length, 0);
});
