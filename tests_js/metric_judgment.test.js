import test from "node:test";
import assert from "node:assert/strict";
import {
  judgmentArrow,
  judgmentTone,
  pePercentileBias,
} from "../js/metric-judgment.js";

test("judgmentArrow maps high/overbought to up and low/oversold to down", () => {
  assert.equal(judgmentArrow("历史偏高"), "↑");
  assert.equal(judgmentArrow("历史高位"), "↑");
  assert.equal(judgmentArrow("超买区间"), "↑");
  assert.equal(judgmentArrow("超买"), "↑");
  assert.equal(judgmentArrow("历史偏低"), "↓");
  assert.equal(judgmentArrow("历史低位"), "↓");
  assert.equal(judgmentArrow("超卖区间"), "↓");
  assert.equal(judgmentArrow("超卖"), "↓");
});

test("judgmentArrow stays blank for neutral or missing labels", () => {
  assert.equal(judgmentArrow("中性"), "");
  assert.equal(judgmentArrow("中性区间"), "");
  assert.equal(judgmentArrow("历史中位"), "");
  assert.equal(judgmentArrow("正常"), "");
  assert.equal(judgmentArrow("数据不足"), "");
  assert.equal(judgmentArrow(""), "");
  assert.equal(judgmentArrow(null), "");
});

test("judgmentTone follows arrow direction", () => {
  assert.equal(judgmentTone("超买区间"), "up");
  assert.equal(judgmentTone("超卖"), "down");
  assert.equal(judgmentTone("低估"), "down");
  assert.equal(judgmentTone("正常"), "");
  assert.equal(judgmentTone("中性"), "");
});

test("pePercentileBias maps high / normal / undervalued bands", () => {
  assert.equal(pePercentileBias(0.91), "偏高");
  assert.equal(pePercentileBias(0.6), "偏高");
  assert.equal(pePercentileBias(0.43), "正常");
  assert.equal(pePercentileBias(0.5), "正常");
  assert.equal(pePercentileBias(0.39), "低估");
  assert.equal(pePercentileBias(0.15), "低估");
  assert.equal(pePercentileBias(null), "");
  assert.equal(judgmentTone(pePercentileBias(0.91)), "up");
  assert.equal(judgmentTone(pePercentileBias(0.43)), "");
  assert.equal(judgmentTone(pePercentileBias(0.2)), "down");
});
