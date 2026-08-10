import { PLAN_CADENCE_LABELS } from "./constants.js";
import { appConfig, state } from "./state.js";
import { escapeAttr, escapeHtml, money, resolveEtfDisplayName } from "./utils.js";
import { allocatePoolBudget, strategyLabel } from "./strategy.js";
import { planExecutionContext, planPeriod } from "./decision-support.js";
import {
  analysisCacheKey,
  analysisPrefetchIsPreliminary,
  isAnalysisUsable,
} from "./analysis-cache.js";
import {
  analysisRegistryFromConfig,
  sentimentByMarketFromState,
} from "./market-sentiment.js";
import { goldMacroFromState } from "./gold-macro.js";
import { portfolioReviewResultHtml } from "./ai-portfolio.js";
import { applyIndexExposureGroups } from "./index-exposure.js";
import {
  allocStatusChip,
  allocStatusHint,
} from "./decision-status.js";

function cacheKey(symbol) {
  return analysisCacheKey(symbol);
}

function poolEntryDisplayName(entry, cached) {
  const registryName =
    appConfig?.etf?.analysis_registry?.[entry.symbol]?.etf_name ||
    appConfig?.etf?.analysis_support?.[entry.symbol]?.etf_name ||
    cached?.etf_name ||
    "";
  const seedName = (appConfig?.etf?.pool || []).find((item) => item.symbol === entry.symbol)?.name || "";
  return resolveEtfDisplayName({
    name: entry.name,
    symbol: entry.symbol,
    quoteName: state.quotesBySymbol[entry.symbol]?.name,
    registryName,
    seedName,
  });
}

/** 用持仓 + 分析缓存组装全池分配输入。 */
export function buildPoolHoldingsForAllocation({ preferLive = null } = {}) {
  const live = preferLive && !preferLive.error ? preferLive : null;
  const liveSymbol = live?.symbol || state.analysisSymbol || null;
  let total = 0;
  const valueMap = {};
  const quoteMissingMap = {};
  state.etfs.forEach((item) => {
    const quote = state.quotesBySymbol[item.symbol];
    const livePrice =
      liveSymbol === item.symbol
        ? live?.etf?.price ?? live?.price
        : null;
    const price = Number(livePrice ?? quote?.price);
    const shares = Math.max(0, Number(item.shares) || 0);
    if (Number.isFinite(price) && price > 0) {
      valueMap[item.symbol] = shares * price;
      total += valueMap[item.symbol];
    } else if (shares > 0) {
      quoteMissingMap[item.symbol] = true;
    }
  });
  return state.etfs.map((entry) => {
    const cached =
      live && liveSymbol === entry.symbol ? live : state.analysisCache[cacheKey(entry.symbol)];
    const analyzed = isAnalysisUsable(cached);
    const quoteMissing = Boolean(quoteMissingMap[entry.symbol]);
    const marketValue = quoteMissing
      ? null
      : valueMap[entry.symbol] != null
        ? valueMap[entry.symbol]
        : 0;
    const actualWeight =
      !quoteMissing && valueMap[entry.symbol] != null
        ? total > 0
          ? (valueMap[entry.symbol] / total) * 100
          : 0
        : null;
    return {
      symbol: entry.symbol,
      name: poolEntryDisplayName(entry, cached),
      targetWeight: Number(entry.target_weight) > 0 ? Number(entry.target_weight) : 0,
      actualWeight,
      marketValue,
      quoteMissing,
      shares: Math.max(0, Number(entry.shares) || 0),
      pePct: analyzed ? cached?.valuation?.pe_percentile_10y : null,
      grade: analyzed ? cached?.score?.grade : null,
      assetClass: analyzed ? cached?.asset_class || null : null,
      spreadPct: analyzed ? cached?.spread?.percentile ?? null : null,
      biasPct: analyzed ? cached?.technicals?.bias_pct ?? null : null,
      goldMacro: analyzed ? cached?.gold_macro || null : null,
      analyzed,
    };
  });
}

function dataStatusBadge(analyzed, quoteMissing = false) {
  if (quoteMissing) {
    return `<span class="pool-alloc-badge is-warn">等行情</span>`;
  }
  return analyzed ? "" : `<span class="pool-alloc-badge is-neutral">中性</span>`;
}

export { allocStatusChip } from "./decision-status.js";

/** 组装分配用 holdings：同指数择优/组标记后再交给 allocatePoolBudget。 */
export function prepareHoldingsForAllocation(rawHoldings = []) {
  const { holdings } = applyIndexExposureGroups(rawHoldings, {
    analysisRegistry: analysisRegistryFromConfig(),
    products: appConfig?.etf?.products || {},
  });
  return holdings;
}

/**
 * 同指数多 ETF：对费率较高者标注提示（无 annual_fee_pct 数据则不显示）。
 * @returns {Record<string, string>}
 */
