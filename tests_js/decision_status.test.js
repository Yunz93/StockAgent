import test from "node:test";
import assert from "node:assert/strict";
import {
  allocStatusChip,
  allocStatusHint,
  orderActionLabel,
  positionGlance,
} from "../js/decision-status.js";

test("allocStatusChip maps buy and common skip reasons", () => {
  assert.equal(allocStatusChip({ amount: 1200, band: "低估区 · 建仓补缺" }), "可买");
  assert.equal(allocStatusChip({ amount: 0, band: "高估区", reason: "估值偏贵" }), "偏贵");
  assert.equal(allocStatusChip({ amount: 0, band: "等待行情恢复" }), "等行情");
  assert.equal(allocStatusChip({ amount: 0, band: "已达目标" }), "已满");
  assert.equal(allocStatusChip({ amount: 0, reason: "不足一手" }), "攒一手");
  assert.ok(allocStatusHint("偏贵").includes("估值"));
});

test("positionGlance shows current pool weight and drift only", () => {
  const glance = positionGlance({
    targetWeight: 40,
    actualWeight: 45.2,
    drift: 5.2,
  });
  assert.equal(glance.primary, "45.2%（+5.2pp）");
  assert.equal(glance.secondary, undefined);

  assert.equal(positionGlance({ actualWeight: 12 }).primary, "12.0%");
  assert.equal(positionGlance({ targetWeight: 30 }).primary, "目标 30.0%");
  assert.equal(
    positionGlance({ actualWeight: 52.8, targetWeight: 30 }).primary,
    "52.8%（+22.8pp）",
  );
});

test("orderActionLabel stays aligned with alloc chips", () => {
  assert.equal(orderActionLabel({ willOrder: true, shares: 1000 }), "可买 1,000 份");
  assert.equal(
    orderActionLabel({ blockedReason: "insufficient_lot", initial: true }),
    "攒一手（余量下期）",
  );
  assert.equal(orderActionLabel({ blockedReason: "fee_inefficient" }), "攒一手");
  assert.equal(orderActionLabel({}), "不投");
});
