import { els, state, appConfig } from "../state.js";
import { escapeAttr, escapeHtml, money, signed, aiProviderLabel } from "../utils.js";
import {
  analysisSupported,
  GRADE_GUIDE,
  INDEX_CHART_RANGE_WINDOWS,
  INDEX_CHART_RANGE_LABELS,
} from "../constants.js";
import { getPeriodAdvice, STANCE } from "../period-advice.js";
import { drawPriceChart, buyEventMarkers, sellEventMarkers } from "../chart.js";
import { buildChartNarrative } from "../chart-narrative.js";
import {
  cycleExecution,
  orderPreview,
  cashReserveHintBalance,
  pendingOrderState,
  projectedPosition,
  returnCorrelation,
  riskMetrics,
} from "../decision-support.js";
import { ADD_PLAN_PRESETS, buildAddPlan } from "../add-plan.js";
import {
  analysisCacheKey,
  fetchAnalysis,
  getCachedAnalysis,
} from "../analysis-cache.js";
import { callRenderer, registerRenderers } from "./render.js";
import { persistWorkspace } from "../workspace.js";
import {
  orderActionLabel,
  positionGlance,
} from "../decision-status.js";
import { judgmentArrow, judgmentTone, pePercentileBias } from "../metric-judgment.js";
import { sellSuggestionForSymbol } from "../execution-drafts.js";

let indexChartBound = false;
const forceInefficientBySymbol = new Set();

const GRADE_TONES = { A: "grade-a", B: "grade-b", C: "grade-c", D: "grade-d", E: "grade-e" };

function cacheKey(symbol) {
  return analysisCacheKey(symbol);
}

function currentPayload() {
  return getCachedAnalysis(state.analysisSymbol);
}

function fmt(value, digits = 2, suffix = "") {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Number(value).toFixed(digits)}${suffix}`;
}

function valueWithJudgmentArrow(valueHtml, label) {
  const arrow = judgmentArrow(label);
  if (!arrow || !valueHtml || valueHtml === "—") return valueHtml;
  const tone = judgmentTone(label);
  const cls = tone ? ` class="metric-judgment ${tone}"` : ` class="metric-judgment"`;
  return `${valueHtml}<em${cls} title="${escapeAttr(label || "")}">${arrow}</em>`;
}

/** 数值后追加文字判断（如 PE 分位「偏高」），按 tone 上色；偏高为红。 */
function valueWithJudgmentLabel(valueHtml, label) {
  const text = String(label || "").trim();
  if (!text || !valueHtml || valueHtml === "—") return valueHtml;
  const tone = judgmentTone(text);
  const cls = tone ? ` class="metric-judgment ${tone}"` : ` class="metric-judgment"`;
  return `${valueHtml}<em${cls}>${escapeHtml(text)}</em>`;
}

const RSI_METRIC_HELP =
  "相对强弱指标 RSI(14)。本页口径：低于 30 为超卖，高于 70 为超买，中间为中性；越接近超卖，短线技术分越高。";
const KDJ_METRIC_HELP =
  "随机指标 KDJ(9,3,3)。本页口径：J 低于 10 为超卖区间，高于 90 为超买区间，其余为中性；与 RSI 一起衡量短线强弱。";

function metricLabelHtml(label, help = "") {
  const text = escapeHtml(label);
  if (!help) return text;
  return `${text}<span class="metric-help" title="${escapeAttr(help)}" aria-label="${escapeAttr(help)}" tabindex="0">?</span>`;
}

function fmtSigned(value, digits = 2, suffix = "") {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}${suffix}`;
}

function syncAnalysisChrome(payload) {
  const symbol = state.analysisSymbol;
  const indexName = payload?.index_name || payload?.name || symbol || "指数";
  const etfName = payload?.etf?.symbol_name || payload?.etf?.name || payload?.etf_name || "";
  const fundTitle = etfName
    ? symbol
      ? `${etfName} · ${symbol}`
      : etfName
    : symbol || indexName || "分析";
  const proxy = payload?.analysis_mode === "etf_proxy";

  if (els.pageTitle) els.pageTitle.textContent = fundTitle;
  if (els.pageSubtitle) {
    const text = indexName
      ? proxy
        ? `跟踪指数：${indexName} · ETF 口径`
        : `跟踪指数：${indexName}`
      : "";
    if (els.pageSubtitleText) els.pageSubtitleText.textContent = text;
    else els.pageSubtitle.textContent = text;
    els.pageSubtitle.hidden = !text;
  }
  syncDividendDataStatus(payload);
}

/** 分析状态统一写在顶栏 topSourceStatus；dividendStatus 仅作错误兜底。 */
function syncDividendDataStatus(payload) {
  if (!payload) return;
  if (payload.supported === false) {
    const message = payload.error || "暂不支持完整估值分析";
    if (els.topSourceStatus) els.topSourceStatus.textContent = `分析不可用 · ${message}`;
    if (els.dividendStatus) {
      els.dividendStatus.hidden = false;
      els.dividendStatus.textContent = message;
    }
    document.body.dataset.quoteStatus = "error";
    return;
  }
  if (payload.error) {
    const message = `数据不可用：${payload.error}`;
    if (els.topSourceStatus) els.topSourceStatus.textContent = message;
    if (els.dividendStatus) {
      els.dividendStatus.hidden = false;
      els.dividendStatus.textContent = message;
    }
    document.body.dataset.quoteStatus = "error";
    return;
  }
  const freshness = `数据更新于 ${payload.updated_at || "—"} · 指数收盘日 ${payload.index?.date || "—"}`;
  if (els.topSourceStatus) {
    els.topSourceStatus.textContent = freshness;
  }
  if (els.dividendStatus) {
    els.dividendStatus.textContent = "";
    els.dividendStatus.hidden = true;
  }
  document.body.dataset.quoteStatus = "connected";
}

async function loadDividend(force = false) {
  const symbol = state.analysisSymbol;
  const key = cacheKey(symbol);
  const cached = getCachedAnalysis(symbol);
  if (!force && cached != null) {
    return cached;
  }
  const label = symbol || "分析";
  if (cacheKey(state.analysisSymbol) === key) {
    if (els.topSourceStatus) {
      els.topSourceStatus.textContent = `正在拉取 ${label} 数据…`;
    }
    if (els.dividendStatus) {
      els.dividendStatus.textContent = "";
      els.dividendStatus.hidden = true;
    }
  }
  const payload = await fetchAnalysis(symbol, { force });
  if (cacheKey(state.analysisSymbol) !== key) return payload;
  syncAnalysisChrome(payload);
  return payload;
}

export async function renderDividend({ force = false } = {}) {
  if (!els.dividendContent) return;
  const cached = currentPayload();
  if (!cached || force) {
    els.dividendContent.hidden = cached == null;
    await loadDividend(force);
  } else {
    syncAnalysisChrome(cached);
  }
  paintDividend();
}

/** 打开某只池内 ETF 的分析页。 */
export async function openAnalysis(symbol = null) {
  if (!symbol) {
    const preferred = appConfig?.dividend?.etf_symbol || "512890";
    symbol = state.etfs.find((item) => item.symbol === preferred)?.symbol || state.etfs[0]?.symbol || null;
  }
  if (!symbol) {
        callRenderer("switchView", "home");
    return;
  }
  state.analysisSymbol = symbol;
  state.activeView = "dividend";
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.remove("active"));
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === "dividendView");
  });
  callRenderer("renderSidebarEtfs");
  const cached = state.analysisCache[cacheKey(symbol)];
  const forceRefresh =
    Boolean(cached?.error) ||
    (cached?.supported === false && analysisSupported(appConfig, symbol));
  await renderDividend({ force: forceRefresh });
  document.querySelector("#dividendView")?.scrollIntoView({ block: "start" });
}

