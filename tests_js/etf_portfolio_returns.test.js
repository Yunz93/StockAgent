import test from "node:test";
import assert from "node:assert/strict";

import { portfolioReturnsByIndex } from "../js/etf-portfolio.js";

test("portfolioReturnsByIndex groups ETFs by index and totals pnl", () => {
  const summary = portfolioReturnsByIndex({
    etfs: [
      { symbol: "513500", name: "标普500ETF博时", shares: 1000, cost: 1.0 },
      { symbol: "159941", name: "纳指ETF", shares: 500, cost: 2.0 },
      { symbol: "513100", name: "纳指100ETF", shares: 200, cost: 2.5 },
      { symbol: "512890", name: "红利低波", shares: 0, cost: 1.1 },
    ],
    quotesBySymbol: {
      "513500": { price: 1.2 },
      "159941": { price: 2.2 },
      "513100": { price: 2.0 },
      "512890": { price: 1.0 },
    },
    analysisRegistry: {
      "513500": { index_code: "SPX", index_name: "标普500" },
      "159941": { index_code: "NDX", index_name: "纳斯达克100" },
      "513100": { index_code: "NDX", index_name: "纳斯达克100" },
      "512890": { index_code: "H30269", index_name: "红利低波" },
    },
  });

  assert.equal(summary.indices.length, 2);
  const spx = summary.indices.find((row) => row.indexCode === "SPX");
  const ndx = summary.indices.find((row) => row.indexCode === "NDX");
  assert.ok(spx);
  assert.ok(ndx);
  assert.equal(spx.marketValue, 1200);
  assert.equal(spx.costValue, 1000);
  assert.equal(spx.pnl, 200);
  assert.equal(ndx.etfs.length, 2);
  assert.equal(ndx.marketValue, 2.2 * 500 + 2.0 * 200);
  assert.equal(ndx.costValue, 2.0 * 500 + 2.5 * 200);
  assert.equal(summary.total.heldCount, 3);
  assert.ok(Math.abs(summary.total.pnl - (spx.pnl + ndx.pnl)) < 1e-9);
});

test("portfolioReturnsByIndex falls back to ETF name without registry", () => {
  const summary = portfolioReturnsByIndex({
    etfs: [{ symbol: "999999", name: "自定义ETF", shares: 100, cost: 1 }],
    quotesBySymbol: { "999999": { price: 1.1 } },
    analysisRegistry: {},
  });
  assert.equal(summary.indices.length, 1);
  assert.equal(summary.indices[0].indexName, "自定义ETF");
  assert.ok(Math.abs(summary.indices[0].pnlPct - 10) < 1e-9);
});
