/**
 * 全池 AI 审视：用规则引擎 allocatePoolBudget 结果作基线，仅展示不改草稿。
 */

import { appConfig, state } from "./state.js";
import { aiProviderLabel, escapeHtml, money } from "./utils.js";

/** 从全池分配结果组装后端 baseline。 */
export function buildPortfolioReviewBaseline(pool, strategy = "valuation") {
  const source = pool && typeof pool === "object" ? pool : {};
  return {
    budget: Math.max(0, Number(source.budget) || 0),
    deploy_total: Math.max(0, Number(source.deployTotal) || 0),
    cash_keep: Math.max(0, Number(source.cashKeep) || 0),
    cash_release: Math.max(0, Number(source.cashRelease) || 0),
    strategy: String(source.strategy || strategy || "valuation"),
    allocations: (source.allocations || []).map((row) => ({
      symbol: row.symbol,
      name: row.name || row.symbol,
      amount: Math.max(0, Number(row.amount) || 0),
      band: row.band || "",
      mult: Number(row.mult) || 1,
    })),
    skipped: (source.skipped || []).map((row) => ({
      symbol: row.symbol,
      name: row.name || row.symbol,
      reason: row.reason || row.band || "",
    })),
  };
}

export function isPortfolioAiReady(config = appConfig) {
  const ai = config?.ai;
  if (!ai || ai.enabled !== true) return { ok: false, reason: "disabled" };
  const provider = ai.provider || "deepseek";
  if (!ai.credentials?.[provider]?.configured) {
    return { ok: false, reason: "missing_key" };
  }
  return { ok: true, provider };
}

function sectionsHtml(proposal) {
  const sections = proposal?.analysis_sections || [];
  if (!sections.length) return "";
  return `<div class="ai-review-sections">${sections
    .map(
      (section) => `
      <div class="ai-review-section">
        <strong>${escapeHtml(section.title || "")}</strong>
        <ul>${(section.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>`,
    )
    .join("")}</div>`;
}

function listBlock(title, items) {
  if (!items?.length) return "";
  return `<div class="ai-review-watch"><strong>${escapeHtml(title)}</strong><ul>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul></div>`;
}

/** 渲染全池 AI 结果卡片（纯展示，不含结论数字复述）。 */
export function portfolioReviewResultHtml(review) {
  if (!review || review.status === "idle") return "";
  if (review.status === "loading") {
    return `
      <section class="panel-block ai-portfolio-card is-loading" aria-live="polite" aria-label="AI 全池审视">
        <div class="panel-heading"><div><h3 class="section-title">AI 全池审视</h3></div></div>
        <p class="muted ai-review-status">正在审视本期全池分配…</p>
      </section>`;
  }
  if (review.status === "error") {
    return `
      <section class="panel-block ai-portfolio-card is-error" aria-label="AI 全池审视">
        <div class="panel-heading">
          <div><h3 class="section-title">AI 全池审视</h3></div>
          <button class="ghost-button compact" type="button" data-ai-portfolio-review>重试</button>
        </div>
        <p class="down ai-review-status">${escapeHtml(review.error || "请求失败")}</p>
        <p class="muted">规则分配仍有效。</p>
      </section>`;
  }
  const result = review.result;
  if (!result) return "";
  const proposal = result.ai_proposal || {};
  const changed = (result.final_allocations || []).filter((row) => row.changed);
  const headline = proposal.summary || "模型未提供摘要";
  // 摘要已承载主结论；旁路只补新信息（分节、修正明细、观察、限制）
  const adjustmentsHtml = changed.length
    ? `<div class="ai-portfolio-adjustments" aria-label="建议修正">
        <strong>建议修正</strong>
        <ul>${changed
          .map(
            (row) =>
              `<li>${escapeHtml(row.name || row.symbol)}：规则 ${money(row.rule_amount)} → ${money(row.final_amount)}</li>`,
          )
          .join("")}</ul>
      </div>`
    : "";
  return `
    <section class="panel-block ai-portfolio-card" aria-label="AI 全池审视">
      <div class="panel-heading">
        <div>
          <h3 class="section-title">AI 全池审视</h3>
          <p class="muted">${escapeHtml(aiProviderLabel(result.provider))} · ${escapeHtml(result.model || "")}${
            result.cached ? " · 缓存" : ""
          }</p>
        </div>
      </div>
      <details class="ai-result-fold" open>
        <summary class="ai-result-fold-summary">
          <span class="ai-result-fold-headline">${escapeHtml(headline)}</span>
        </summary>
        <div class="ai-result-fold-body">
          ${sectionsHtml(proposal)}
          ${adjustmentsHtml}
          ${listBlock("后续观察", proposal.watch_items)}
          ${listBlock("数据限制", proposal.data_limitations)}
          <p class="muted ai-review-disclaimer">${escapeHtml(result.disclaimer || "")}</p>
        </div>
      </details>
    </section>`;
}