function scoreCardHtml() {
  const payload = currentPayload() || {};
  const score = payload.score || {};
  const backtest = payload.backtest || {};
  const tone = GRADE_TONES[score.grade] || "grade-c";
  const grade = score.grade || "—";
  const technicalFramework = score.framework === "technical";
  const components = (score.components || [])
    .map((component) => {
      const width = component.score == null ? 0 : Math.max(2, Math.min(100, component.score));
      return `
        <div class="dividend-component">
          <span class="dividend-component-label">${escapeHtml(component.label)}<em>${Math.round(component.weight * 100)}%</em></span>
          <span class="dividend-component-track"><i style="width:${width}%"></i></span>
          <strong>${component.score == null ? "—" : Math.round(component.score)}</strong>
        </div>
      `;
    })
    .join("");
  const backtestLine = backtest.samples
    ? `同评分 ±${backtest.band} · ${backtest.samples} 独立样本 · ${backtest.horizon_days} 日均 <strong>${fmtSigned(backtest.avg_return_pct, 1, "%")}</strong> · 胜率 <strong>${fmt(backtest.win_rate_pct, 0, "%")}</strong>（${escapeHtml(backtest.label || "")} · ${fmtSigned(backtest.worst_pct, 1, "%")} ~ ${fmtSigned(backtest.best_pct, 1, "%")}）`
    : "历史同评分独立样本不足，暂无回测参考。";
  const kicker = technicalFramework
    ? `${grade} 档 · 技术面诊断（无估值权重）`
    : `${grade} 档`;
  return `
    <section class="panel-block dividend-score-card dividend-score-card-secondary ${tone}" aria-label="综合评分" title="${escapeAttr(GRADE_GUIDE)}">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">综合评分</h2>
        </div>
      </div>
      <div class="dividend-score-main">
        <div class="dividend-grade-mark" aria-hidden="true">${escapeHtml(grade)}</div>
        <div class="dividend-score-copy">
          <p class="dividend-grade-kicker">${escapeHtml(kicker)}</p>
          <strong class="dividend-score-total">${score.total == null ? "—" : Math.round(score.total)}</strong>
        </div>
      </div>
      <div class="dividend-components">${components}</div>
      <p class="muted dividend-backtest-line">${backtestLine}</p>
    </section>
  `;
}

function metricsCardHtml() {
  return `
    <section class="panel-block dividend-metrics-card" aria-label="关键指标">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">关键指标</h2>
        </div>
      </div>
      <div class="metric-grid dividend-metrics">${metricsHtml()}</div>
    </section>
  `;
}

function metricsHtml() {
  const payload = currentPayload() || {};
  const etf = payload.etf || {};
  const index = payload.index || {};
  const valuation = payload.valuation || {};
  const bond = payload.bond || {};
  const spread = payload.spread || {};
  const technicals = payload.technicals || {};
  const kdj = technicals.kdj || {};
  const chartMarkers = payload.chart?.markers || {};
  const price = etf.price != null ? etf.price : index.close;
  const change = etf.price != null ? etf.change_pct : index.change_pct;
  const priceDigits = etf.price != null ? 3 : 2;
  const priceSub = etf.price != null
    ? `指数 ${fmt(index.close, 2)}`
    : "指数收盘（中证指数官网）";
  const changeClass = change > 0 ? "up" : change < 0 ? "down" : "";
  const pePct = valuation.pe_percentile_10y;
  const technicalFramework =
    payload.score?.framework === "technical" ||
    payload.asset_class === "commodity" ||
    payload.asset_class === "bond";
  // 年线数字与上方图表同口径：有 ETF 图标记用 ETF MA250，否则明确标「指数」
  const chartMa = chartMarkers.ma250;
  let biasValue = technicals.bias_pct;
  let maSub;
  if (chartMa != null && payload.chart?.price_basis !== "index") {
    if (price != null && chartMa > 0) biasValue = (Number(price) / Number(chartMa) - 1) * 100;
    maSub = `MA250 ${fmt(chartMa, 3)}`;
  } else if (technicals.ma250 != null) {
    maSub = `指数 MA250 ${fmt(technicals.ma250, 2)}`;
  } else {
    maSub = "MA250 —";
  }
  const valuationCard = technicalFramework
    ? {
        label: metricLabelHtml("估值口径"),
        value: "不适用",
        sub: payload.asset_class === "bond" ? "债券类无股票 PE/股息" : "商品类无股票 PE/股息",
      }
    : {
        label: metricLabelHtml("PE 近 10 年分位"),
        value:
          pePct == null
            ? "—"
            : valueWithJudgmentLabel(
                `${Math.round(pePct * 100)}<em>%</em>`,
                pePercentileBias(pePct),
              ),
        sub: `PE ${fmt(valuation.pe, 2)} · PB ${fmt(valuation.pb, 2)}`,
      };
  const spreadCard = technicalFramework
    ? {
        label: metricLabelHtml("股债利差"),
        value: "不适用",
        sub: "非股票估值框架，不参与定投倍率",
      }
    : {
        label: metricLabelHtml("股债利差"),
        value: valueWithJudgmentArrow(fmt(spread.value, 2), spread.label),
        sub: `股息 ${fmt(valuation.dividend_yield_pct, 2, "%")} / 国债 ${fmt(bond.yield10y, 2, "%")}`,
      };
  const cards = [
    valuationCard,
    {
      label: metricLabelHtml("年线乖离"),
      value: fmtSigned(biasValue, 2, "%"),
      sub: maSub,
    },
    spreadCard,
    {
      label: metricLabelHtml("现价 / 单日"),
      value: `${fmt(price, priceDigits)} <em class="${changeClass}">${fmtSigned(change, 2, "%")}</em>`,
      sub: priceSub,
    },
    {
      label: metricLabelHtml("RSI(14)", RSI_METRIC_HELP),
      value: valueWithJudgmentArrow(fmt(technicals.rsi14, 0), technicals.rsi_label),
      sub: "",
    },
    {
      label: metricLabelHtml("KDJ(9,3,3)", KDJ_METRIC_HELP),
      value: valueWithJudgmentArrow(
        `K ${fmt(kdj.k, 0)} · D ${fmt(kdj.d, 0)} · J ${fmt(kdj.j, 0)}`,
        technicals.kdj_label,
      ),
      sub: "",
    },
  ];
  return cards
    .map(
      (card, index) => `
        <div class="metric-card dividend-metric" style="--stagger:${index}">
          <span class="dividend-metric-label">${card.label}</span>
          <strong>${card.value}</strong>
          ${card.sub ? `<small class="muted">${card.sub}</small>` : ""}
        </div>
      `,
    )
    .join("");
}

function currentPeriodAdvice() {
  const payload = currentPayload() || {};
  const symbol = state.analysisSymbol || payload.symbol || payload.etf?.symbol || "";
  return getPeriodAdvice({
    symbol,
    preferLive: payload && !payload.error ? payload : null,
  });
}