export function sameIndexHigherFeeHints({
  symbols = [],
  analysisRegistry = {},
  products = {},
} = {}) {
  const byIndex = new Map();
  for (const raw of symbols) {
    const symbol = String(raw || "").trim();
    if (!symbol) continue;
    const indexCode = String(analysisRegistry[symbol]?.index_code || "").trim();
    if (!indexCode) continue;
    if (!byIndex.has(indexCode)) byIndex.set(indexCode, []);
    byIndex.get(indexCode).push(symbol);
  }
  const hints = {};
  for (const group of byIndex.values()) {
    if (group.length < 2) continue;
    const withFee = group
      .map((symbol) => {
        const fee = Number(products[symbol]?.annual_fee_pct);
        return Number.isFinite(fee) && fee >= 0 ? { symbol, fee } : null;
      })
      .filter(Boolean);
    if (withFee.length < 2) continue;
    const minFee = Math.min(...withFee.map((row) => row.fee));
    for (const row of withFee) {
      if (row.fee > minFee + 1e-12) {
        hints[row.symbol] = "同指数有更低费率品种";
      }
    }
  }
  return hints;
}

function progressNoteHtml(holdings) {
  const total = holdings.length;
  const analyzed = holdings.filter((item) => item.analyzed).length;
  const prefetch = state.analysisPrefetch || {};
  if (prefetch.status === "done" || total === 0) return "";
  const done = Math.min(total, Math.max(analyzed, Number(prefetch.done) || 0));
  if (prefetch.status === "running") {
    return `<p class="muted pool-alloc-note pool-alloc-progress">分析中 ${done}/${total}</p>`;
  }
  if (analyzed < total) {
    return `<p class="muted pool-alloc-note pool-alloc-progress">分析中 ${analyzed}/${total}</p>`;
  }
  return "";
}

/** 轻量读取本期草稿摘要，避免与 execution-drafts 循环依赖。 */
function draftSummaryFromState() {
  const period = planPeriod(state.plan || {}).start;
  const drafts = (Array.isArray(state.executionDrafts) ? state.executionDrafts : []).filter(
    (item) => item && item.period === period,
  );
  const suggested = drafts.reduce((sum, item) => sum + (Number(item.suggested_amount) || 0), 0);
  const executed = drafts
    .filter((item) => item.status === "confirmed")
    .reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.shares) || 0), 0);
  const pending = drafts.filter((item) => item.status === "pending").length;
  return {
    drafts,
    suggested: Math.round(suggested * 100) / 100,
    executed: Math.round(executed * 100) / 100,
    pending,
    total: drafts.length,
  };
}

