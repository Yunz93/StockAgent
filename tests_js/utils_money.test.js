import test from "node:test";
import assert from "node:assert/strict";

import { money } from "../js/utils.js";

test("money defaults to 2 decimal places", () => {
  assert.equal(money(1.234), "¥1.23");
  assert.equal(money(1.2), "¥1.20");
});

test("money supports 3 decimal places for ETF trade prices", () => {
  assert.equal(money(1.234, "CNY", 3), "¥1.234");
  assert.equal(money(1.2, "CNY", 3), "¥1.200");
  assert.equal(money(0.605, "CNY", 3), "¥0.605");
});

test("money does not show a minus for zero-ish values", () => {
  assert.equal(money(-0), "¥0.00");
  assert.equal(money(-0.004), "¥0.00");
});
