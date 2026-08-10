import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioReviewBaseline,
  isPortfolioAiReady,
  portfolioReviewResultHtml,
} from "../js/ai-portfolio.js";

test("buildPortfolioReviewBaseline maps allocatePoolBudget fields", () => {
  const baseline = buildPortfolioReviewBaseline(
    {
      budget: 2000,
      deployTotal: 1800,
      cashKeep: 200,
      cashRelease: 500,
      strategy: "valuation",
      allocations: [{ symbol: "512890", name: "红利", amount: 1000, band: "低估区", mult: 1.5 }],
      skipped: [{ symbol: "510300", name: "沪深300", reason: "当期不建议新增", band: "高估区" }],
    },
    "fixed",
  );
  assert.equal(baseline.deploy_total, 1800);
  assert.equal(baseline.cash_release, 500);
  assert.equal(baseline.strategy, "valuation");
  assert.equal(baseline.allocations[0].amount, 1000);
  assert.equal(baseline.skipped[0].reason, "当期不建议新增");
});

test("isPortfolioAiReady gates on enabled and key", () => {
  assert.equal(isPortfolioAiReady({ ai: { enabled: false } }).ok, false);
  assert.equal(
    isPortfolioAiReady({
      ai: { enabled: true, provider: "deepseek", credentials: { deepseek: { configured: false } } },
    }).reason,
    "missing_key",
  );
  assert.equal(
    isPortfolioAiReady({
      ai: { enabled: true, provider: "deepseek", credentials: { deepseek: { configured: true } } },
    }).ok,
    true,
  );
});

test("portfolioReviewResultHtml shows changed amounts once and avoids idle chrome", () => {
  assert.equal(portfolioReviewResultHtml({ status: "idle" }), "");
  const html = portfolioReviewResultHtml({
    status: "ready",
    result: {
      provider: "deepseek",
      model: "flash",
      disclaimer: "仅供研究参考",
      ai_proposal: {
        focus_title: "红利超配",
        summary: "建议略降红利份额。",
        analysis_sections: [{ title: "仓位", items: ["红利高于目标。"] }],
        watch_items: ["观察利差"],
        data_limitations: [],
      },
      final_allocations: [
        { symbol: "512890", name: "红利", rule_amount: 1200, final_amount: 900, changed: true },
        { symbol: "510300", name: "沪深300", rule_amount: 800, final_amount: 800, changed: false },
      ],
    },
  });
  assert.match(html, /建议略降红利份额/);
  assert.match(html, /规则 ¥1,200\.00 → ¥900\.00/);
  assert.ok(!html.includes("ai-review-focus"));
  assert.ok(!html.includes("沪深300：规则")); // 未变更不列
  assert.match(html, /仅供研究参考/);
});