export function poolAllocationHtml({ highlightSymbol = null, clickable = true } = {}) {
  const plan = state.plan || {};
  const cadenceLabel = PLAN_CADENCE_LABELS[plan.cadence] || "每月";
  const dayLabel = plan.cadence === "monthly" ? `${plan.day || 1} 号` : `周${plan.day || 1}`;
  const rawHoldings = buildPoolHoldingsForAllocation();
  const holdings = prepareHoldingsForAllocation(rawHoldings);
  const execution = planExecutionContext({ plan, holdings: rawHoldings });
  const cashBalance = Number(plan.cash_reserve?.balance) || 0;
  const pool = allocatePoolBudget({
    budget: execution.budget,
    holdings,
    strategy: plan.strategy,
    strategyConfig: plan.strategy_config,
    strategyOverrides: plan.strategy_overrides,
    preferTargetGap: execution.phase === "initial",
    buildTargetAmount: execution.phase === "initial" ? execution.targetAmount : null,
    sentimentByMarket: sentimentByMarketFromState(),
    analysisRegistry: analysisRegistryFromConfig(),
    goldMacro: goldMacroFromState(),
    cashReserve: cashBalance,
  });
  const strategyName = strategyLabel(plan.strategy);
  const preliminary = analysisPrefetchIsPreliminary();
  const analyzedMap = Object.fromEntries(holdings.map((item) => [item.symbol, item.analyzed]));
  const quoteMissingMap = Object.fromEntries(
    holdings.map((item) => [item.symbol, Boolean(item.quoteMissing)]),
  );
  const feeHints = sameIndexHigherFeeHints({
    symbols: holdings.map((item) => item.symbol),
    analysisRegistry: analysisRegistryFromConfig(),
    products: appConfig?.etf?.products || {},
  });

  if (!(execution.budget > 0) || !holdings.length) {
    state.lastPoolAllocBySymbol = {};
    return `
      <section class="panel-block pool-alloc-block" aria-label="本期分配">
        <div class="panel-heading">
          <div>
            <h2 class="section-title">本期分配</h2>
          </div>
        </div>
      </section>
    `;
  }

  const rows = (pool.allocations || [])
    .concat(
      (pool.skipped || []).map((item) => ({
        symbol: item.symbol,
        name: item.name,
        amount: 0,
        band: item.band,
        reason: item.reason,
      })),
    )
    .sort((a, b) => b.amount - a.amount);

  const allocBySymbol = {};
  for (const row of rows) {
    const chip = allocStatusChip(row);
    allocBySymbol[row.symbol] = { amount: Number(row.amount) || 0, chip };
  }
  state.lastPoolAllocBySymbol = allocBySymbol;

  const progressNote = progressNoteHtml(holdings);
  const prelimClass = preliminary ? " is-preliminary" : "";
  const prelimTag = preliminary ? `<em class="pool-alloc-prelim-tag">初步</em>` : "";
  const draftSummary = draftSummaryFromState();
  let draftStatus = "";
  if (draftSummary.pending > 0) {
    draftStatus = `
      <div class="pool-alloc-exec-bar" role="status">
        <span>待确认 ${draftSummary.pending} 笔</span>
        <button class="primary-button compact" type="button" data-open-buys>去执行</button>
      </div>`;
  } else if (draftSummary.executed > 0) {
    draftStatus = `<p class="muted pool-alloc-exec-summary">已执行 ${money(draftSummary.executed)}</p>`;
  }

  const phaseLine =
    execution.phase === "initial"
      ? `${execution.phaseLabel} · 本期 ${money(execution.budget)} · 尚缺 ${money(execution.initialGap)}`
      : `${execution.phaseLabel} · ${strategyName} · ${escapeHtml(cadenceLabel)}${escapeHtml(String(dayLabel))}`;

  return `
    <section class="panel-block pool-alloc-block" aria-label="本期分配">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">本期分配</h2>
          <p class="muted">${phaseLine}</p>
        </div>
        <div class="pool-alloc-heading-actions">
          <button class="ghost-button compact" type="button" data-ai-portfolio-review>AI 审视</button>
          <button class="primary-button compact" type="button" data-generate-exec-drafts>生成清单</button>
        </div>
      </div>
      <div class="pool-alloc-summary${prelimClass}">
        <div class="pool-alloc-metric"><span>${execution.phase === "initial" ? "建仓缺口" : "本期预算"}</span><strong>${money(pool.budget)}</strong></div>
        <div class="pool-alloc-metric"><span>建议部署${prelimTag}</span><strong>${money(pool.deployTotal)}</strong></div>
        <div class="pool-alloc-metric"><span>留现金</span><strong>${money(pool.cashKeep)}</strong></div>
        <div class="pool-alloc-metric"><span>现金池</span><strong>${money(cashBalance)}</strong></div>
      </div>
      ${draftStatus}
      <div class="dca-alloc-table" aria-label="各品种建议金额">
        <div class="dca-alloc-head"><span>品种</span><span>状态</span><span class="num">金额</span></div>
        ${rows
          .map((row) => {
            const active = highlightSymbol && row.symbol === highlightSymbol ? " is-current" : "";
            const analyzed = Boolean(analyzedMap[row.symbol]);
            const quoteMissing = Boolean(quoteMissingMap[row.symbol]);
            const amountClass = preliminary ? "num is-preliminary" : "num";
            const feeHint =
              !quoteMissing && feeHints[row.symbol]
                ? `<em class="pool-alloc-fee-hint muted">${escapeHtml(feeHints[row.symbol])}</em>`
                : "";
            const badge = dataStatusBadge(analyzed, quoteMissing);
            const chip = allocStatusChip(row);
            const chipClass =
              row.amount > 0 ? "is-buy" : chip === "偏贵" || chip === "攒一手" ? "is-wait" : "is-skip";
            const hint = allocStatusHint(chip);
            const nameCell = clickable
              ? `<button class="link-button pool-alloc-name" type="button" data-analyze="${escapeAttr(row.symbol)}">${escapeHtml(row.name)}${badge}${feeHint}</button>`
              : `<span>${escapeHtml(row.name)}${badge}${feeHint}</span>`;
            return `<div class="dca-alloc-row${active}">${nameCell}<span><span class="alloc-status-chip ${chipClass}" title="${escapeAttr(hint)}">${escapeHtml(chip)}</span></span><span class="${amountClass}">${row.amount > 0 ? money(row.amount) : "—"}</span></div>`;
          })
          .join("")}
      </div>
      ${progressNote}
      ${portfolioReviewResultHtml(state.aiPortfolioReview)}
    </section>
  `;
}

/** 供外部触发 AI 审视时复用当前分配结果。 */
export function currentPoolAllocationResult() {
  const plan = state.plan || {};
  const rawHoldings = buildPoolHoldingsForAllocation();
  const holdings = prepareHoldingsForAllocation(rawHoldings);
  const execution = planExecutionContext({ plan, holdings: rawHoldings });
  if (!(execution.budget > 0) || !holdings.length) return null;
  return allocatePoolBudget({
    budget: execution.budget,
    holdings,
    strategy: plan.strategy,
    strategyConfig: plan.strategy_config,
    strategyOverrides: plan.strategy_overrides,
    preferTargetGap: execution.phase === "initial",
    buildTargetAmount: execution.phase === "initial" ? execution.targetAmount : null,
    sentimentByMarket: sentimentByMarketFromState(),
    analysisRegistry: analysisRegistryFromConfig(),
    goldMacro: goldMacroFromState(),
    cashReserve: Number(plan.cash_reserve?.balance) || 0,
  });
}