function currentAIReview() {
  const symbol = state.analysisSymbol || currentPayload()?.symbol || "";
  return state.aiReviews[symbol] || null;
}

function aiListHtml(items, empty = "暂无") {
  if (!Array.isArray(items) || !items.length) return `<p class="muted">${empty}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function aiAnalysisSectionsHtml(proposal) {
  const dynamicSections = Array.isArray(proposal.analysis_sections)
    ? proposal.analysis_sections.filter((section) => section?.title && Array.isArray(section.items) && section.items.length)
    : [];
  const fallbackSections = [
    { title: "有利条件", items: proposal.supporting_factors },
    { title: "主要约束", items: proposal.risks },
  ].filter((section) => Array.isArray(section.items) && section.items.length);
  const sections = dynamicSections.length ? dynamicSections : fallbackSections;
  if (!sections.length) return "";
  return `
    <div class="ai-review-details" data-section-count="${sections.length}">
      ${sections
        .map(
          (section) => `
            <div>
              <h3>${escapeHtml(section.title)}</h3>
              ${aiListHtml(section.items)}
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function aiReviewHtml(advice, context) {
  const enabled = appConfig?.ai?.enabled === true;
  const review = currentAIReview();
  const aiDisclaimer =
    '<p class="muted ai-review-title-note">AI 分析仅供研究参考，不构成投资建议。</p>';
  if (!enabled) {
    return `
      <section class="panel-block ai-review-card ai-guide-card is-disabled" aria-label="AI 分析">
        <div class="panel-heading">
          <div>
            <h2 class="section-title">AI 分析</h2>
            ${aiDisclaimer}
          </div>
          <span class="muted">未启用</span>
        </div>
        <p class="ai-guide-copy">配置 DeepSeek 或 OpenAI 后，可对估值、趋势与仓位矛盾做二次审视；最终金额仍受本地策略与风控约束。</p>
        <button class="primary-button compact" type="button" data-open-settings>去设置配置</button>
      </section>
    `;
  }
  if (review?.status === "loading") {
    return `
      <section class="panel-block ai-review-card is-loading" aria-live="polite">
        <div class="panel-heading"><div><h2 class="section-title">AI 分析</h2>${aiDisclaimer}</div></div>
        <p class="muted ai-review-status">正在识别 ETF 的关键矛盾，请稍候…</p>
      </section>
    `;
  }
  if (review?.status === "error") {
    return `
      <section class="panel-block ai-review-card is-error">
        <div class="panel-heading">
          <div><h2 class="section-title">AI 分析</h2>${aiDisclaimer}</div>
          <button class="ghost-button compact" data-ai-review type="button">重试</button>
        </div>
        <p class="down ai-review-status">${escapeHtml(review.error)}</p>
        <p class="muted ai-review-status">规则建议保持有效，AI 失败不会改变本期结论。</p>
      </section>
    `;
  }
  const result = review?.result;
  if (!result) {
    return `
      <section class="panel-block ai-review-card ai-guide-card" aria-label="AI 分析">
        <div class="panel-heading">
          <div>
            <h2 class="section-title">AI 分析</h2>
            ${aiDisclaimer}
          </div>
          <button class="primary-button compact" data-ai-review type="button">开始分析</button>
        </div>
      </section>
    `;
  }
  const proposal = result.ai_proposal || {};
  const policy = result.policy_decision || {};
  const baselineAmount = result.baseline_recommendation?.remaining_amount || 0;
  const correctedAmount = result.final_recommendation?.amount || 0;
  const useCorrection = review.selection !== "baseline";
  const displayedAmount = useCorrection ? correctedAmount : baselineAmount;
  const actionLabels = {
    keep: "维持",
    increase: "提高",
    reduce: "降低",
    pause: "暂停",
  };
  const confidenceLabels = { low: "低", medium: "中", high: "高" };
  const watchItems = [...(proposal.watch_items || []), ...(proposal.conditions_to_reverse || [])];
  return `
    <section class="panel-block ai-review-card" aria-label="AI 分析">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">AI 分析</h2>
          ${aiDisclaimer}
          <p class="muted">${escapeHtml(aiProviderLabel(result.provider))} · ${escapeHtml(result.model)}${result.cached ? " · 缓存" : ""}</p>
        </div>
        <button class="ghost-button compact" data-ai-review data-force="true" type="button">重新分析</button>
      </div>
      <div class="ai-review-summary">
        <div><span>规则剩余额度</span><strong>${money(baselineAmount)}</strong></div>
        <div><span>AI 判断</span><strong>${escapeHtml(actionLabels[proposal.action] || proposal.action)} · ${fmt(policy.accepted_multiplier, 2)}×</strong></div>
        <div><span>风控后额度</span><strong>${money(correctedAmount)}</strong></div>
        <div><span>可信度</span><strong>${escapeHtml(confidenceLabels[proposal.confidence] || "—")}</strong></div>
      </div>
      <p class="ai-review-headline">${escapeHtml(proposal.summary || "模型未提供摘要")}</p>
      ${aiAnalysisSectionsHtml(proposal)}
      ${watchItems.length ? `<div class="ai-review-watch"><strong>后续观察</strong>${aiListHtml(watchItems)}</div>` : ""}
      <div class="ai-review-choice" role="group" aria-label="选择本期参考建议">
        <button class="${useCorrection ? "primary-button" : "ghost-button"} compact" data-ai-choice="corrected" type="button">采用 AI 分析</button>
        <button class="${useCorrection ? "ghost-button" : "primary-button"} compact" data-ai-choice="baseline" type="button">保持规则建议</button>
        <strong>当前参考：${money(displayedAmount)}</strong>
      </div>
    </section>
  `;
}

async function requestAIReview({ force = false } = {}) {
  const payload = currentPayload();
  const symbol = state.analysisSymbol || payload?.symbol || payload?.etf?.symbol || "";
  if (!symbol) return;
  const advice = currentPeriodAdvice();
  const context = decisionContext(advice);
  state.aiReviews[symbol] = { status: "loading" };
  paintDividend();
  try {
    const response = await fetch("/api/ai/review-recommendation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        force,
        baseline: {
          stance: advice.stance,
          headline: advice.headline,
          reason: advice.reason,
          amount: advice.amount,
          remaining_amount: context.cycle.remainingAmount,
        },
        position: {
          target_weight: advice.position?.targetWeight,
          actual_weight: advice.position?.actualWeight,
          projected_weight: context.position.projectedWeight,
          blocked: context.position.blocked,
          would_exceed: context.position.wouldExceed,
          execution_phase: advice.execution?.phase,
          execution_budget: context.cycle.remainingAmount,
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `AI API ${response.status}`);
    state.aiReviews[symbol] = { status: "ready", result, selection: "corrected" };
  } catch (error) {
    state.aiReviews[symbol] = { status: "error", error: String(error.message || error) };
  }
  paintDividend();
}

function decisionContext(advice) {
  const payload = currentPayload() || {};
  const symbol = state.analysisSymbol || payload.symbol || payload.etf?.symbol || "";
  const entry = state.etfs.find((item) => item.symbol === symbol) || null;
  const price = payload.etf?.price != null ? Number(payload.etf.price) : Number(payload.index?.close);
  const pending = pendingOrderState({
    plan: state.plan,
    buys: state.buys,
    symbol,
    recommendedAmount: advice?.amount || 0,
    phase: advice?.execution?.phase || null,
  });
  if (pending?.changed) {
    state.plan.pending_orders = {
      ...(state.plan.pending_orders || {}),
      [symbol]: {
        period: pending.period,
        carry: pending.carry,
        scheduled: pending.scheduled,
        remaining: pending.remaining,
      },
    };
    persistWorkspace();
  }
  // 可用额只含本期策略分配；历史留存见现金池，不再叠加 carry
  const availableAmount = Math.max(0, Number(pending?.scheduled) || 0);
  const cycle = cycleExecution({
    plan: state.plan,
    buys: state.buys,
    symbol,
    recommendedAmount: availableAmount,
  });
  const executableAmount = advice?.canAdd ? cycle.remainingAmount : 0;
  const allowInefficient = forceInefficientBySymbol.has(symbol);
  const order = orderPreview(executableAmount, price, {
    ...(state.plan?.trading_cost || {}),
    allowInefficient,
  });
  let portfolioValue = 0;
  state.etfs.forEach((item) => {
    const itemPrice =
      item.symbol === symbol && price > 0
        ? price
        : Number(state.quotesBySymbol[item.symbol]?.price);
    if (itemPrice > 0 && item.shares > 0) portfolioValue += itemPrice * item.shares;
  });
  const currentValue = entry && price > 0 ? entry.shares * price : 0;
  const capitalBase = Math.max(0, Number(state.plan?.capital_base) || 0);
  const position = projectedPosition({
    currentValue,
    portfolioValue,
    buyAmount: order.estimatedAmount,
    targetWeight: advice?.position?.targetWeight,
  });
  const points = payload.chart?.points || [];
  const risk = riskMetrics(points);
  const correlations = Object.entries(state.analysisCache)
    .filter(([key, cached]) => key !== symbol && Array.isArray(cached?.chart?.points))
    .map(([key, cached]) => ({
      symbol: key,
      name: state.etfs.find((item) => item.symbol === key)?.name || cached.etf_name || key,
      correlation: returnCorrelation(points, cached.chart.points),
    }))
    .filter((item) => item.correlation)
    .sort((left, right) => Math.abs(right.correlation.value) - Math.abs(left.correlation.value));
  return {
    symbol,
    entry,
    price,
    cycle,
    pending,
    order,
    position,
    portfolioValue,
    currentValue,
    capitalBase,
    assetPositionPct: capitalBase > 0 && currentValue > 0 ? (currentValue / capitalBase) * 100 : null,
    risk,
    strongestCorrelation: correlations[0] || null,
    sell: sellSuggestionForSymbol(symbol, { preferLive: payload }),
  };
}

const CYCLE_STATUS_LABELS = {
  waiting: "等待执行日",
  due: "今日执行",
  overdue: "已过执行日",
  partial: "本期部分完成",
  completed: "本期已完成",
  not_required: "本期无需执行",
};

/** 标题用可下单余额；策略全额只在被截断时作依据，避免与「本阶段可用」并排打架。 */
function conclusionHeadline(advice, context) {
  const sell = context?.sell;
  const sellHeadline =
    sell?.shares > 0 && sell.suggested_amount > 0
      ? `建议卖出 ${money(sell.suggested_amount)}`
      : null;
  if (advice?.stance !== STANCE.INVEST) {
    // 买入侧不投时，若有卖出纪律，标题改成可执行卖出结论
    return sellHeadline || advice?.headline || "";
  }
  const amount = Number(advice?.amount) || 0;
  const remaining = Number(context?.cycle?.remainingAmount) || 0;
  const executed = Number(context?.cycle?.executedAmount) || 0;
  const initial = advice?.execution?.phase === "initial";
  const verb = initial ? "建议投入" : "本期建议投入";
  if (amount > 0 && remaining <= 0 && executed > 0) {
    return sellHeadline || "本期已完成";
  }
  const display = advice?.canAdd ? remaining : amount;
  return `${verb} ${money(display)}`;
}

function sellAdviceHtml(sell) {
  if (!sell?.shares || !(sell.suggested_amount > 0)) return "";
  const status =
    sell.draftStatus === "confirmed"
      ? "已入账"
      : sell.draftStatus === "pending"
        ? "待执行"
        : "";
  return `
    <div class="dividend-sell-callout" aria-label="卖出建议">
      <div class="dividend-sell-callout-head">
        <span class="trade-type sell">卖出</span>
        <strong>${escapeHtml(sell.band || "卖出纪律")}</strong>
        ${status ? `<span class="muted">${escapeHtml(status)}</span>` : ""}
      </div>
      <p class="dividend-sell-callout-main">
        ${Number(sell.shares).toLocaleString("zh-CN")} 份 · ${money(sell.suggested_amount)}
        <span class="muted">费 ${money(sell.fee || 0)}</span>
      </p>
      <p class="muted dividend-sell-callout-hint">${escapeHtml(sell.hint || "")}</p>
    </div>
  `;
}

function executionPanelHtml(advice, context) {
  const { cycle, order, position, symbol, sell } = context;
  const initial = advice?.execution?.phase === "initial";
  const strategyAmount = Number(advice?.amount) || 0;
  const remaining = Number(cycle.remainingAmount) || 0;
  const executed = Number(cycle.executedAmount) || 0;
  const cashReserveBalance = cashReserveHintBalance(state.plan);
  // 可执行额已上标题时，明细只补「策略全额 / 已买」依据，不再复述同一可用额
  const truncated =
    advice?.stance === STANCE.INVEST &&
    strategyAmount > 0 &&
    (Math.abs(strategyAmount - remaining) > 0.009 || executed > 0.009);
  const lastBuyText = cycle.lastBuy
    ? `${cycle.lastBuy.date} · ${Number(cycle.lastBuy.price).toFixed(3)}`
    : "暂无记录";
  const forcedPreview =
    order.shares <= 0 && order.maxAffordableShares >= order.lotSize
      ? orderPreview(cycle.remainingAmount, context.price, {
          ...(state.plan?.trading_cost || {}),
          allowInefficient: true,
        })
      : null;
  const willOrder = order.shares > 0;
  const overweightHint =
    position.overweight ||
    (position.projectedDrift != null && position.projectedDrift > 5);
  const buyAction = orderActionLabel({
    cycleCompleted: cycle.status === "completed",
    willOrder,
    shares: order.shares,
    inefficient: order.inefficient,
    overweight: overweightHint,
    blockedReason: order.blockedReason,
    initial,
    hasAmount: Number(advice?.amount) > 0,
  });
  const sellAction =
    sell?.shares > 0
      ? `建议卖出 ${Number(sell.shares).toLocaleString("zh-CN")} 份`
      : "";
  const action =
    sellAction && (!willOrder || advice?.stance !== STANCE.INVEST)
      ? sellAction
      : sellAction
        ? `${buyAction} · ${sellAction}`
        : buyAction;

  const skipOrder = !willOrder && !(advice?.amount > 0 && order.blockedReason);
  const rolled = Math.max(0, Number(context.pending?.rolled) || 0);
  const gridRows = [
    `<div><dt>当前阶段</dt><dd>${initial ? "初期建仓" : "周期定投"}</dd></div>`,
    `<div><dt>计划执行日</dt><dd>${escapeHtml(cycle.scheduled)}</dd></div>`,
  ];
  if (initial) {
    gridRows.push(
      `<div><dt>建仓目标</dt><dd>${money(advice.execution.targetAmount)}</dd></div>`,
      `<div><dt>当前仓位</dt><dd>${fmt(advice.execution.currentPositionPct, 1, "%")}</dd></div>`,
    );
  } else {
    gridRows.push(`<div><dt>本期已买</dt><dd>${money(executed)}</dd></div>`);
  }
  if (truncated) {
    gridRows.push(`<div><dt>策略分配</dt><dd>${money(strategyAmount)}</dd></div>`);
    if (initial) {
      gridRows.push(`<div><dt>本期已买</dt><dd>${money(executed)}</dd></div>`);
    }
  }
  if (rolled > 0) {
    gridRows.push(`<div><dt>上期滚入</dt><dd>${money(rolled)}</dd></div>`);
  }
  // 历史留存只展示一次现金池余额（>0）；不再展示跨期 carry
  if (cashReserveBalance > 0) {
    gridRows.push(`<div><dt>现金池</dt><dd>${money(cashReserveBalance)}</dd></div>`);
  }
  if (sell?.shares > 0) {
    gridRows.push(
      `<div><dt>卖出纪律</dt><dd>${escapeHtml(sell.band || "卖出")}</dd></div>`,
      `<div><dt>建议卖出份额</dt><dd>${Number(sell.shares).toLocaleString("zh-CN")} 份</dd></div>`,
      `<div><dt>卖出金额</dt><dd>${money(sell.suggested_amount)}</dd></div>`,
      `<div><dt>卖出手续费</dt><dd>${money(sell.fee || 0)}</dd></div>`,
      `<div><dt>卖后目标仓位</dt><dd>${fmt(sell.sellToWeight, 1, "%")}</dd></div>`,
    );
  }
  if (willOrder || (!skipOrder && advice?.amount > 0)) {
    gridRows.push(
      `<div><dt>建议成交份额</dt><dd>${willOrder ? `${order.shares.toLocaleString("zh-CN")} 份` : "—"}</dd></div>`,
      `<div><dt>成交金额</dt><dd>${willOrder ? money(order.estimatedAmount) : "—"}</dd></div>`,
      `<div><dt>预计手续费</dt><dd>${willOrder ? money(order.fee) : "—"}</dd></div>`,
      `<div><dt>实际占用资金</dt><dd>${willOrder ? money(order.totalCash) : "—"}</dd></div>`,
      `<div><dt>手续费占比</dt><dd>${
        order.feeRatioPct != null
          ? `${fmt(order.feeRatioPct, 3)}%${order.inefficient ? " · 高于效率阈值" : ""}`
          : "—"
      }</dd></div>`,
      `<div><dt>取整余款</dt><dd>${money(order.cashRemainder)}</dd></div>`,
    );
  }
  gridRows.push(`<div><dt>最近买入</dt><dd>${escapeHtml(lastBuyText)}</dd></div>`);

  return `
    <div class="decision-execution" aria-label="本期执行状态">
      <div class="decision-execution-head">
        <strong>${escapeHtml(action)}</strong>
        <span>${initial ? "初期建仓" : escapeHtml(CYCLE_STATUS_LABELS[cycle.status] || cycle.status)}</span>
      </div>
      <dl class="decision-execution-grid">
        ${gridRows.join("")}
      </dl>
      ${
        order.blockedReason === "fee_inefficient" && forcedPreview?.shares > 0
          ? `<div class="decision-execution-force">
              <p class="muted">最小 ${order.minimumEfficientShares.toLocaleString("zh-CN")} 份 · 仍买 ${forcedPreview.shares.toLocaleString("zh-CN")} 份约 ${fmt(forcedPreview.feeRatioPct, 3)}%</p>
              <button class="ghost-button compact" type="button" data-force-inefficient="${escapeAttr(symbol)}">等不及了</button>
            </div>`
          : order.inefficient
            ? `<div class="decision-execution-force">
                <button class="ghost-button compact" type="button" data-clear-force-inefficient="${escapeAttr(symbol)}">改回累计</button>
              </div>`
            : ""
      }
    </div>
  `;
}

function addPlanHeadingHtml(presetLabel) {
  return `
    <div class="panel-heading">
      <div>
        <h2 class="section-title">分档策略 - ${escapeHtml(presetLabel)}</h2>
      </div>
    </div>
  `;
}

function addPlanHtml(entry, price, advice, payload = null) {
  // 无可分档内容时不渲染，避免空壳占位
  const config = state.plan?.add_plan;
  if (config && config.enabled === false) return "";
  if (!entry || !(entry.shares > 0)) return "";
  if (advice?.canAdd !== true) return "";
  const amount = Number(advice?.amount) || 0;
  if (!(amount > 0)) return "";

  const assetClass = advice?.assetClass || payload?.asset_class || null;
  const plan = buildAddPlan({
    cost: entry.cost > 0 ? entry.cost : null,
    price,
    amount,
    assetClass,
    mult: advice?.mult,
    config,
    tradingCost: state.plan?.trading_cost,
  });
  if (!plan.applicable || !plan.levels?.length) return "";

  const presetLabel = plan.presetLabel || ADD_PLAN_PRESETS.auto.label;
  const levelsHtml = `
    <div class="dividend-add-levels">
      ${plan.levels
        .map((level) => {
          const distance =
            price != null && price > 0 ? ((level.trigger - price) / price) * 100 : null;
          return `
            <article class="dividend-add-level${level.triggered ? " is-triggered" : ""}">
              <div class="dividend-add-level-top">
                <strong>${escapeHtml(level.name)}</strong>
                <span>-${level.drawdownPct.toFixed(1)}%</span>
              </div>
              <div class="dividend-add-trigger">
                <small>触发价</small>
                <strong>${level.trigger.toFixed(3)}</strong>
              </div>
              <dl>
                <div>
                  <dt>距离现价</dt>
                  <dd>${level.triggered ? "已触发" : distance != null ? `${fmtSigned(distance, 2, "%")}` : "—"}</dd>
                </div>
                <div>
                  <dt>预留额度</dt>
                  <dd>${money(level.amount)}</dd>
                </div>
                <div>
                  <dt>参考份额</dt>
                  <dd>${level.shares > 0 ? `${level.shares.toLocaleString("zh-CN")} 份` : "继续累计"}</dd>
                </div>
              </dl>
            </article>
          `;
        })
        .join("")}
    </div>
  `;

  return `
    <section class="panel-block dividend-add-plan" aria-label="分档策略">
      ${addPlanHeadingHtml(presetLabel)}
      ${levelsHtml}
    </section>
  `;
}

function multFormulaHtml(breakdown) {
  if (!breakdown?.factors?.length) return "";
  const terms = breakdown.factors
    .map((factor, index) => {
      const note = factor.note
        ? `<span class="advice-mult-note">（${escapeHtml(factor.note)}）</span>`
        : "";
      const term = `<span class="advice-mult-term"><span class="advice-mult-role">${escapeHtml(factor.role)}</span> <strong>${escapeHtml(factor.multText)}</strong>${note}</span>`;
      if (index === 0) return term;
      return `<span class="advice-mult-op" aria-hidden="true">×</span>${term}`;
    })
    .join("");
  return `
    ${terms}
    <span class="advice-mult-op advice-mult-eq" aria-hidden="true">=</span>
    <strong class="advice-mult-result">${escapeHtml(breakdown.result)}</strong>
  `;
}

function reasonChainHtml({ strategyName, peText, mult, multBreakdown }) {
  const strategy = strategyName || "策略";
  if (multBreakdown?.factors?.length > 1) {
    return `
      <div class="dividend-reason-chain is-merged" aria-label="原因链">
        <p class="dividend-reason-meta">
          <span class="dividend-reason-step">${escapeHtml(strategy)}</span>
          <span class="dividend-reason-sep" aria-hidden="true">·</span>
          <span class="dividend-reason-step">${escapeHtml(peText)}</span>
        </p>
        <p class="advice-mult-line advice-mult-inline">${multFormulaHtml(multBreakdown)}</p>
      </div>
    `;
  }
  const steps = [strategy, peText, `${mult ?? "—"}×`];
  return `
    <p class="dividend-reason-chain" aria-label="原因链">
      ${steps
        .map(
          (step, index) => `
        <span class="dividend-reason-step${index === steps.length - 1 ? " is-result" : ""}">${escapeHtml(step)}</span>
        ${index < steps.length - 1 ? `<span class="dividend-reason-sep" aria-hidden="true">→</span>` : ""}
      `,
        )
        .join("")}
    </p>
  `;
}

function dcaAdviceHtml(advice, context) {
  const payload = currentPayload() || {};
  const score = payload.score || {};
  const grade = score.grade || "—";
  const proxy = payload.analysis_mode === "etf_proxy";
  const active = advice || currentPeriodAdvice();
  const bullets = [...(active.bullets || [])];
  if (proxy && active.pePct == null) bullets.push("ETF 口径");
  const assetClass = active.assetClass || payload.asset_class || "";
  if (assetClass === "commodity") {
    const macro = active.goldMacro || payload.gold_macro;
    if (macro && !macro.degraded && macro.score != null) {
      const us = macro.us10y?.value != null ? `美债 ${macro.us10y.value}%` : "";
      const usd =
        macro.usd_index?.value != null ? `美元指数 ${macro.usd_index.value}` : "";
      const parts = [macro.band || "宏观", us, usd].filter(Boolean);
      bullets.push(`宏观 ${parts.join(" · ")} · ×${macro.mult ?? 1}`);
    }
  }

  const strategyAmount = Number(active.amount) || 0;
  const remaining = Number(context?.cycle?.remainingAmount) || 0;
  const executed = Number(context?.cycle?.executedAmount) || 0;
  // 标题已是可执行额时，用一句依据说明被截断来源，不再并列第二个「建议」金额；现金池见执行面板
  if (
    active.stance === STANCE.INVEST &&
    strategyAmount > 0 &&
    (Math.abs(strategyAmount - remaining) > 0.009 || executed > 0.009)
  ) {
    const parts = [`策略分配 ${money(strategyAmount)}`];
    if (executed > 0.009) parts.push(`本期已买 ${money(executed)}`);
    bullets.push(parts.join(" · "));
  }

  const sell = context?.sell;
  const tone =
    sell?.shares > 0 && active.stance !== STANCE.INVEST
      ? "grade-d"
      : active.stance === STANCE.INVEST
        ? GRADE_TONES[grade] || "grade-c"
        : active.stance === STANCE.NEED_BUDGET
          ? "grade-c"
          : "grade-d";

  const mixedValuation =
    assetClass === "dividend" && String(active.hint || "").includes("混合");
  const peText = mixedValuation
    ? "PE+利差混合分位"
    : assetClass === "commodity"
      ? active.band || "商品技术面"
      : assetClass === "bond"
        ? active.band || "债券类 · 定额参与"
        : active.pePct != null
          ? `PE 分位 ${(Number(active.pePct) * 100).toFixed(0)}%`
          : active.band || "估值未知";
  // 原因链与倍率拆解合并为一块；无拆解时仍展示「策略 → 依据 → 倍率」
  const multBreakdown = active.multBreakdown;
  let listBullets =
    multBreakdown?.factors?.length > 1 && String(bullets[0] || "").startsWith("倍率拆解")
      ? bullets.slice(1)
      : bullets;
  // 有卖出纪律时，买入侧「暂停新增」等原因加前缀，避免与「建议卖出」读成二选一
  if (sell?.shares > 0 && active.reason) {
    listBullets = listBullets.map((item) =>
      item === active.reason ? `定投买入：${item}` : item,
    );
  }
  const stanceClass =
    sell?.shares > 0 && active.stance !== STANCE.INVEST
      ? "is-sell"
      : active.stance === STANCE.INVEST
        ? "is-invest"
        : active.stance === STANCE.NEED_BUDGET
          ? "is-need-budget"
          : "is-skip";
  const headline = conclusionHeadline(active, context);

  return `
    <section class="panel-block dividend-advice dividend-conclusion-card ${tone} ${stanceClass}" aria-label="本期结论">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">本期结论</h2>
        </div>
      </div>
      <p class="dividend-advice-headline">${escapeHtml(headline)}</p>
      ${sellAdviceHtml(sell)}
      ${reasonChainHtml({
        strategyName: active.strategyName,
        peText,
        mult: active.mult,
        multBreakdown,
      })}
      <ul class="dividend-advice-list">
        ${listBullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
      ${executionPanelHtml(active, context)}
    </section>
  `;
}

function holdingsPanel(symbol, price, advice, context) {
  const entry = state.etfs.find((item) => item.symbol === symbol);
  if (!entry || !(entry.shares > 0)) {
    return `
      <div class="dividend-holdings empty">
        <p class="muted">计划内暂无持仓份额。</p>
      </div>
    `;
  }
  const cost = entry.cost > 0 ? entry.cost : null;
  const value = price != null ? price * entry.shares : null;
  const costValue = cost != null ? cost * entry.shares : null;
  const pnl = value != null && costValue != null ? value - costValue : null;
  const pnlPct = pnl != null && costValue ? (pnl / costValue) * 100 : null;
  const position = advice?.position || {};
  const glance = positionGlance({
    targetWeight: position.targetWeight,
    actualWeight: position.actualWeight,
    drift: position.drift,
  });
  const rows = [
    ["仓位", glance.primaryHtml || glance.primary],
    ["份额", entry.shares.toLocaleString("zh-CN")],
    ["成本", cost != null ? cost.toFixed(3) : "—"],
    ["现价", price != null ? Number(price).toFixed(3) : "—"],
    ["市值", value != null ? money(value) : "—"],
    ["浮盈亏", pnl != null ? `${money(pnl)}（${signed(pnlPct, 1)}%）` : "—"],
  ];
  return `
    <div class="dividend-holdings">
      <dl class="dividend-holdings-grid">
        ${rows
          .map(
            ([label, valueText]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd class="${label === "浮盈亏" && pnl != null ? (pnl > 0 ? "up" : pnl < 0 ? "down" : "") : ""}">${valueText}</dd>
          </div>
        `,
          )
          .join("")}
      </dl>
    </div>
  `;
}

function holdingsCardHtml(advice, context) {
  const payload = currentPayload() || {};
  const price = payload.etf?.price != null ? payload.etf.price : payload.index?.close;
  const symbol = state.analysisSymbol || payload.symbol || payload.etf?.symbol || "";
  const active = advice || currentPeriodAdvice();

  return `
    <section class="panel-block dividend-holdings-card" aria-label="持仓对照">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">持仓对照</h2>
        </div>
      </div>
      ${holdingsPanel(symbol, price, active, context)}
    </section>
  `;
}

function optionalMetric(value, formatter) {
  return value == null || value === "" ? '<span class="decision-missing">暂无可靠数据</span>' : formatter(value);
}

function vehicleQualityHtml(context) {
  const payload = currentPayload() || {};
  const etf = payload.etf || {};
  const metadata = {
    ...(etf.product_quality || {}),
    ...(appConfig?.etf?.products?.[context.symbol] || {}),
  };
  const volume = etf.volume != null
    ? Number(etf.volume).toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : null;
  const rows = [
    ["当日成交量", optionalMetric(volume, (value) => `${value}（行情源口径）`)],
    ["基金规模", optionalMetric(metadata.fund_size_yi, (value) => `${fmt(value, 2)} 亿元`)],
    ["综合费率", optionalMetric(metadata.annual_fee_pct, (value) => `${fmt(value, 2)}% / 年`)],
    ["跟踪误差", optionalMetric(metadata.tracking_error_pct, (value) => `${fmt(value, 2)}%`)],
    ["溢价 / 折价", optionalMetric(metadata.premium_discount_pct, (value) => `${fmtSigned(value, 2, "%")}`)],
    ["买卖价差", optionalMetric(metadata.bid_ask_spread_pct, (value) => `${fmt(value, 3)}%`)],
  ];
  return `
    <section class="panel-block decision-detail-card decision-secondary" aria-label="ETF 交易质量">
      <div class="panel-heading"><div><h2 class="section-title">ETF 交易质量</h2></div></div>
      <dl class="decision-quality-grid">
        ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
    </section>
  `;
}

function riskAndConfidenceHtml(context) {
  const payload = currentPayload() || {};
  const risk = context.risk;
  const correlation = context.strongestCorrelation;
  const technicalFramework =
    payload.score?.framework === "technical" ||
    payload.asset_class === "commodity" ||
    payload.asset_class === "bond";
  const naKeys = new Set(Object.keys(payload.not_applicable || {}));
  if (technicalFramework) {
    naKeys.add("valuation");
    naKeys.add("bond");
    naKeys.add("index_pe");
  }
  const errorCount = Object.keys(payload.errors || {}).filter((key) => !naKeys.has(key)).length;
  const dataDate = String(payload.index?.date || "").slice(0, 10);
  const dataTime = dataDate ? new Date(`${dataDate}T00:00:00`).getTime() : Number.NaN;
  const stale = Number.isFinite(dataTime) && Date.now() - dataTime > 5 * 86_400_000;
  const confidenceLabel = stale
    ? "数据已陈旧"
    : errorCount
      ? `${errorCount} 项降级`
      : "";
  const analysisMode = payload.analysis_mode === "etf_proxy" ? "ETF 行情代理" : "完整指数映射";
  const frameworkNote = technicalFramework ? " · 估值框架不适用" : "";
  const rows = [
    ["年化波动", risk ? `${fmt(risk.annualizedVolatilityPct, 1)}%` : "—"],
    ["最大回撤", risk ? `${fmtSigned(risk.maxDrawdownPct, 1, "%")}` : "—"],
    ["最长水下期", risk ? `${risk.longestUnderwaterDays} 个交易日` : "—"],
    ["年化收益", risk ? `${fmtSigned(risk.annualizedReturnPct, 1, "%")}` : "—"],
    [
      "最高相关",
      correlation
        ? `${escapeHtml(correlation.name)} · ${fmt(correlation.correlation.value, 2)}`
        : "需先分析池内其他 ETF",
    ],
    ["历史样本", risk ? `${risk.samples} 个交易日` : "不足"],
  ];
  return `
    <section class="panel-block decision-detail-card decision-secondary" aria-label="风险与数据可信度">
      <div class="panel-heading">
        <div><h2 class="section-title">风险与数据可信度</h2></div>
        ${
          confidenceLabel
            ? `<span class="decision-confidence is-degraded">${confidenceLabel}</span>`
            : ""
        }
      </div>
      <dl class="decision-quality-grid">
        ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
      <p class="muted decision-card-note">${escapeHtml(analysisMode)}${frameworkNote} · 行情 ${escapeHtml(payload.etf?.as_of || payload.updated_at || "时间未知")} · 指数 ${escapeHtml(payload.index?.date || "日期未知")}</p>
    </section>
  `;
}

function sourcesHtml() {
  const sources = (currentPayload() || {}).sources || [];
  return sources
    .map(
      (source) =>
        `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.name)}</a> · ${escapeHtml(source.role)}</li>`,
    )
    .join("");
}

function errorsHtml() {
  const payload = currentPayload() || {};
  const technicalFramework =
    payload.score?.framework === "technical" ||
    payload.asset_class === "commodity" ||
    payload.asset_class === "bond";
  const naMap = { ...(payload.not_applicable || {}) };
  const errors = { ...(payload.errors || {}) };
  if (technicalFramework) {
    for (const key of ["valuation", "bond", "index_pe"]) {
      if (errors[key] && !naMap[key]) naMap[key] = errors[key];
      delete errors[key];
    }
  }
  const naEntries = Object.values(naMap);
  const errorEntries = Object.values(errors);
  const parts = [];
  if (naEntries.length) {
    parts.push(
      `<p class="dividend-framework-note muted">${naEntries
        .map((entry) => escapeHtml(entry))
        .join("；")}</p>`,
    );
  }
  if (errorEntries.length) {
    parts.push(
      `<p class="dividend-degraded muted">${errorEntries
        .map((entry) => escapeHtml(entry))
        .join("；")}</p>`,
    );
  }
  return parts.join("");
}

function buildIndexChartMarkers(payload) {
  const markers = [];
  const markerValues = payload?.chart?.markers || {};
  if (markerValues.ma250 != null) markers.push({ key: "ma250", label: "年线 MA250", value: markerValues.ma250 });
  if (markerValues.boll_mid != null) markers.push({ key: "bollMid", label: "布林中轨", value: markerValues.boll_mid });
  if (markerValues.boll_upper != null) markers.push({ key: "tp", label: "布林上轨", value: markerValues.boll_upper });
  if (markerValues.boll_lower != null) markers.push({ key: "sl", label: "布林下轨", value: markerValues.boll_lower });
  const symbol = state.analysisSymbol || payload?.symbol || "";
  markers.push(
    ...buyEventMarkers(
      (state.buys || []).filter((item) => item.symbol === symbol),
      { useBuyPrice: false },
    ),
    ...sellEventMarkers(
      (state.sells || []).filter((item) => item.symbol === symbol),
      { useSellPrice: false },
    ),
  );
  return markers;
}

function chartNarrativeHtml(payload) {
  // ETF 走势解读：与上方图表同口径（chart.points / markers）
  const rangeKey = state.indexChartRange || "1y";
  const points = sliceIndexChartPoints(payload?.chart?.points || [], rangeKey);
  const lines = buildChartNarrative({
    points,
    markers: payload?.chart?.markers || {},
    price: payload?.etf?.price != null ? payload.etf.price : null,
    rangeKey,
    priceBasis: payload?.chart?.price_basis === "index" ? "index" : "etf",
  });
  if (!lines.length) return '<p class="muted chart-narrative-empty">历史数据不足，暂无法解读走势。</p>';
  return `<ul class="chart-narrative">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function commentaryHtml() {
  const raw = (currentPayload() || {}).commentary || [];
  const lines = Array.isArray(raw) ? raw.filter(Boolean) : [];
  if (!lines.length) return '<p class="muted">暂无盘面点评。</p>';
  return `<ol class="dividend-commentary">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ol>`;
}

function paintDividend() {
  if (!els.dividendContent) return;
  const payload = currentPayload();
  if (!payload) return;

  if (payload.supported === false) {
    els.dividendContent.hidden = false;
    els.dividendContent.innerHTML = `
      <div class="empty-state analysis-unsupported">
        <h3 class="section-title">${escapeHtml(payload.name || payload.symbol || state.analysisSymbol || "该 ETF")}</h3>
        <p>${escapeHtml(payload.error || "暂不支持完整估值分析")}</p>
        <p class="muted">${escapeHtml(payload.reason || "缺少指数/估值映射。")}</p>
      </div>
    `;
    return;
  }

  if (payload.error && !payload.score) {
    els.dividendContent.hidden = false;
    els.dividendContent.innerHTML = `<div class="empty-state">分析数据加载失败：${escapeHtml(payload.error)}<br />请确认本机可以访问中证指数官网 / 蛋卷基金 / 东方财富，然后点「刷新」。</div>`;
    return;
  }

  els.dividendContent.hidden = false;
  const advice = currentPeriodAdvice();
  const context = decisionContext(advice);
  const addPlanEntry = state.etfs.find((item) => item.symbol === context.symbol);
  const addPlanPrice = payload.etf?.price != null ? payload.etf.price : payload.index?.close;
  // 有可用档位才渲染；放在持仓对照同列底部，与本期结论底端对齐
  const addPlan = addPlanHtml(
    addPlanEntry,
    addPlanPrice,
    {
      ...advice,
      amount: context.cycle.remainingAmount,
    },
    payload,
  );
  els.dividendContent.innerHTML = `
    ${errorsHtml()}
    <div class="dividend-hero">
      ${dcaAdviceHtml(advice, context)}
      <div class="dividend-hero-aside-stack">
        ${holdingsCardHtml(advice, context)}
        ${addPlan}
      </div>
      ${scoreCardHtml()}
      ${metricsCardHtml()}
    </div>
    <div class="decision-detail-grid">
      ${vehicleQualityHtml(context)}
      ${riskAndConfidenceHtml(context)}
    </div>
    <section class="panel-block dividend-chart-block">
      <div class="panel-heading">
        <h2 class="section-title">ETF 走势</h2>
        <div class="range-segment" role="group" aria-label="ETF 走势区间">
          ${Object.entries(INDEX_CHART_RANGE_LABELS)
            .map(
              ([key, label]) => `
            <button class="segment-button js-index-range${state.indexChartRange === key ? " active" : ""}" data-index-range="${key}" type="button">${label}</button>
          `,
            )
            .join("")}
        </div>
      </div>
      <div class="price-chart-shell">
        <canvas id="dividendChart" width="960" height="360" aria-label="ETF 价格走势"></canvas>
        <div class="price-tooltip" id="dividendChartTooltip" hidden></div>
      </div>
      <div class="chart-narrative-block">
        <div id="dividendChartNarrative" aria-label="ETF 走势解读">${chartNarrativeHtml(payload)}</div>
      </div>
    </section>
    <section class="panel-block">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">今日盘面</h2>
        </div>
      </div>
      ${commentaryHtml()}
    </section>
    ${aiReviewHtml(advice, context)}
    <section class="panel-block dividend-sources decision-secondary">
      <div class="panel-heading">
        <div>
          <h2 class="section-title">数据来源</h2>
        </div>
      </div>
      <ul>${sourcesHtml()}</ul>
    </section>
  `;

  const canvas = els.dividendContent.querySelector("#dividendChart");
  const tooltip = els.dividendContent.querySelector("#dividendChartTooltip");
  drawIndexChart(payload, canvas, tooltip, buildIndexChartMarkers(payload));
  bindIndexChartRangeControls();
}

function sliceIndexChartPoints(points, rangeKey) {
  if (!Array.isArray(points) || !points.length) return [];
  const window = INDEX_CHART_RANGE_WINDOWS[rangeKey];
  if (window == null) return points;
  const lastDate = points[points.length - 1]?.date;
  if (!lastDate) return points;
  const end = new Date(`${lastDate}T00:00:00`);
  if (Number.isNaN(end.getTime())) return points;
  const start = new Date(end);
  if (window.days) start.setDate(start.getDate() - window.days);
  if (window.months) start.setMonth(start.getMonth() - window.months);
  const startStr = start.toISOString().slice(0, 10);
  const sliced = points.filter((point) => point.date >= startStr);
  return sliced.length ? sliced : points;
}

function drawIndexChart(payload, canvas, tooltip, markers) {
  if (!canvas) return;
  const allPoints = payload?.chart?.points || [];
  const points = sliceIndexChartPoints(allPoints, state.indexChartRange || "1y");
  drawPriceChart(canvas, tooltip, points, markers || [], "CNY", null, state.indexChartRange);
}

function bindIndexChartRangeControls() {
  if (!els.dividendContent || indexChartBound) return;
  indexChartBound = true;
  els.dividendContent.addEventListener("click", (event) => {
    const forceBuy = event.target.closest?.("[data-force-inefficient]");
    if (forceBuy && els.dividendContent.contains(forceBuy)) {
      forceInefficientBySymbol.add(forceBuy.dataset.forceInefficient);
      paintDividend();
      return;
    }
    const clearForce = event.target.closest?.("[data-clear-force-inefficient]");
    if (clearForce && els.dividendContent.contains(clearForce)) {
      forceInefficientBySymbol.delete(clearForce.dataset.clearForceInefficient);
      paintDividend();
      return;
    }
    const aiButton = event.target.closest?.("[data-ai-review]");
    if (aiButton && els.dividendContent.contains(aiButton)) {
      requestAIReview({ force: aiButton.dataset.force === "true" });
      return;
    }
    const openSettings = event.target.closest?.("[data-open-settings]");
    if (openSettings && els.dividendContent.contains(openSettings)) {
      callRenderer("switchView", "settings");
      return;
    }
    const choiceButton = event.target.closest?.("[data-ai-choice]");
    if (choiceButton && els.dividendContent.contains(choiceButton)) {
      const symbol = state.analysisSymbol || currentPayload()?.symbol || "";
      if (state.aiReviews[symbol]) {
        state.aiReviews[symbol].selection = choiceButton.dataset.aiChoice;
        paintDividend();
      }
      return;
    }
    const button = event.target.closest?.("[data-index-range]");
    if (!button || !els.dividendContent.contains(button)) return;
    const next = button.dataset.indexRange;
    if (!next || next === state.indexChartRange) return;
    state.indexChartRange = next;
    els.dividendContent.querySelectorAll("[data-index-range]").forEach((node) => {
      node.classList.toggle("active", node.dataset.indexRange === next);
    });
    const payload = currentPayload();
    if (!payload) return;
    const canvas = els.dividendContent.querySelector("#dividendChart");
    const tooltip = els.dividendContent.querySelector("#dividendChartTooltip");
    drawIndexChart(payload, canvas, tooltip, buildIndexChartMarkers(payload));
    const narrative = els.dividendContent.querySelector("#dividendChartNarrative");
    if (narrative) narrative.innerHTML = chartNarrativeHtml(payload);
  });
}

registerRenderers({ renderDividend, openAnalysis });
