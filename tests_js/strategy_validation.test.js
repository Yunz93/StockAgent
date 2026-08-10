import test from "node:test";
import assert from "node:assert/strict";

import {
  strategyValidationDisclaimer,
  summarizeDecisionHistory,
} from "../js/strategy-validation.js";

test("summarizeDecisionHistory aggregates completion, fees, overrides", () => {
  const summary = summarizeDecisionHistory([
    {
      period: "2026-08-01",
      symbol: "513500",
      side: "buy",
      action: "blocked",
      strategic_amount: 3000,
      order_amount: 0,
      fee: 0,
      premium_discount_pct: 8,
    },
    {
      period: "2026-08-01",
      symbol: "563360",
      side: "buy",
      action: "override",
      strategic_amount: 2000,
      order_amount: 1900,
      fee: 5,
      premium_discount_pct: 2.5,
    },
    {
      period: "2026-08-01",
      symbol: "512890",
      side: "buy",
      action: "confirmed",
      strategic_amount: 1000,
      order_amount: 1000,
      fee: 5,
    },
    {
      period: "2026-08-01",
      symbol: "512890",
      side: "buy",
      action: "confirmed",
      strategic_amount: 500,
      order_amount: 500,
      fee: 5,
    },
  ]);
  assert.equal(summary.blocked_amount, 3000);
  assert.equal(summary.warning_overrides, 1);
  assert.equal(summary.premium_avoided_amount, 3000);
  assert.equal(summary.total_fees, 15);
  assert.ok(summary.completion_rate > 0);
  assert.equal(summary.repeat_trades, 1);
  assert.match(strategyValidationDisclaimer(), /实验/);
});
