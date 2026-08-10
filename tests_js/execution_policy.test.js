import test from "node:test";
import assert from "node:assert/strict";

import {
  canSubmitWithOverride,
  evaluateExecutionPolicy,
  isCrossBorderIndex,
  normalizeExecutionPolicy,
} from "../js/execution-policy.js";

function quote({ premium = null, spread = null, ageMin = 1, price = 1.2 } = {}) {
  const now = Date.now();
  return {
    price,
    market_timestamp: new Date(now - ageMin * 60000).toISOString(),
    product_quality: {
      premium_discount_pct: premium,
      bid_ask_spread_pct: spread,
      iopv: price,
    },
  };
}

const now = new Date();

test("buy premium thresholds", () => {
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 1.99, spread: 0.1 }),
      now,
    }).status,
    "ready",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 2.0, spread: 0.1 }),
      now,
    }).status,
    "warning",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 4.99, spread: 0.1 }),
      now,
    }).status,
    "warning",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 5.0, spread: 0.1 }),
      now,
    }).status,
    "blocked",
  );
});

test("sell discount thresholds", () => {
  assert.equal(
    evaluateExecutionPolicy({
      side: "sell",
      quote: quote({ premium: -1.99, spread: 0.1 }),
      now,
    }).status,
    "ready",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "sell",
      quote: quote({ premium: -2.0, spread: 0.1 }),
      now,
    }).status,
    "warning",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "sell",
      quote: quote({ premium: -5.0, spread: 0.1 }),
      now,
    }).status,
    "blocked",
  );
});

test("missing premium: cross-border blocked, domestic warning", () => {
  assert.equal(isCrossBorderIndex("SPX"), true);
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: null, spread: 0.1 }),
      indexCode: "SPX",
      now,
    }).status,
    "blocked",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: null, spread: 0.1 }),
      indexCode: "000510",
      now,
    }).status,
    "warning",
  );
});

test("spread thresholds and missing spread", () => {
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 0.5, spread: 0.2 }),
      now,
    }).status,
    "warning",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 0.5, spread: 0.31 }),
      now,
    }).status,
    "blocked",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 0.5, spread: null }),
      now,
    }).status,
    "warning",
  );
});

test("stale quote stays executable; valuation analysis missing is preview; fixed ignores analysis", () => {
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: quote({ premium: 0.5, spread: 0.1, ageMin: 16 }),
      now,
    }).status,
    "ready",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      strategy: "valuation",
      analysisUsable: false,
      quote: quote({ premium: 0.5, spread: 0.1 }),
      now,
    }).status,
    "preview",
  );
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      strategy: "fixed",
      analysisUsable: false,
      quote: quote({ premium: 0.5, spread: 0.1 }),
      now,
    }).status,
    "ready",
  );
});

test("unix-second market_timestamp parses for age metrics without blocking", () => {
  const ageMin = 20;
  const tsSec = Math.floor((now.getTime() - ageMin * 60000) / 1000);
  const stale = evaluateExecutionPolicy({
    side: "buy",
    quote: {
      price: 1.2,
      market_timestamp: tsSec,
      product_quality: { premium_discount_pct: 0.5, bid_ask_spread_pct: 0.1 },
    },
    now,
  });
  assert.equal(stale.status, "ready");
  assert.ok(stale.metrics.quote_age_minutes >= 19);
  assert.equal(
    evaluateExecutionPolicy({
      side: "buy",
      quote: {
        price: 1.2,
        market_timestamp: String(Math.floor(now.getTime() / 1000)),
        product_quality: { premium_discount_pct: 0.5, bid_ask_spread_pct: 0.1 },
      },
      now,
    }).status,
    "ready",
  );
});

test("override gates", () => {
  assert.equal(canSubmitWithOverride({ status: "blocked", overrideReason: "abcd" }).ok, false);
  assert.equal(canSubmitWithOverride({ status: "preview", overrideReason: "abcd" }).ok, false);
  assert.equal(canSubmitWithOverride({ status: "warning", overrideReason: "ab" }).ok, false);
  assert.equal(canSubmitWithOverride({ status: "warning", overrideReason: "abc" }).ok, true);
  assert.deepEqual(normalizeExecutionPolicy(null).premium_block_pct, 5);
});
