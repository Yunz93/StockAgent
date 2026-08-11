import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDailyEquityCurve,
  earliestTradeDate,
  limitEquityPoints,
  periodBucketKey,
  prepareEquityChartPoints,
  resampleEquityCurve,
  symbolsForEquityCurve,
} from "../js/portfolio-equity.js";

test("symbolsForEquityCurve unions etfs buys and sells", () => {
  const symbols = symbolsForEquityCurve(
    [{ symbol: "A" }, { symbol: "B" }],
    [{ symbol: "B" }, { symbol: "C" }],
    [{ symbol: "D" }],
  );
  assert.deepEqual(symbols.sort(), ["A", "B", "C", "D"]);
});

test("periodBucketKey covers day week month year", () => {
  assert.equal(periodBucketKey("2024-01-15", "day"), "2024-01-15");
  assert.equal(periodBucketKey("2024-01-15", "month"), "2024-01");
  assert.equal(periodBucketKey("2024-01-15", "year"), "2024");
  assert.equal(periodBucketKey("2024-01-04", "week"), "2024-W01");
});

test("resampleEquityCurve keeps last point of each bucket", () => {
  const daily = [
    { date: "2024-01-02", close: 100 },
    { date: "2024-01-31", close: 110 },
    { date: "2024-02-15", close: 120 },
    { date: "2024-02-29", close: 130 },
  ];
  const monthly = resampleEquityCurve(daily, "month");
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].close, 110);
  assert.equal(monthly[1].close, 130);
  assert.equal(resampleEquityCurve(daily, "day").length, 4);
  const yearly = resampleEquityCurve(
    [
      ...daily,
      { date: "2025-03-01", close: 140 },
    ],
    "year",
  );
  assert.equal(yearly.length, 2);
  assert.equal(yearly[0].date, "2024-02-29");
  assert.equal(yearly[1].date, "2025-03-01");
});

test("buildDailyEquityCurve does not invent holdings before first buy", () => {
  const curve = buildDailyEquityCurve({
    etfs: [{ symbol: "510300", shares: 100, cost: 4 }],
    buys: [{ id: "1", symbol: "510300", date: "2024-01-10", price: 4, shares: 100, fee: 0 }],
    sells: [],
    historyBySymbol: {
      "510300": {
        points: [
          { date: "2024-01-08", close: 3.8 },
          { date: "2024-01-10", close: 4.0 },
          { date: "2024-01-11", close: 4.2 },
          { date: "2024-01-12", close: 4.1 },
        ],
      },
    },
  });
  assert.equal(curve.length, 3);
  assert.equal(curve[0].date, "2024-01-10");
  assert.equal(curve[0].marketValue, 400);
  assert.equal(curve[0].pnl, 0);
  assert.equal(curve[1].marketValue, 420);
  assert.equal(curve[1].close, 20);
  assert.equal(curve[2].close, 10);
});

test("buildDailyEquityCurve without trades only uses last history day", () => {
  const curve = buildDailyEquityCurve({
    etfs: [{ symbol: "159915", shares: 200, cost: 1.5 }],
    buys: [],
    sells: [],
    historyBySymbol: {
      "159915": [
        { date: "2024-06-01", close: 1.6 },
        { date: "2024-06-03", close: 1.8 },
      ],
    },
  });
  assert.equal(curve.length, 1);
  assert.equal(curve[0].date, "2024-06-03");
  assert.equal(curve[0].marketValue, 360);
  assert.equal(curve[0].close, 60);
});

test("untraded symbol joins only after portfolio first trade", () => {
  assert.equal(
    earliestTradeDate([{ date: "2024-02-01", symbol: "A" }], [{ date: "2024-01-15", symbol: "B" }]),
    "2024-01-15",
  );
  const curve = buildDailyEquityCurve({
    etfs: [
      { symbol: "AAA", shares: 100, cost: 1 },
      { symbol: "BBB", shares: 50, cost: 2 },
    ],
    buys: [{ id: "1", symbol: "AAA", date: "2024-02-01", price: 1, shares: 100, fee: 0 }],
    sells: [],
    historyBySymbol: {
      AAA: [
        { date: "2024-01-10", close: 1.0 },
        { date: "2024-02-01", close: 1.1 },
        { date: "2024-02-02", close: 1.2 },
      ],
      BBB: [
        { date: "2024-01-10", close: 2.0 },
        { date: "2024-02-01", close: 2.0 },
        { date: "2024-02-02", close: 2.2 },
      ],
    },
  });
  assert.equal(curve[0].date, "2024-02-01");
  // AAA 100*1.1 + BBB 50*2.0
  assert.equal(curve[0].marketValue, 210);
  // AAA pnl 10 + BBB pnl 0
  assert.equal(curve[0].pnl, 10);
});

test("prepareEquityChartPoints resamples and limits", () => {
  const uniqueDaily = Array.from({ length: 200 }, (_, index) => {
    const day = index + 1;
    const month = String(Math.floor((day - 1) / 28) + 1).padStart(2, "0");
    const d = String(((day - 1) % 28) + 1).padStart(2, "0");
    return { date: `2024-${month}-${d}`, close: 100 + index };
  });
  const dayPoints = prepareEquityChartPoints(uniqueDaily, "day");
  assert.equal(dayPoints.length, 120);
  assert.equal(dayPoints[0].close, 100 + (200 - 120));
  const monthPoints = prepareEquityChartPoints(uniqueDaily, "month");
  assert.ok(monthPoints.length < uniqueDaily.length);
  assert.equal(limitEquityPoints(uniqueDaily, "day").length, 120);
});
