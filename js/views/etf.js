import { ETF_QUOTE_TTL_MS, DEFAULT_TARGET_WEIGHTS, analysisIsFullIndex } from "../constants.js";
import { appConfig, els, state, workspaceRuntime } from "../state.js";
import {
  escapeAttr,
  escapeHtml,
  etfShortLabel,
  money,
  normalizeEtfSymbol,
  resolveEtfDisplayName,
  signed,
} from "../utils.js";
import { drawPriceChart, buyEventMarkers, sellEventMarkers } from "../chart.js";
import { setSourceStatus } from "../navigation.js";
import { persistWorkspace } from "../workspace.js";
import { currentPoolAllocationResult } from "../pool-alloc.js";
import {
  buildPortfolioReviewBaseline,
  isPortfolioAiReady,
  portfolioReviewResultHtml,
} from "../ai-portfolio.js";
import { ensurePoolAnalysisPrefetch } from "../analysis-cache.js";
import {
  appendDecisionHistory,
  executionDraftSummary,
  reevaluatePeriodStrategy,
  settleCashReserveOnPeriodComplete,
  syncExecutionDraftsFromAllocation,
  updateExecutionDraft,
} from "../execution-drafts.js";
import {
  canSubmitWithOverride,
  evaluateExecutionPolicy,
  parseQuoteTimestampMs,
  policyStatusLabel,
} from "../execution-policy.js";
import {
  normalizeTradingCost,
  upsertBuy,
  upsertSell,
} from "../workspace_model.js";
import { ADD_PLAN_PRESETS, normalizeAddPlanConfig } from "../add-plan.js";
import {
  estimatedTradeFee,
  holdingFromTrades,
  planExecutionContext,
  stampInitialBuildStarted,
} from "../decision-support.js";
import { confirmDraftIntoLedger, settlePlanAfterDrafts } from "../trade-apply.js";
import { callRenderer, openAnalysis, registerRenderers } from "./render.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  normalizeStrategyConfig,
  normalizeStrategyId,
  STRATEGY_PRESETS,
  strategySummary,
} from "../strategy.js";
import { entryMetrics, overviewGlanceLine, portfolioReturnsByIndex, portfolioTotals } from "../etf-portfolio.js";
import {
  HOME_EQUITY_PERIODS,
  buildDailyEquityCurve,
  equityDataFingerprint,
  prepareEquityChartPoints,
  symbolsForEquityCurve,
} from "../portfolio-equity.js";

const ROW_STRATEGY_OPTIONS = Object.freeze([
  { value: "", label: "跟随全局" },
  { value: "fixed", label: STRATEGY_PRESETS.fixed.label },
  { value: "valuation", label: STRATEGY_PRESETS.valuation.label },
  { value: "grade", label: STRATEGY_PRESETS.grade.label },
  { value: "rebalance", label: STRATEGY_PRESETS.rebalance.label },
  { value: "custom", label: STRATEGY_PRESETS.custom.label },
]);

let quotesPromise = null;
let editingTrade = null;
let confirmingDraftId = null;

function poolSymbols() {
  return state.etfs.map((item) => item.symbol);
}

function clampWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(100, Math.round(number * 100) / 100);
}

function registryEtfName(symbol) {
  return (
    appConfig?.etf?.analysis_registry?.[symbol]?.etf_name ||
    appConfig?.etf?.analysis_support?.[symbol]?.etf_name ||
    ""
  );
}

function seedEtfName(symbol) {
  const pool = appConfig?.etf?.pool || [];
  const hit = pool.find((item) => item.symbol === symbol);
  return hit?.name || "";
}

function etfDisplayName(entry, quote) {
  return resolveEtfDisplayName({
    name: entry?.name,
    symbol: entry?.symbol,
    quoteName: quote?.name,
    registryName: registryEtfName(entry?.symbol),
    seedName: seedEtfName(entry?.symbol),
  });
}

/** 导入 config 默认种子池（均衡目标权重）。 */
export function importSeedPool() {
  const pool = appConfig?.etf?.pool || [];
  if (!pool.length) {
    if (els.etfFormStatus) els.etfFormStatus.textContent = "配置中无默认种子池";
    return;
  }
  const toEntry = (item) => {
    const symbol = String(item.symbol || "");
    if (!/^\d{6}$/.test(symbol)) return null;
    return {
      symbol,
      name: String(item.name || ""),
      shares: 0,
      cost: 0,
      target_weight: clampWeight(DEFAULT_TARGET_WEIGHTS[symbol] || 0),
      note: "",
    };
  };
  if (!state.etfs.length) {
    state.etfs = pool.map(toEntry).filter(Boolean);
  } else {
    const existing = new Set(state.etfs.map((item) => item.symbol));
    let added = 0;
    pool.forEach((item) => {
      const entry = toEntry(item);
      if (!entry || existing.has(entry.symbol)) return;
      state.etfs.push(entry);
      existing.add(entry.symbol);
      added += 1;
    });
    if (!added) {
      if (els.etfFormStatus) els.etfFormStatus.textContent = "种子池品种已在计划中";
      return;
    }
  }
  persistWorkspace();
  if (els.etfFormStatus) els.etfFormStatus.textContent = `已导入种子池 ${state.etfs.length} 只`;
  renderEtfPool({ refresh: true });
}

function moveEtfRelative(fromSymbol, toSymbol, placeAfter = false) {
  if (!fromSymbol || !toSymbol || fromSymbol === toSymbol) return false;
  const from = state.etfs.findIndex((item) => item.symbol === fromSymbol);
  if (from < 0) return false;
  const [item] = state.etfs.splice(from, 1);
  let to = state.etfs.findIndex((entry) => entry.symbol === toSymbol);
  if (to < 0) {
    state.etfs.push(item);
    return true;
  }
  if (placeAfter) to += 1;
  state.etfs.splice(to, 0, item);
  return true;
}

function commitEtfOrder() {
  persistWorkspace();
  renderMetrics();
  renderRows();
  renderSidebarEtfs();
}

const dragBound = new WeakSet();

function bindDragReorder(container, { itemSelector, handleSelector = null } = {}) {
  if (!container || dragBound.has(container)) return;
  dragBound.add(container);
  let dragSymbol = null;
  let suppressClick = false;

  container.addEventListener("dragstart", (event) => {
    const handle = handleSelector ? event.target.closest(handleSelector) : event.target.closest(itemSelector);
    if (!handle || !container.contains(handle)) return;
    const item = event.target.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    dragSymbol = item.dataset.symbol;
    if (!dragSymbol) return;
    suppressClick = false;
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragSymbol);
  });

  container.addEventListener("dragover", (event) => {
    const item = event.target.closest(itemSelector);
    if (!item || !dragSymbol || item.dataset.symbol === dragSymbol) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = item.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    container.querySelectorAll(".drag-over, .drag-over-after").forEach((node) => {
      if (node !== item) node.classList.remove("drag-over", "drag-over-after");
    });
    item.classList.toggle("drag-over", !after);
    item.classList.toggle("drag-over-after", after);
  });

  container.addEventListener("dragleave", (event) => {
    const item = event.target.closest(itemSelector);
    if (item && !item.contains(event.relatedTarget)) {
      item.classList.remove("drag-over", "drag-over-after");
    }
  });

  container.addEventListener("drop", (event) => {
    const item = event.target.closest(itemSelector);
    if (!item || !dragSymbol) return;
    event.preventDefault();
    const toSymbol = item.dataset.symbol;
    const rect = item.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    item.classList.remove("drag-over", "drag-over-after");
    if (moveEtfRelative(dragSymbol, toSymbol, placeAfter)) {
      suppressClick = true;
      commitEtfOrder();
    }
  });

  container.addEventListener("dragend", () => {
    container.querySelectorAll(".is-dragging, .drag-over, .drag-over-after").forEach((node) => {
      node.classList.remove("is-dragging", "drag-over", "drag-over-after");
    });
    dragSymbol = null;
  });

  container.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    },
    true,
  );
}

async function refreshQuotes(force = false) {
  const symbols = poolSymbols();
  if (!symbols.length) return;
  const fresh = Date.now() - state.quotesFetchedAt < ETF_QUOTE_TTL_MS;
  if (!force && fresh && Object.keys(state.quotesBySymbol).length) return;
  if (quotesPromise) return quotesPromise;
  quotesPromise = (async () => {
    const publishStatus = () => state.activeView !== "dividend";
    try {
      if (publishStatus()) setSourceStatus("加载行情…", "connecting");
      const response = await fetch(`/api/etf/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
      const payload = await response.json();
      state.quotesMeta = payload;
      if (!payload.error) {
        const map = {};
        (payload.quotes || []).forEach((quote) => {
          map[quote.symbol] = quote;
        });
        state.quotesBySymbol = map;
        state.quotesFetchedAt = Date.now();
        // 用友好名 / 行情名补全或升级池中名称（避免行情短名覆盖 registry 全称）
        let renamed = false;
        state.etfs.forEach((entry) => {
          const next = resolveEtfDisplayName({
            name: entry.name,
            symbol: entry.symbol,
            quoteName: map[entry.symbol]?.name,
            registryName: registryEtfName(entry.symbol),
            seedName: seedEtfName(entry.symbol),
          });
          if (next && next !== entry.name) {
            entry.name = next;
            renamed = true;
          }
        });
        if (renamed) persistWorkspace();
      }
      if (publishStatus()) {
        setSourceStatus(
          payload.error
            ? `行情不可用：${payload.error}`
            : `行情拉取于 ${payload.updated_at || "—"}${payload.warning ? ` · ${payload.warning}` : ""}`,
          payload.error ? "error" : "connected",
        );
      }
    } catch (error) {
      if (publishStatus()) setSourceStatus(`行情不可用：${error}`, "error");
    } finally {
      quotesPromise = null;
    }
  })();
  return quotesPromise;
}

function holdingInputValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : "0";
}

function syncSentimentForm(config) {
  const cfg = normalizeStrategyConfig(config);
  if (els.planSentimentEnabled) els.planSentimentEnabled.checked = cfg.sentiment.enabled !== false;
  if (els.planSentimentHint) {
    const items = state.marketSentiment?.items || {};
    const parts = ["A", "HK", "US"]
      .map((market) => {
        const snap = items[market];
        if (!snap || snap.score == null) return null;
        return `${market} ${snap.score}`;
      })
      .filter(Boolean);
    els.planSentimentHint.textContent = parts.length
      ? `当前温度 ${parts.join(" · ")}（宽基 ETF 真实收盘价；仅极端区调节）`
      : state.marketSentimentError
        ? `情绪暂不可用 · ${state.marketSentimentError}`
        : "A500 / 纳指 / 恒生科技 ETF 收盘价衍生波动与回撤温度";
  }
}

function syncCustomStrategyForm(config) {
  const cfg = normalizeStrategyConfig(config);
  if (els.planUseRebalance) els.planUseRebalance.checked = cfg.use_rebalance !== false;
  if (els.planPeBands) {
    els.planPeBands.innerHTML = `
      <div class="plan-pe-head"><span>上限 %</span><span>倍率</span><span>名称</span></div>
      ${cfg.pe_bands
        .map(
          (band, index) => `
        <div class="plan-pe-row" data-band-index="${index}">
          <input class="js-pe-max" type="number" min="1" max="100" step="1" value="${band.max_pct}" ${
            index === cfg.pe_bands.length - 1 ? "readonly" : ""
          } aria-label="区间上限百分比" />
          <input class="js-pe-mult" type="number" min="0" max="5" step="0.1" value="${band.mult}" aria-label="定投倍率" />
          <input class="js-pe-label" type="text" maxlength="12" value="${escapeAttr(band.label)}" aria-label="区间名称" />
        </div>`,
        )
        .join("")}
    `;
  }
  if (els.planGradeMult) {
    els.planGradeMult.innerHTML = ["A", "B", "C", "D", "E"]
      .map(
        (grade) => `
        <label>
          <span>评分 ${grade}</span>
          <input class="js-grade-mult" data-grade="${grade}" type="number" min="0" max="5" step="0.1" value="${cfg.grade_mult[grade]}" />
        </label>`,
      )
      .join("");
  }
}

function syncAddPlanForm(config) {
  const cfg = normalizeAddPlanConfig(config);
  if (els.planAddPlanEnabled) els.planAddPlanEnabled.checked = cfg.enabled !== false;
  if (els.planAddPlanAnchor) els.planAddPlanAnchor.value = cfg.anchor === "cost" ? "cost" : "price";
  if (els.planAddPlanPreset) {
    // 自定义仅为旧配置兼容项：有已保存档位时才可见
    const customOption = els.planAddPlanPreset.querySelector('option[value="custom"]');
    if (customOption) customOption.hidden = cfg.preset !== "custom";
    els.planAddPlanPreset.value = cfg.preset;
  }
  const showingLevels = renderAddPlanLevelPreview(cfg);
  if (els.planAddPlanPresetHint) {
    // 档位表已展示数值时，说明只补非数字信息，避免复述
    if (showingLevels) {
      els.planAddPlanPresetHint.textContent =
        cfg.preset === "steady"
          ? "不随估值缩放"
          : cfg.preset === "deep"
            ? "只接较深回调"
            : cfg.preset === "custom"
              ? "沿用已保存档位"
              : "";
    } else {
      els.planAddPlanPresetHint.textContent = ADD_PLAN_PRESETS[cfg.preset]?.summary || "";
    }
  }
}

/** 固定/自定义预设时展示只读档位表；智能推荐仅用下方说明。返回是否已展示表格。 */
function renderAddPlanLevelPreview(cfg) {
  const el = els.planAddPlanLevels;
  if (!el) return false;
  let levels = null;
  if (cfg.preset === "steady" || cfg.preset === "deep") {
    levels = ADD_PLAN_PRESETS[cfg.preset]?.levels || null;
  } else if (cfg.preset === "custom" && Array.isArray(cfg.levels) && cfg.levels.length) {
    levels = cfg.levels;
  }
  if (!levels?.length) {
    el.hidden = true;
    el.innerHTML = "";
    return false;
  }
  el.hidden = false;
  el.innerHTML = `
    <div class="plan-add-plan-head"><span></span><span>跌幅 %</span><span>比例 %</span></div>
    ${levels
      .map((level, i) => {
        const drawdown = Number(level.drawdown_pct);
        const ratioPct = Math.round(Number(level.ratio) * 1000) / 10;
        return `
      <div class="plan-add-plan-row" data-level-index="${i}">
        <span class="plan-add-plan-row-label">第${i + 1}档</span>
        <span class="plan-add-plan-cell">${Number.isFinite(drawdown) ? drawdown : "—"}</span>
        <span class="plan-add-plan-cell">${Number.isFinite(ratioPct) ? ratioPct : "—"}</span>
      </div>`;
      })
      .join("")}
  `;
  return true;
}

function readAddPlanConfigFromForm() {
  const preset = els.planAddPlanPreset?.value || "auto";
  return normalizeAddPlanConfig({
    enabled: els.planAddPlanEnabled?.checked !== false,
    anchor: els.planAddPlanAnchor?.value === "cost" ? "cost" : "price",
    preset,
    // 自定义预设沿用已保存档位；其余预设的档位由 add-plan 模块给出
    levels: preset === "custom" ? state.plan?.add_plan?.levels || null : null,
  });
}

function readSentimentEnabledFromForm(previousConfig) {
  const previous = normalizeStrategyConfig(previousConfig);
  return {
    ...previous.sentiment,
    enabled: els.planSentimentEnabled ? els.planSentimentEnabled.checked !== false : previous.sentiment.enabled,
  };
}

function readCustomStrategyConfigFromForm() {
  const pe_bands = [];
  els.planPeBands?.querySelectorAll(".plan-pe-row").forEach((row) => {
    pe_bands.push({
      max_pct: Number(row.querySelector(".js-pe-max")?.value),
      mult: Number(row.querySelector(".js-pe-mult")?.value),
      label: String(row.querySelector(".js-pe-label")?.value || "").trim(),
    });
  });
  const grade_mult = {};
  els.planGradeMult?.querySelectorAll(".js-grade-mult").forEach((input) => {
    grade_mult[input.dataset.grade] = Number(input.value);
  });
  return normalizeStrategyConfig({
    pe_bands: pe_bands.length ? pe_bands : DEFAULT_STRATEGY_CONFIG.pe_bands,
    grade_mult: Object.keys(grade_mult).length ? grade_mult : DEFAULT_STRATEGY_CONFIG.grade_mult,
    use_rebalance: els.planUseRebalance?.checked !== false,
    sentiment: readSentimentEnabledFromForm(state.plan?.strategy_config),
  });
}

function syncPlanForm() {
  const plan = state.plan || {};
  const tradingCost = normalizeTradingCost(plan.trading_cost);
  if (els.planName) els.planName.value = plan.name || "";
  if (els.planAmount) els.planAmount.value = plan.amount > 0 ? plan.amount : "";
  if (els.planCapitalBase) els.planCapitalBase.value = plan.capital_base > 0 ? plan.capital_base : "";
  if (els.planInitialTargetPct) {
    els.planInitialTargetPct.value = plan.initial_target_pct > 0 ? plan.initial_target_pct : "";
  }
  if (els.planInitialMonths) {
    const months = Number.parseInt(plan.initial_months, 10);
    els.planInitialMonths.value = Number.isFinite(months) && months > 0 ? months : 1;
  }
  if (els.planInitialCompleted) els.planInitialCompleted.checked = Boolean(plan.initial_build_completed_at);
  if (els.planMinCommission) els.planMinCommission.value = tradingCost.min_commission;
  if (els.planCommissionRatePct) els.planCommissionRatePct.value = tradingCost.commission_rate_pct;
  if (els.planMaxFeeRatioPct) els.planMaxFeeRatioPct.value = tradingCost.max_fee_ratio_pct;
  if (els.planLotSize) els.planLotSize.value = tradingCost.lot_size;
  if (els.planCadence) els.planCadence.value = plan.cadence || "monthly";
  if (els.planDay) {
    els.planDay.value = plan.day || 1;
    els.planDay.max = plan.cadence === "monthly" ? "28" : "7";
  }
  if (els.planNote) els.planNote.value = plan.note || "";
  if (els.planDayHint) {
    els.planDayHint.textContent = plan.cadence === "monthly" ? "执行日（号）" : "执行日（周几 1–7）";
  }
  const strategy = normalizeStrategyId(plan.strategy);
  if (els.planStrategy) els.planStrategy.value = strategy;
  if (els.planStrategyHint) els.planStrategyHint.textContent = strategySummary(strategy);
  if (els.planStrategyCustom) els.planStrategyCustom.hidden = strategy !== "custom";
  syncSentimentForm(plan.strategy_config);
  syncCustomStrategyForm(plan.strategy_config);
  syncAddPlanForm(plan.add_plan);
  renderInitialSummary();
  workspaceRuntime.planFormReady = true;
}

function currentPlanHoldings() {
  return state.etfs.map((entry) => {
    const price = Number(state.quotesBySymbol[entry.symbol]?.price);
    const shares = Math.max(0, Number(entry.shares) || 0);
    return {
      marketValue: price > 0 ? price * shares : 0,
    };
  });
}

function renderInitialSummary() {
  if (!els.planInitialSummary) return;
  const execution = planExecutionContext({ plan: state.plan, holdings: currentPlanHoldings() });
  if (!execution.configured) {
    els.planInitialSummary.hidden = true;
    els.planInitialSummary.innerHTML = "";
    return;
  }
  if (execution.markedComplete || execution.reached) {
    els.planInitialSummary.hidden = false;
    els.planInitialSummary.innerHTML = `<p class="muted plan-initial-progress-note">目标 ${money(
      execution.targetAmount,
    )} · 当前 ${money(execution.currentValue)} · 已完成</p>`;
    return;
  }
  const target = Math.max(0, Number(execution.targetAmount) || 0);
  const current = Math.max(0, Number(execution.currentValue) || 0);
  const gap = Math.max(0, Number(execution.initialGap) || 0);
  const installment = Math.max(0, Number(execution.periodInstallment) || 0);
  const monthsLeft = Math.max(1, Number(execution.remainingMonths) || 1);
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 1000) / 10) : 0;
  const pctLabel = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  els.planInitialSummary.hidden = false;
  els.planInitialSummary.innerHTML = `
    <div
      class="plan-initial-progress-bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${pct}"
      aria-label="初期建仓进度 ${pctLabel}%"
    >
      <div class="plan-initial-progress-meta">
        <span>${escapeHtml(execution.phaseLabel)} ${pctLabel}%</span>
        <span>已建 ${money(current)} / 目标 ${money(target)}</span>
      </div>
      <div class="plan-initial-progress-track">
        <div class="plan-initial-progress-fill" style="width:${pct}%"></div>
      </div>
      <p class="muted plan-initial-progress-note">
        尚缺 ${money(gap)} · 剩余 ${monthsLeft} 个月 · 本期预算按尚缺÷剩余月数 ≈ ${money(installment)}
      </p>
    </div>
  `;
}

export function readPlanFormIntoState() {
  if (!state.plan) state.plan = {};
  const cadence = els.planCadence?.value || "monthly";
  let day = Number.parseInt(els.planDay?.value, 10);
  if (!Number.isFinite(day)) day = 1;
  if (cadence === "monthly") day = Math.min(28, Math.max(1, day));
  else day = Math.min(7, Math.max(1, day));
  const amount = Number(els.planAmount?.value);
  const capitalBase = Number(els.planCapitalBase?.value);
  const initialTargetPct = Number(els.planInitialTargetPct?.value);
  let initialMonths = Number.parseInt(els.planInitialMonths?.value, 10);
  if (!Number.isFinite(initialMonths) || initialMonths < 1) initialMonths = 1;
  initialMonths = Math.min(36, initialMonths);
  const strategy = normalizeStrategyId(els.planStrategy?.value);
  const previousConfig = state.plan.strategy_config;
  const strategy_config =
    strategy === "custom"
      ? readCustomStrategyConfigFromForm()
      : normalizeStrategyConfig({
          ...normalizeStrategyConfig(previousConfig),
          sentiment: readSentimentEnabledFromForm(previousConfig),
        });
  state.plan = {
    name: String(els.planName?.value || "").trim() || "默认定投计划",
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    capital_base: Number.isFinite(capitalBase) && capitalBase > 0 ? capitalBase : 0,
    initial_target_pct:
      Number.isFinite(initialTargetPct) && initialTargetPct > 0
        ? Math.min(100, initialTargetPct)
        : 0,
    initial_months: initialMonths,
    initial_build_started_at: state.plan.initial_build_started_at || null,
    initial_build_completed_at: els.planInitialCompleted?.checked
      ? state.plan.initial_build_completed_at || new Date().toISOString()
      : null,
    cadence,
    day,
    note: String(els.planNote?.value || "").trim(),
    strategy,
    strategy_config,
    strategy_overrides: state.plan.strategy_overrides || {},
    add_plan: readAddPlanConfigFromForm(),
    trading_cost: normalizeTradingCost({
      min_commission: els.planMinCommission?.value,
      commission_rate_pct: els.planCommissionRatePct?.value,
      max_fee_ratio_pct: els.planMaxFeeRatioPct?.value,
      lot_size: els.planLotSize?.value,
    }),
    pending_orders: state.plan.pending_orders || {},
    cash_reserve: state.plan.cash_reserve,
  };
  const stamped = stampInitialBuildStarted(state.plan);
  if (stamped.changed) state.plan = stamped.plan;
  if (els.planDay) {
    els.planDay.max = cadence === "monthly" ? "28" : "7";
    els.planDay.value = String(day);
  }
  if (els.planDayHint) {
    els.planDayHint.textContent = cadence === "monthly" ? "执行日（号）" : "执行日（周几 1–7）";
  }
  if (els.planStrategyHint) els.planStrategyHint.textContent = strategySummary(strategy);
  if (els.planStrategyCustom) els.planStrategyCustom.hidden = strategy !== "custom";
  renderInitialSummary();
}

function renderMetrics() {
  if (!els.etfMetrics) return;
  const capitalBase = Math.max(0, Number(state.plan?.capital_base) || 0);
  const line = overviewGlanceLine({ capitalBase });
  els.etfMetrics.textContent = state.etfs.length ? line : "";
  els.etfMetrics.hidden = !state.etfs.length;
}

function renderRows() {
  if (!els.etfRows) return;
  if (!state.etfs.length) {
    els.etfRows.innerHTML = "";
    if (els.etfEmpty) els.etfEmpty.hidden = false;
    if (els.overviewEmptyGuide) els.overviewEmptyGuide.hidden = false;
    return;
  }
  if (els.etfEmpty) els.etfEmpty.hidden = true;
  if (els.overviewEmptyGuide) els.overviewEmptyGuide.hidden = true;
  const { totalValue } = portfolioTotals();
  const capitalBase = Math.max(0, Number(state.plan?.capital_base) || 0);
  const overrides = state.plan?.strategy_overrides || {};
  els.etfRows.innerHTML = state.etfs
    .map((entry) => {
      const { quote, price, value, pnl, pnlPct } = entryMetrics(entry);
      const change = quote?.change_pct;
      const changeClass = change > 0 ? "up" : change < 0 ? "down" : "";
      const poolWeight = value != null ? (totalValue > 0 ? (value / totalValue) * 100 : 0) : null;
      const assetWeight = value != null && capitalBase > 0 ? (value / capitalBase) * 100 : null;
      const target = Number(entry.target_weight) || 0;
      const drift = poolWeight != null ? poolWeight - target : null;
      const driftClass = drift != null ? (drift > 0.5 ? "up" : drift < -0.5 ? "down" : "") : "";
      const selected = state.selectedEtf === entry.symbol;
      const fullIndex = analysisIsFullIndex(appConfig, entry.symbol);
      const rowStrategy = overrides[entry.symbol] || "";
      const strategyOptions = ROW_STRATEGY_OPTIONS.map(
        (opt) =>
          `<option value="${escapeAttr(opt.value)}"${opt.value === rowStrategy ? " selected" : ""}>${escapeHtml(opt.label)}</option>`,
      ).join("");
      return `
        <tr class="${selected ? "etf-row-selected" : ""}" data-symbol="${escapeAttr(entry.symbol)}">
          <td class="etf-drag-cell">
            <span class="etf-drag-handle" draggable="true" title="拖动排序" aria-label="拖动排序">⋮⋮</span>
          </td>
          <td>
            <button class="link-button etf-name" data-analyze="${escapeAttr(entry.symbol)}" type="button" title="打开定投分析">
              <strong>${escapeHtml(etfDisplayName(entry, quote))}</strong>
              <span class="muted">${escapeHtml(entry.symbol)}${fullIndex ? "" : " · ETF 口径"}</span>
            </button>
          </td>
          <td class="num">${price != null ? price.toFixed(3) : "—"}</td>
          <td class="num ${changeClass}">${change != null ? `${signed(change)}%` : "—"}</td>
          <td class="num etf-input-cell etf-col-target">
            <input type="number" min="0" max="100" step="any" value="${holdingInputValue(target)}" placeholder="0" data-field="target_weight" data-symbol="${escapeAttr(entry.symbol)}" aria-label="配置目标权重" title="池内目标权重" />
          </td>
          <td class="etf-input-cell etf-col-strategy">
            <select class="etf-strategy-select" data-field="strategy_override" data-symbol="${escapeAttr(entry.symbol)}" aria-label="本品种定投策略" title="覆盖全局策略">
              ${strategyOptions}
            </select>
          </td>
          <td class="num etf-col-pool" title="占池内市值">${poolWeight != null ? `${poolWeight.toFixed(1)}%` : "—"}</td>
          <td class="num etf-col-asset" title="占可投资总资金">${assetWeight != null ? `${assetWeight.toFixed(1)}%` : "—"}</td>
          <td class="num ${driftClass}" title="池内 − 配置">${
            drift != null ? `${signed(drift, 1)}%` : "—"
          }</td>
          <td class="num etf-input-cell">
            <input type="number" min="0" step="any" value="${holdingInputValue(entry.shares)}" placeholder="0" data-field="shares" data-symbol="${escapeAttr(entry.symbol)}" aria-label="持有份额" />
          </td>
          <td class="num etf-input-cell">
            <input type="number" min="0" step="any" value="${holdingInputValue(entry.cost)}" placeholder="0" data-field="cost" data-symbol="${escapeAttr(entry.symbol)}" aria-label="含费成本价" />
          </td>
          <td class="num">${value != null ? money(value) : "—"}</td>
          <td class="num ${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}">${
            pnl != null
              ? `${money(pnl)}${pnlPct != null ? `<br /><small>${signed(pnlPct, 1)}%</small>` : ""}`
              : "—"
          }</td>
          <td class="etf-actions">
            <button class="ghost-button compact danger" data-remove="${escapeAttr(entry.symbol)}" type="button">移除</button>
          </td>
        </tr>
      `;
    })
    .join("");

  els.etfRows.querySelectorAll("input[data-field]").forEach((input) => {
    input.addEventListener("change", () => {
      const entry = state.etfs.find((item) => item.symbol === input.dataset.symbol);
      if (!entry) return;
      const value = Number(input.value);
      if (input.dataset.field === "target_weight") {
        entry.target_weight = clampWeight(value);
        input.value = holdingInputValue(entry.target_weight);
      } else {
        entry[input.dataset.field] = Number.isFinite(value) && value >= 0 ? value : 0;
        input.value = holdingInputValue(entry[input.dataset.field]);
      }
      persistWorkspace();
      renderMetrics();
      renderRows();
      renderSidebarEtfs();
      renderPoolAllocation();
    });
  });
  els.etfRows.querySelectorAll("select[data-field='strategy_override']").forEach((select) => {
    select.addEventListener("change", () => {
      if (!state.plan) state.plan = {};
      const next = { ...(state.plan.strategy_overrides || {}) };
      const symbol = select.dataset.symbol;
      const value = String(select.value || "").trim().toLowerCase();
      if (!value) {
        delete next[symbol];
      } else {
        next[symbol] = normalizeStrategyId(value);
      }
      state.plan.strategy_overrides = next;
      persistWorkspace();
      renderPoolAllocation();
      renderRows();
    });
  });
  els.etfRows.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.etfs = state.etfs.filter((item) => item.symbol !== button.dataset.remove);
      if (state.selectedEtf === button.dataset.remove) {
        state.selectedEtf = null;
        if (els.etfChartPanel) els.etfChartPanel.hidden = true;
      }
      if (state.plan?.strategy_overrides?.[button.dataset.remove]) {
        const next = { ...state.plan.strategy_overrides };
        delete next[button.dataset.remove];
        state.plan.strategy_overrides = next;
      }
      persistWorkspace();
      renderMetrics();
      renderRows();
      renderSidebarEtfs();
      renderPoolAllocation();
    });
  });
  els.etfRows.querySelectorAll("[data-analyze]").forEach((button) => {
    button.addEventListener("click", () => openAnalysis(button.dataset.analyze));
  });
  bindDragReorder(els.etfRows, {
    itemSelector: "tr[data-symbol]",
    handleSelector: ".etf-drag-handle",
  });
}

export async function selectEtfChart(symbol) {
  state.selectedEtf = symbol;
  renderRows();
  if (!els.etfChartPanel) return;
  els.etfChartPanel.hidden = false;
  const entry = state.etfs.find((item) => item.symbol === symbol);
  const quote = state.quotesBySymbol[symbol];
  if (els.etfChartTitle) {
    els.etfChartTitle.textContent = `${etfDisplayName(entry, quote) || symbol}（${symbol}）`;
  }
  document.querySelectorAll("#etfChartPanel .js-range").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.priceRange);
  });
  if (els.etfChartSummary) els.etfChartSummary.textContent = "加载走势…";
  try {
    const response = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(state.priceRange)}`);
    const payload = await response.json();
    if (state.selectedEtf !== symbol) return;
    const points = payload.points || [];
    if (els.etfChartSummary) {
      if (!points.length) {
        els.etfChartSummary.textContent = payload.error ? `走势暂不可用：${payload.error}` : "暂无历史价格";
      } else {
        const first = points[0].close;
        const last = points[points.length - 1].close;
        const changePct = first ? ((last - first) / first) * 100 : 0;
        els.etfChartSummary.textContent = `${points[0].date} → ${points[points.length - 1].date} · 区间 ${signed(changePct, 1)}%${payload.provider ? ` · ${payload.provider}` : ""}`;
      }
    }
    const markers = [];
    if (entry && entry.cost > 0) markers.push({ key: "cost", label: "成本", value: entry.cost });
    markers.push(
      ...buyEventMarkers(
        (state.buys || []).filter((item) => item.symbol === symbol),
        { useBuyPrice: true },
      ),
      ...sellEventMarkers(
        (state.sells || []).filter((item) => item.symbol === symbol),
        { useSellPrice: true },
      ),
    );
    drawPriceChart(els.etfChart, els.etfChartTooltip, points, markers, "CNY", payload.error);
    els.etfChartPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    if (els.etfChartSummary) els.etfChartSummary.textContent = `走势暂不可用：${error}`;
  }
}

export async function addEtf(rawSymbol, shares, cost, targetWeight) {
  const symbol = normalizeEtfSymbol(rawSymbol);
  if (!symbol) {
    if (els.etfFormStatus) els.etfFormStatus.textContent = "请输入 6 位 ETF 代码，例如 512890";
    return;
  }
  if (state.etfs.some((item) => item.symbol === symbol)) {
    if (els.etfFormStatus) els.etfFormStatus.textContent = `${symbol} 已在计划中`;
    return;
  }
  if (els.etfFormStatus) els.etfFormStatus.textContent = `正在核验 ${symbol} 行情…`;
  try {
    const response = await fetch(`/api/etf/quotes?symbols=${encodeURIComponent(symbol)}`);
    const payload = await response.json();
    const quote = (payload.quotes || [])[0];
    if (!quote || quote.price == null) {
      throw new Error(payload.error || "行情源没有该代码，确认是 A 股场内 ETF");
    }
    const displayName = resolveEtfDisplayName({
      name: "",
      symbol,
      quoteName: quote.name,
      registryName: registryEtfName(symbol),
      seedName: seedEtfName(symbol),
    });
    state.etfs.push({
      symbol,
      name: displayName,
      shares: Number(shares) > 0 ? Number(shares) : 0,
      cost: Number(cost) > 0 ? Number(cost) : 0,
      target_weight: clampWeight(targetWeight),
      note: "",
    });
    state.quotesBySymbol[symbol] = quote;
    persistWorkspace();
    if (els.etfFormStatus) els.etfFormStatus.textContent = `已加入 ${displayName || symbol}`;
    if (els.etfSymbol) els.etfSymbol.value = "";
    if (els.etfShares) els.etfShares.value = "";
    if (els.etfCost) els.etfCost.value = "";
    if (els.etfTargetWeight) els.etfTargetWeight.value = "";
    renderMetrics();
    renderRows();
    renderBuys();
    renderSidebarEtfs();
  } catch (error) {
    if (els.etfFormStatus) els.etfFormStatus.textContent = `添加失败：${String(error).replace("Error: ", "")}`;
  }
}

function activateBuysTab() {
  callRenderer("switchView", "etf");
  const tab = document.querySelector('[data-etf-tab="buys"]');
  if (tab) tab.click();
}

function activateHomeExec() {
  callRenderer("switchView", "home");
  queueMicrotask(() => {
    els.execDraftPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function requestPortfolioAiReview({ force = false } = {}) {
  const ready = isPortfolioAiReady();
  if (!ready.ok) {
    callRenderer("switchView", "settings");
    return;
  }
  const pool = currentPoolAllocationResult();
  if (!pool) {
    state.aiPortfolioReview = { status: "error", error: "请先配置周期预算与目标仓位" };
    renderHomeTodayCard();
    renderHomeReturnsPanel();
    return;
  }
  state.aiPortfolioReview = { status: "loading" };
  renderHomeTodayCard();
  renderHomeReturnsPanel();
  try {
    const response = await fetch("/api/ai/review-portfolio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force,
        baseline: buildPortfolioReviewBaseline(pool, state.plan?.strategy),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    state.aiPortfolioReview = { status: "ready", result: payload };
  } catch (error) {
    state.aiPortfolioReview = {
      status: "error",
      error: String(error.message || error),
    };
  }
  renderHomeTodayCard();
  renderHomeReturnsPanel();
}

function bindDraftActions(root) {
  if (!root) return;
  root.querySelectorAll("[data-ai-portfolio-review]").forEach((button) => {
    button.addEventListener("click", () => {
      requestPortfolioAiReview({ force: button.dataset.force === "true" });
    });
  });
  root.querySelectorAll("[data-draft-confirm]").forEach((button) => {
    button.addEventListener("click", () => confirmExecutionDraft(button.dataset.draftConfirm));
  });
  root.querySelectorAll("[data-draft-skip]").forEach((button) => {
    button.addEventListener("click", () => skipExecutionDraft(button.dataset.draftSkip));
  });
  root.querySelectorAll("[data-draft-refresh-quote]").forEach((button) => {
    button.addEventListener("click", async () => {
      homeQuoteRefreshCooldownUntil = 0;
      try {
        await refreshQuotes(true);
      } catch (_) {
        /* ignore */
      }
      syncHomeExecutionDrafts({ persist: true });
      renderHomeTodayCard();
      renderHomeReturnsPanel();
      renderExecDraftPanel();
    });
  });
}

function quoteAsOf(symbol) {
  const quote = state.quotesBySymbol?.[symbol];
  return quote?.as_of || quote?.tencent_as_of || state.quotesMeta?.updated_at || "";
}

function fmtPct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}%`;
}

function syncHomeExecutionDrafts({ persist = true } = {}) {
  if (!(state.etfs || []).length) return null;
  const result = syncExecutionDraftsFromAllocation();
  if (persist && result.changed) persistWorkspace();
  return result;
}

let homeQuoteRefreshInFlight = null;
let homeQuoteRefreshCooldownUntil = 0;

function isQuoteFreshnessReason(text) {
  return /行情不是|可执行报价|报价已过期|缺少行情时间/.test(String(text || ""));
}

function draftNeedsQuoteRefresh(draft) {
  if (!draft || draft.status !== "pending") return false;
  const snap = draft.decision_snapshot || {};
  const live = state.quotesBySymbol?.[draft.symbol] || null;
  const price =
    Number(snap.quote_price) ||
    Number(draft.price) ||
    Number(live?.price) ||
    0;
  // 仅缺价时自动拉行情；不再因盘后时间戳过期反复刷新
  return !(price > 0);
}

function formatExecBlockReasons(draft) {
  const snap = draft.decision_snapshot || {};
  const side = draft.side === "sell" ? "sell" : "buy";
  const raw = (draft.readiness_reasons || snap.policy_reasons || [])
    .map((row) => String(row || "").trim())
    .filter(Boolean)
    .filter((row) => !isQuoteFreshnessReason(row));
  const lines = [];
  const premium = Number(snap.premium_discount_pct);
  const spread = Number(snap.bid_ask_spread_pct);

  if (Number.isFinite(premium)) {
    if (side === "buy" && premium >= 2) lines.push(`买入溢价 ${premium.toFixed(2)}%`);
    if (side === "sell" && premium <= -2) lines.push(`卖出折价 ${Math.abs(premium).toFixed(2)}%`);
  } else if (raw.some((row) => row.includes("折溢价"))) {
    const hit = raw.find((row) => row.includes("折溢价"));
    if (hit) lines.push(hit);
  }

  if (Number.isFinite(spread) && spread >= 0.2) {
    lines.push(`买卖价差 ${spread.toFixed(2)}%`);
  } else if (raw.some((row) => row.includes("缺少买卖价差"))) {
    lines.push("缺少买卖价差数据");
  }

  if (raw.some((row) => row.includes("缺少有效成交价格"))) {
    lines.push("缺少有效成交价格");
  }
  if (raw.some((row) => row.includes("分析数据不完整"))) {
    lines.push("分析数据不完整，仅供预览");
  }
  if (raw.some((row) => row.includes("方向冲突"))) {
    lines.push("组合计划方向冲突");
  }
  if (raw.some((row) => row.includes("行情缺失") || row.includes("冻结"))) {
    lines.push("持仓行情缺失，冻结交易");
  }
  if (raw.some((row) => row.includes("手续费率超过限制"))) {
    lines.push("手续费率超过限制");
  }

  return [...new Set(lines)];
}

function ensureFreshQuotesForHomeDrafts() {
  const drafts = (state.executionDrafts || []).filter((item) => item.status === "pending");
  if (!drafts.some(draftNeedsQuoteRefresh)) return;
  if (homeQuoteRefreshInFlight) return homeQuoteRefreshInFlight;
  if (Date.now() < homeQuoteRefreshCooldownUntil) return;
  homeQuoteRefreshCooldownUntil = Date.now() + 90_000;
  homeQuoteRefreshInFlight = (async () => {
    try {
      await refreshQuotes(true);
      syncHomeExecutionDrafts({ persist: true });
    } catch (_) {
      /* 行情失败时保留现有清单，不把过期写成决策原因 */
    } finally {
      homeQuoteRefreshInFlight = null;
    }
    renderHomeTodayCard();
    renderHomeReturnsPanel();
    renderExecDraftPanel({ skipQuoteRefresh: true });
  })();
  return homeQuoteRefreshInFlight;
}

function draftHasDisplayedQuote(draft) {
  const snap = draft?.decision_snapshot || {};
  if (Number(snap.quote_price) > 0 || Number(draft?.price) > 0) return true;
  if (snap.quote_as_of || Number.isFinite(parseQuoteTimestampMs(snap.market_timestamp))) return true;
  const live = state.quotesBySymbol?.[draft?.symbol];
  return Number(live?.price) > 0;
}

function draftActionButtons(draft) {
  const status = draft.readiness_status || "ready";
  const side = draft.side === "sell" ? "sell" : "buy";
  if (draft.status !== "pending") {
    const statusLabel =
      draft.status === "confirmed" ? "已入账" : draft.status === "skipped" ? "已跳过" : draft.status;
    return `<span class="exec-draft-done muted">${escapeHtml(statusLabel)}${
      draft.skip_reason ? ` · ${escapeHtml(draft.skip_reason)}` : ""
    }</span>`;
  }
  if (status !== "ready" && status !== "warning") {
    const reasons = formatExecBlockReasons(draft);
    if (reasons.length) {
      return `<div class="exec-draft-block-reason" title="${escapeAttr(reasons.join("；"))}">
        ${reasons.map((r) => `<span>${escapeHtml(r)}</span>`).join("")}
      </div>`;
    }
    // 已有行情（含盘后停住的收盘价）不显示「更新中」；仅缺价且正在拉取时提示
    if (homeQuoteRefreshInFlight && !draftHasDisplayedQuote(draft)) {
      return `<span class="exec-draft-block-reason is-refreshing muted">正在更新报价…</span>`;
    }
    return "";
  }
  // 待确认但整手为 0：展示原因，不可确认入账
  if (status === "warning" && !(Number(draft.shares) > 0)) {
    const reasons = formatExecBlockReasons(draft);
    return `<div class="exec-draft-zero-lot">
      ${
        reasons.length
          ? `<div class="exec-draft-block-reason" title="${escapeAttr(reasons.join("；"))}">
              ${reasons.map((r) => `<span>${escapeHtml(r)}</span>`).join("")}
            </div>`
          : ""
      }
      <button class="ghost-button home-touch-btn" type="button" data-draft-skip="${escapeAttr(draft.id)}">跳过</button>
    </div>`;
  }
  const confirmLabel =
    status === "warning"
      ? "检查风险并确认"
      : side === "sell"
        ? "确认卖出"
        : "确认买入";
  return `<div class="exec-draft-actions">
    <button class="primary-button home-touch-btn" type="button" data-draft-confirm="${escapeAttr(draft.id)}">${confirmLabel}</button>
    <button class="ghost-button home-touch-btn" type="button" data-draft-skip="${escapeAttr(draft.id)}">跳过</button>
  </div>`;
}

function draftRowHtml(draft) {
  const side = draft.side === "sell" ? "sell" : "buy";
  const sideLabel = side === "sell" ? "卖出" : "买入";
  const orderAmount =
    Number(draft.order_amount) || (Number(draft.shares) || 0) * (Number(draft.price) || 0);
  const snap = draft.decision_snapshot || {};
  const asOf = snap.quote_as_of || quoteAsOf(draft.symbol);
  const readiness = draft.readiness_status || snap.policy_status || "";
  const band = snap.band || draft.note || "";
  const showReasonFooter =
    draft.status === "pending" &&
    (readiness === "ready" || (readiness === "warning" && Number(draft.shares) > 0));
  const footerReasons = showReasonFooter
    ? (draft.readiness_reasons || snap.policy_reasons || [])
        .filter((row) => !isQuoteFreshnessReason(row))
        .join("；")
    : "";
  return `<article class="exec-draft-row${side === "sell" ? " is-sell" : ""}${
    draft.status !== "pending" ? " is-done" : ""
  } readiness-${escapeAttr(readiness || "ready")}">
    <header class="exec-draft-top">
      <div class="exec-draft-identity">
        <span class="trade-type ${side}">${sideLabel}</span>
        <div class="exec-draft-nameblock">
          <strong>${escapeHtml(draft.name || draft.symbol)}</strong>
          <span class="muted">${escapeHtml(draft.symbol)}</span>
        </div>
        <span class="exec-readiness-chip">${escapeHtml(policyStatusLabel(readiness))}</span>
      </div>
      ${draftActionButtons(draft)}
    </header>
    <dl class="exec-draft-figures">
      <div><dt>战略建议</dt><dd>${money(draft.suggested_amount)}</dd></div>
      <div><dt>整手份数</dt><dd>${(draft.shares || 0).toLocaleString("zh-CN")} 份</dd></div>
      <div><dt>预计成交</dt><dd>${money(orderAmount)}</dd></div>
      <div><dt>手续费</dt><dd>${money(draft.fee)}</dd></div>
    </dl>
    <p class="exec-draft-secondary muted">
      <span>折溢价 ${escapeHtml(fmtPct(snap.premium_discount_pct))}</span>
      <span>价差 ${escapeHtml(fmtPct(snap.bid_ask_spread_pct))}</span>
      ${band ? `<span>档位 ${escapeHtml(band)}</span>` : ""}
      <span>行情时刻 ${escapeHtml(asOf || "-")}</span>
    </p>
    ${footerReasons ? `<p class="exec-draft-reason muted">${escapeHtml(footerReasons)}</p>` : ""}
  </article>`;
}

function draftGroupHtml(title, drafts, extras = "") {
  if (!drafts.length) return "";
  return `
    <section class="exec-draft-group" aria-label="${escapeAttr(title)}">
      <div class="exec-draft-group-head">
        <strong>${escapeHtml(title)}</strong>
        <span class="muted">${extras}</span>
      </div>
      <div class="exec-draft-group-body">
        ${drafts.map(draftRowHtml).join("")}
      </div>
    </section>`;
}

function closeHomeConfirmSheet() {
  confirmingDraftId = null;
  if (!els.homeConfirmSheet) return;
  els.homeConfirmSheet.hidden = true;
  els.homeConfirmSheet.innerHTML = "";
}

function recordDecisionForDraft(draft, action, { fee = null, orderAmount = null } = {}) {
  const snap = draft.decision_snapshot || {};
  const entry = {
    id: `dec_${draft.id}_${action}_${Date.now().toString(36)}`,
    period: draft.period,
    symbol: draft.symbol,
    side: draft.side === "sell" ? "sell" : "buy",
    action,
    strategic_amount: draft.suggested_amount,
    order_amount: orderAmount != null ? orderAmount : draft.order_amount || draft.shares * draft.price,
    fee: fee != null ? fee : draft.fee,
    premium_discount_pct: snap.premium_discount_pct,
    bid_ask_spread_pct: snap.bid_ask_spread_pct,
    policy_status: draft.readiness_status || snap.policy_status || "",
    policy_reasons: draft.readiness_reasons || snap.policy_reasons || [],
    signal_snapshot_id: snap.signal_snapshot_id || state.execDraftsMeta?.signal_snapshot_id || null,
    created_at: new Date().toISOString(),
  };
  state.decisionHistory = appendDecisionHistory(entry, state.decisionHistory);
}

function openHomeConfirmSheet(id) {
  const draft = (state.executionDrafts || []).find((item) => item.id === id);
  if (!draft || draft.status !== "pending" || !els.homeConfirmSheet) return;
  const readiness = draft.readiness_status || draft.decision_snapshot?.policy_status || "ready";
  if (readiness === "blocked" || readiness === "preview") return;
  confirmingDraftId = id;
  const side = draft.side === "sell" ? "sell" : "buy";
  const sideLabel = side === "sell" ? "卖出" : "买入";
  const notional = (Number(draft.shares) || 0) * (Number(draft.price) || 0);
  const fee = Math.max(0, Number(draft.fee) || 0);
  const cash = side === "sell" ? Math.max(0, notional - fee) : notional + fee;
  const impact =
    side === "sell"
      ? `提交后：持仓减少 ${draft.shares.toLocaleString("zh-CN")} 份；新增一笔卖出记录；现金池预计增加 ${money(cash)}。`
      : `提交后：持仓增加 ${draft.shares.toLocaleString("zh-CN")} 份；新增一笔买入记录；预计占用现金 ${money(cash)}。`;
  const needsOverride = readiness === "warning";
  els.homeConfirmSheet.hidden = false;
  els.homeConfirmSheet.innerHTML = `
    <section class="panel-block home-confirm-block" aria-label="确认入账">
      <div class="panel-heading">
        <div>
          <h3 class="section-title">确认${sideLabel}</h3>
          <p class="muted">${escapeHtml(draft.name || draft.symbol)} · ${escapeHtml(draft.symbol)} · ${escapeHtml(
            policyStatusLabel(readiness),
          )}</p>
        </div>
        <button class="ghost-button home-touch-btn" type="button" data-home-confirm-cancel>取消</button>
      </div>
      <p class="home-confirm-impact">${escapeHtml(impact)}</p>
      <p class="muted">战略建议 ${money(draft.suggested_amount)} · 预计成交 ${money(notional)} · 费 ${money(fee)}</p>
      <form class="home-confirm-form" data-home-confirm-form>
        <label><span>成交价</span><input name="price" type="number" min="0" step="any" value="${escapeAttr(String(draft.price))}" required /></label>
        <label><span>份额</span><input name="shares" type="number" min="0" step="any" value="${escapeAttr(String(draft.shares))}" required /></label>
        <label><span>手续费</span><input name="fee" type="number" min="0" step="any" value="${escapeAttr(fee > 0 ? String(fee) : "")}" placeholder="自动估算" /></label>
        <label class="grow"><span>备注</span><input name="note" type="text" value="${escapeAttr(
          draft.note || (side === "sell" ? `卖出纪律 ${draft.period}` : `执行清单 ${draft.period}`),
        )}" /></label>
        ${
          needsOverride
            ? `<label class="grow home-override-box">
                <span><input name="override_ack" type="checkbox" /> 我已知晓风险并人工放行</span>
                <input name="override_reason" type="text" placeholder="放行原因（至少 3 个字）" required />
              </label>`
            : ""
        }
        <p class="muted home-confirm-status" data-home-confirm-status role="status"></p>
        <button class="primary-button home-touch-btn" type="submit" data-home-confirm-submit>
          确认${sideLabel}并入账 ${money(cash)}
        </button>
      </form>
    </section>
  `;
  const form = els.homeConfirmSheet.querySelector("[data-home-confirm-form]");
  const statusEl = els.homeConfirmSheet.querySelector("[data-home-confirm-status]");
  const submit = els.homeConfirmSheet.querySelector("[data-home-confirm-submit]");
  const refreshSubmitLabel = () => {
    const price = Number(form.price.value);
    const shares = Number(form.shares.value);
    const feeInput = form.fee.value === "" ? fee : Number(form.fee.value);
    const gross = (Number.isFinite(price) ? price : 0) * (Number.isFinite(shares) ? shares : 0);
    const feeAmt = Number.isFinite(feeInput) && feeInput >= 0 ? feeInput : 0;
    const total = side === "sell" ? Math.max(0, gross - feeAmt) : gross + feeAmt;
    submit.textContent = `确认${sideLabel}并入账 ${money(total)}`;
  };
  form.addEventListener("input", refreshSubmitLabel);
  els.homeConfirmSheet.querySelector("[data-home-confirm-cancel]")?.addEventListener("click", () => {
    closeHomeConfirmSheet();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const price = Number(form.price.value);
    const shares = Number(form.shares.value);
    const feeRaw = form.fee.value;
    const feeInput = feeRaw === "" ? null : Number(feeRaw);
    const note = String(form.note.value || "").trim();
    const date = draft.date || new Date().toISOString().slice(0, 10);
    if (!(price > 0) || !(shares > 0)) {
      if (statusEl) statusEl.textContent = "成交价与份额需大于 0";
      return;
    }
    const quote = state.quotesBySymbol?.[draft.symbol] || null;
    const holding = (state.etfs || []).find((item) => item.symbol === draft.symbol);
    const indexCode =
      holding &&
      (state.analysisCache?.[draft.symbol]?.index_code ||
        appConfig?.etf?.analysis_registry?.[draft.symbol]?.index_code ||
        "");
    const recheck = evaluateExecutionPolicy({
      side,
      phase: draft.decision_snapshot?.phase || planExecutionContext({ plan: state.plan }).phase,
      strategy: draft.decision_snapshot?.strategy || state.plan?.strategy,
      quote,
      analysisUsable: draft.decision_snapshot?.analysis_usable !== false,
      indexCode,
      price,
      now: new Date(),
      executionPolicy: state.plan?.execution_policy,
    });
    const prevFp = draft.decision_snapshot?.policy_fingerprint || "";
    if (recheck.metrics.policy_fingerprint !== prevFp || recheck.status !== readiness) {
      if (statusEl) statusEl.textContent = "交易条件已变化，请重新确认";
      syncHomeExecutionDrafts({ persist: true });
      renderHomeTodayCard();
      renderHomeReturnsPanel();
      renderExecDraftPanel();
      return;
    }
    if (needsOverride) {
      const ack = Boolean(form.override_ack?.checked);
      const reason = String(form.override_reason?.value || "").trim();
      if (!ack) {
        if (statusEl) statusEl.textContent = "请勾选已知晓风险";
        return;
      }
      const gate = canSubmitWithOverride({
        status: readiness,
        overrideReason: reason,
        allowWarningOverride: state.plan?.execution_policy?.allow_warning_override !== false,
      });
      if (!gate.ok) {
        if (statusEl) statusEl.textContent = gate.reason || "无法放行";
        return;
      }
    }
    try {
      const result = confirmDraftIntoLedger({
        draft,
        etfs: state.etfs,
        buys: state.buys,
        sells: state.sells,
        executionDrafts: state.executionDrafts,
        plan: state.plan,
        tradingCost: state.plan?.trading_cost,
        price,
        shares,
        fee: feeInput != null && Number.isFinite(feeInput) && feeInput >= 0 ? feeInput : null,
        date,
        note,
      });
      state.etfs = result.etfs;
      state.buys = result.buys;
      state.sells = result.sells;
      state.executionDrafts = result.executionDrafts;
      state.plan = result.plan;
      state.plan = settlePlanAfterDrafts({ plan: state.plan }) || state.plan;
      recordDecisionForDraft(draft, needsOverride ? "override" : "confirmed", {
        fee: result.trade?.fee,
        orderAmount: (result.trade?.price || 0) * (result.trade?.shares || 0),
      });
      closeHomeConfirmSheet();
      persistWorkspace();
      syncHomeExecutionDrafts({ persist: true });
      renderHomeTodayCard();
      renderHomeReturnsPanel();
      renderExecDraftPanel();
      renderPoolAllocation();
      renderMetrics();
      renderRows();
      renderSidebarEtfs();
    } catch (error) {
      if (statusEl) statusEl.textContent = `入账失败：${String(error).replace("Error: ", "")}`;
    }
  });
  els.homeConfirmSheet.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function confirmExecutionDraft(id) {
  const draft = (state.executionDrafts || []).find((item) => item.id === id);
  if (!draft || draft.status !== "pending") return;
  const readiness = draft.readiness_status || draft.decision_snapshot?.policy_status || "ready";
  if (readiness === "blocked" || readiness === "preview") return;
  if (state.activeView === "home" && els.homeConfirmSheet) {
    openHomeConfirmSheet(id);
    return;
  }
  confirmingDraftId = id;
  activateBuysTab();
  const side = draft.side === "sell" ? "sell" : "buy";
  if (els.tradeType) els.tradeType.value = side;
  if (els.buySymbol) els.buySymbol.value = draft.symbol;
  if (els.buyDate) els.buyDate.value = draft.date;
  if (els.buyPrice) els.buyPrice.value = String(draft.price);
  if (els.buyShares) els.buyShares.value = String(draft.shares);
  if (els.buyFee) els.buyFee.value = draft.fee > 0 ? String(draft.fee) : "";
  if (els.buyNote) {
    els.buyNote.value =
      draft.note || (side === "sell" ? `卖出纪律 ${draft.period}` : `执行清单 ${draft.period}`);
  }
  if (els.buySubmit) {
    const notional = (Number(draft.shares) || 0) * (Number(draft.price) || 0);
    const fee = Math.max(0, Number(draft.fee) || 0);
    const cash = side === "sell" ? Math.max(0, notional - fee) : notional + fee;
    els.buySubmit.textContent = `确认${side === "sell" ? "卖出" : "买入"}并入账 ${money(cash)}`;
  }
  if (els.buyCancelEdit) els.buyCancelEdit.hidden = false;
  if (els.buyFormStatus) {
    const dir = side === "sell" ? "卖出" : "买入";
    els.buyFormStatus.textContent = `已预填${dir} ${draft.name || draft.symbol}：可修正成交价后提交入账`;
  }
  els.buyForm?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function applyCashReserveSettlement() {
  const settled = settleCashReserveOnPeriodComplete();
  if (settled) state.plan = settled;
}

function skipExecutionDraft(id) {
  const draft = (state.executionDrafts || []).find((item) => item.id === id);
  if (!draft || draft.status !== "pending") return;
  const reason = window.prompt("跳过原因（可选）", "") ?? "";
  state.executionDrafts = updateExecutionDraft(id, {
    status: "skipped",
    skip_reason: String(reason).trim(),
  });
  recordDecisionForDraft(draft, "skipped");
  applyCashReserveSettlement();
  persistWorkspace();
  if (confirmingDraftId === id) closeHomeConfirmSheet();
  renderPoolAllocation();
  renderHomeTodayCard();
  renderHomeReturnsPanel();
  renderExecDraftPanel();
}

function renderHomeTodayCard() {
  if (!els.homeTodayCard) return;
  if (!(state.etfs || []).length) {
    els.homeTodayCard.hidden = true;
    els.homeTodayCard.innerHTML = "";
    return;
  }
  const summary = executionDraftSummary();
  els.homeTodayCard.hidden = false;
  els.homeTodayCard.innerHTML = `
    <section class="panel-block home-today-block" aria-label="今日结论">
      <div class="panel-heading">
        <div>
          <h3 class="section-title">今日结论</h3>
        </div>
        <div class="home-today-heading-actions">
          <button class="ghost-button home-touch-btn" type="button" data-ai-portfolio-review>AI 分析</button>
          <button class="ghost-button home-touch-btn" type="button" data-reevaluate-strategy>重新评估本期策略</button>
        </div>
      </div>
      <div class="home-today-metrics" role="list">
        <div class="pool-alloc-metric" role="listitem"><span>可执行买入</span><strong>${
          summary.readyBuys.length + summary.warningBuys.length
        }</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>等待买入</span><strong>${
          summary.waitingBuys.length
        }</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>卖出</span><strong>${
          summary.pendingSells.length
        }</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>可执行现金</span><strong>${money(
          summary.buyCash,
        )}</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>等待改善</span><strong>${money(
          summary.waitingCash,
        )}</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>保留现金</span><strong>${money(
          summary.keptCash,
        )}</strong></div>
      </div>
      ${
        summary.stale
          ? `<p class="home-today-meta"><span class="home-stale-flag">清单已过期，需要更新</span></p>`
          : ""
      }
      ${portfolioReviewResultHtml(state.aiPortfolioReview)}
    </section>
  `;
  bindDraftActions(els.homeTodayCard);
  els.homeTodayCard.querySelector("[data-reevaluate-strategy]")?.addEventListener("click", () => {
    const ok = window.confirm(
      "将重新评估本期策略信号（PE 档位/评分/情绪），并重建所有待执行清单。已确认与已跳过记录会保留。是否继续？",
    );
    if (!ok) return;
    reevaluatePeriodStrategy();
    persistWorkspace();
    renderHomeTodayCard();
    renderHomeReturnsPanel();
    renderExecDraftPanel();
    renderPoolAllocation();
  });
}

function pnlToneClass(pnl) {
  if (!(Number.isFinite(Number(pnl)))) return "";
  if (pnl > 0) return "up";
  if (pnl < 0) return "down";
  return "";
}

function formatReturnCell(pnl, pnlPct) {
  if (pnl == null) return "—";
  const pct = pnlPct != null ? `（${signed(pnlPct, 1)}%）` : "";
  return `${money(pnl)}${pct}`;
}

function homeEquityPeriodButtonsHtml(activePeriod) {
  return HOME_EQUITY_PERIODS.map(
    (item) =>
      `<button class="segment-button js-home-equity-period${
        item.id === activePeriod ? " active" : ""
      }" data-period="${item.id}" type="button">${item.label}</button>`,
  ).join("");
}

function homeEquityChartBlockHtml(period) {
  return `
    <div class="home-returns-chart" aria-label="收益走势">
      <div class="home-returns-chart-heading">
        <div>
          <h4 class="home-returns-chart-title">收益走势</h4>
          <p class="muted home-returns-chart-summary" id="homeEquityChartSummary">加载走势…</p>
        </div>
        <div class="range-segment" role="group" aria-label="收益走势粒度">
          ${homeEquityPeriodButtonsHtml(period)}
        </div>
      </div>
      <div class="price-chart-shell home-equity-chart-shell">
        <canvas id="homeEquityChart" width="960" height="320" aria-label="组合收益折线图"></canvas>
        <div class="price-tooltip" id="homeEquityChartTooltip" hidden></div>
      </div>
    </div>
  `;
}

function bindHomeEquityPeriodButtons(root) {
  root?.querySelectorAll(".js-home-equity-period").forEach((button) => {
    button.addEventListener("click", () => {
      const period = button.dataset.period;
      if (!period || period === state.homeEquityPeriod) return;
      state.homeEquityPeriod = period;
      root.querySelectorAll(".js-home-equity-period").forEach((node) => {
        node.classList.toggle("active", node.dataset.period === period);
      });
      void refreshHomeEquityChart({ forceRedraw: true });
    });
  });
}

async function fetchHomeEquityHistories(symbols, fingerprint) {
  const range = state.homeEquityHistory?.range || "5y";
  state.homeEquityHistory = {
    ...state.homeEquityHistory,
    status: "loading",
    fingerprint,
    range,
    error: null,
  };
  const bySymbol = {};
  const errors = [];
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const response = await fetch(
          `/api/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`,
        );
        const payload = await response.json();
        bySymbol[symbol] = { points: payload.points || [], error: payload.error || null };
        if (payload.error && !(payload.points || []).length) errors.push(`${symbol}: ${payload.error}`);
      } catch (error) {
        bySymbol[symbol] = { points: [], error: String(error?.message || error) };
        errors.push(`${symbol}: ${error?.message || error}`);
      }
    }),
  );
  if (equityDataFingerprint(state.etfs, state.buys, state.sells) !== fingerprint) {
    return null;
  }
  state.homeEquityHistory = {
    status: "ready",
    fingerprint,
    range,
    bySymbol,
    error: errors.length ? errors.slice(0, 3).join("；") : null,
    fetchedAt: Date.now(),
  };
  return state.homeEquityHistory;
}

function drawHomeEquityChartFromCache() {
  const canvas = document.querySelector("#homeEquityChart");
  const tooltip = document.querySelector("#homeEquityChartTooltip");
  const summaryEl = document.querySelector("#homeEquityChartSummary");
  if (!canvas) return;

  const cache = state.homeEquityHistory || {};
  const period = state.homeEquityPeriod || "month";
  const periodLabel = HOME_EQUITY_PERIODS.find((item) => item.id === period)?.label || period;

  if (cache.status === "loading") {
    if (summaryEl) summaryEl.textContent = "加载走势…";
    drawPriceChart(canvas, tooltip, [], [], "CNY", null);
    return;
  }

  const daily = buildDailyEquityCurve({
    buys: state.buys,
    sells: state.sells,
    etfs: state.etfs,
    historyBySymbol: cache.bySymbol || {},
  });
  const points = prepareEquityChartPoints(daily, period);

  if (!points.length) {
    const err = cache.error || (cache.status === "error" ? "行情不可用" : null);
    if (summaryEl) {
      summaryEl.textContent = err ? `走势暂不可用：${err}` : "暂无足够的历史价格，无法绘制走势";
    }
    drawPriceChart(canvas, tooltip, [], [], "CNY", err);
    return;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const pnlDelta = (last.pnl ?? last.close) - (first.pnl ?? first.close);
  if (summaryEl) {
    const hint = cache.error ? ` · 部分品种：${cache.error}` : "";
    summaryEl.textContent = `${periodLabel} · ${first.date} → ${last.date} · 盈亏 ${money(
      last.pnl ?? last.close,
    )} · 区间 ${money(pnlDelta)}${hint}`;
  }
  drawPriceChart(canvas, tooltip, points, [{ key: "cost", label: "0", value: 0 }], "CNY", null);
}

async function refreshHomeEquityChart({ forceRedraw = false } = {}) {
  if (!els.homeReturnsPanel || els.homeReturnsPanel.hidden) return;
  if (!document.querySelector("#homeEquityChart")) return;

  const symbols = symbolsForEquityCurve(state.etfs, state.buys, state.sells);
  const fingerprint = equityDataFingerprint(state.etfs, state.buys, state.sells);
  const cache = state.homeEquityHistory || {};

  if (!symbols.length) {
    const summaryEl = document.querySelector("#homeEquityChartSummary");
    if (summaryEl) summaryEl.textContent = "暂无持仓品种";
    drawHomeEquityChartFromCache();
    return;
  }

  const cacheHit =
    cache.status === "ready" &&
    cache.fingerprint === fingerprint &&
    cache.bySymbol &&
    Object.keys(cache.bySymbol).length > 0;

  if (cacheHit) {
    drawHomeEquityChartFromCache();
    return;
  }

  if (cache.status === "loading" && cache.fingerprint === fingerprint && !forceRedraw) {
    drawHomeEquityChartFromCache();
    return;
  }

  state.homeEquityHistory = {
    ...state.homeEquityHistory,
    status: "loading",
    fingerprint,
    error: null,
  };
  drawHomeEquityChartFromCache();
  const next = await fetchHomeEquityHistories(symbols, fingerprint);
  if (!next) return;
  drawHomeEquityChartFromCache();
}

function renderHomeReturnsPanel() {
  if (!els.homeReturnsPanel) return;
  if (!(state.etfs || []).length) {
    els.homeReturnsPanel.hidden = true;
    els.homeReturnsPanel.innerHTML = "";
    return;
  }
  const registry = appConfig?.etf?.analysis_registry || appConfig?.etf?.analysis_support || {};
  const summary = portfolioReturnsByIndex({
    etfs: state.etfs,
    quotesBySymbol: state.quotesBySymbol,
    analysisRegistry: registry,
    analysisCache: state.analysisCache || {},
  });
  const { total, indices } = summary;
  const period = HOME_EQUITY_PERIODS.some((item) => item.id === state.homeEquityPeriod)
    ? state.homeEquityPeriod
    : "month";
  state.homeEquityPeriod = period;
  els.homeReturnsPanel.hidden = false;
  if (!indices.length) {
    els.homeReturnsPanel.innerHTML = `
      <section class="panel-block home-returns-block" aria-label="历史收益">
        <div class="panel-heading">
          <div>
            <h3 class="section-title">历史收益</h3>
            <p class="muted">按指数汇总持仓市值与盈亏；录入份额与含费成本后显示。</p>
          </div>
        </div>
        <p class="muted home-returns-empty">暂无持仓，尚无历史收益。</p>
        ${homeEquityChartBlockHtml(period)}
      </section>
    `;
    bindHomeEquityPeriodButtons(els.homeReturnsPanel);
    void refreshHomeEquityChart();
    return;
  }
  const rowsHtml = indices
    .map((row) => {
      const etfHint =
        row.etfs.length > 1
          ? row.etfs.map((item) => item.name || item.symbol).join(" · ")
          : row.etfs[0]?.symbol || "";
      return `<div class="home-returns-row">
        <div class="home-returns-index">
          <strong>${escapeHtml(row.indexName)}</strong>
          ${etfHint ? `<span class="muted">${escapeHtml(etfHint)}</span>` : ""}
        </div>
        <div class="num">${row.marketValue != null ? money(row.marketValue) : "—"}</div>
        <div class="num">${row.costValue != null ? money(row.costValue) : "—"}</div>
        <div class="num ${pnlToneClass(row.pnl)}">${formatReturnCell(row.pnl, row.pnlPct)}</div>
      </div>`;
    })
    .join("");
  els.homeReturnsPanel.innerHTML = `
    <section class="panel-block home-returns-block" aria-label="历史收益">
      <div class="panel-heading">
        <div>
          <h3 class="section-title">历史收益</h3>
        </div>
      </div>
      <div class="home-today-metrics home-returns-metrics" role="list">
        <div class="pool-alloc-metric" role="listitem"><span>市值</span><strong>${
          total.marketValue != null ? money(total.marketValue) : "—"
        }</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>成本</span><strong>${
          total.costValue != null ? money(total.costValue) : "—"
        }</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>盈亏</span><strong class="${pnlToneClass(
          total.pnl,
        )}">${total.pnl != null ? money(total.pnl) : "—"}</strong></div>
        <div class="pool-alloc-metric" role="listitem"><span>收益率</span><strong class="${pnlToneClass(
          total.pnl,
        )}">${total.pnlPct != null ? `${signed(total.pnlPct, 1)}%` : "—"}</strong></div>
      </div>
      <div class="home-returns-table" aria-label="分指数收益">
        <div class="home-returns-head"><span>指数</span><span class="num">市值</span><span class="num">成本</span><span class="num">盈亏</span></div>
        ${rowsHtml}
      </div>
      ${homeEquityChartBlockHtml(period)}
    </section>
  `;
  bindHomeEquityPeriodButtons(els.homeReturnsPanel);
  void refreshHomeEquityChart();
}

function renderExecDraftPanel({ skipQuoteRefresh = false } = {}) {
  if (!els.execDraftPanel) return;
  if (!(state.etfs || []).length) {
    els.execDraftPanel.hidden = true;
    els.execDraftPanel.innerHTML = "";
    return;
  }
  const summary = executionDraftSummary();
  const done = summary.drafts.filter((item) => item.status !== "pending");
  const ready = summary.drafts.filter(
    (item) => item.status === "pending" && item.readiness_status === "ready",
  );
  const warning = summary.drafts.filter(
    (item) => item.status === "pending" && item.readiness_status === "warning",
  );
  const waiting = summary.drafts.filter(
    (item) =>
      item.status === "pending" &&
      (item.readiness_status === "preview" || item.readiness_status === "blocked"),
  );

  els.execDraftPanel.hidden = false;
  els.execDraftPanel.innerHTML = `
    <section class="panel-block exec-draft-block" aria-label="本期执行清单">
      <div class="panel-heading">
        <div>
          <h3 class="section-title">本期执行清单</h3>
        </div>
      </div>
      ${
        summary.drafts.length
          ? `<div class="exec-draft-list">
              ${draftGroupHtml("可以执行", ready, `${ready.length} 笔`)}
              ${draftGroupHtml("需要确认", warning, `${warning.length} 笔`)}
              ${draftGroupHtml(
                "等待条件改善",
                waiting,
                waiting.length ? `${waiting.length} 笔 · ${money(summary.waitingCash)}` : "",
              )}
              ${draftGroupHtml("已处理", done, `${done.length} 笔`)}
            </div>`
          : `<p class="muted exec-draft-empty">本期暂无执行项。</p>`
      }
    </section>
  `;
  bindDraftActions(els.execDraftPanel);
  if (!skipQuoteRefresh) ensureFreshQuotesForHomeDrafts();
}

function renderPoolAllocation() {
  renderSidebarEtfs();
  ensurePoolAnalysisPrefetch({
    onUpdate: () => {
      if (state.activeView !== "etf" && state.activeView !== "home") return;
      renderSidebarEtfs();
      syncHomeExecutionDrafts({ persist: true });
      renderHomeTodayCard();
      renderHomeReturnsPanel();
      renderExecDraftPanel();
    },
  });
}

function renderBuySymbolOptions() {
  if (!els.buySymbol && !els.buyFilterSymbol) return;
  const current = els.buySymbol?.value || "";
  const currentFilter = els.buyFilterSymbol?.value || "";
  const options = state.etfs
    .map((entry) => {
      const quote = state.quotesBySymbol[entry.symbol];
      const name = etfDisplayName(entry, quote);
      return `<option value="${escapeAttr(entry.symbol)}">${escapeHtml(name)}（${escapeHtml(entry.symbol)}）</option>`;
    })
    .join("");
  if (els.buySymbol) {
    els.buySymbol.innerHTML = `<option value="">选择品种</option>${options}`;
    if (current && state.etfs.some((item) => item.symbol === current)) {
      els.buySymbol.value = current;
    }
  }
  if (els.buyFilterSymbol) {
    els.buyFilterSymbol.innerHTML = `<option value="">全部 ETF</option>${options}`;
    if (currentFilter && state.etfs.some((item) => item.symbol === currentFilter)) {
      els.buyFilterSymbol.value = currentFilter;
    }
  }
}

export function renderBuys() {
  if (!els.buyRows) return;
  renderBuySymbolOptions();
  renderExecDraftPanel();
  const trades = [
    ...(state.buys || []).map((item) => ({ ...item, type: "buy" })),
    ...(state.sells || []).map((item) => ({ ...item, type: "sell" })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
  const filterSymbol = els.buyFilterSymbol?.value || "";
  const filterType = els.buyFilterType?.value || "";
  const filteredTrades = trades.filter(
    (trade) => (!filterSymbol || trade.symbol === filterSymbol) && (!filterType || trade.type === filterType),
  );
  if (els.buyFilterCount) {
    const filtered = Boolean(filterSymbol || filterType);
    els.buyFilterCount.textContent = filtered ? `显示 ${filteredTrades.length} / 共 ${trades.length} 笔` : `共 ${trades.length} 笔`;
  }
  if (els.buyEmpty) {
    els.buyEmpty.hidden = filteredTrades.length > 0;
    els.buyEmpty.textContent = filterSymbol || filterType ? "当前筛选条件下暂无交易记录。" : "暂无交易记录。";
  }
  if (!filteredTrades.length) {
    els.buyRows.innerHTML = "";
    return;
  }
  els.buyRows.innerHTML = filteredTrades
    .map((trade) => {
      const entry = state.etfs.find((item) => item.symbol === trade.symbol);
      const quote = state.quotesBySymbol[trade.symbol];
      const name = entry ? etfDisplayName(entry, quote) : quote?.name || trade.symbol;
      const amount = trade.price * trade.shares;
      const fee = Math.max(0, Number(trade.fee) || 0);
      const cashImpact = trade.type === "sell" ? amount - fee : amount + fee;
      const editing = editingTrade?.id === trade.id && editingTrade?.type === trade.type;
      return `
        <tr data-trade-id="${escapeAttr(trade.id)}" class="${editing ? "is-editing" : ""}">
          <td>${escapeHtml(trade.date)}</td>
          <td><span class="trade-type ${trade.type}">${trade.type === "sell" ? "卖出" : "买入"}</span></td>
          <td>
            <button class="link-button etf-name" data-analyze="${escapeAttr(trade.symbol)}" type="button">${escapeHtml(name)}</button>
            <span class="muted"> ${escapeHtml(trade.symbol)}</span>
          </td>
          <td class="num">${money(trade.price, "CNY", 3)}</td>
          <td class="num">${trade.shares}</td>
          <td class="num">${money(amount)}</td>
          <td class="num">${money(fee)}</td>
          <td class="num">${money(cashImpact)}</td>
          <td>${escapeHtml(trade.note || "—")}</td>
          <td class="num">
            <span class="buy-row-actions">
              <button class="ghost-button compact" type="button" data-edit-trade="${escapeAttr(trade.id)}" data-trade-type="${trade.type}">修改</button>
              <button class="ghost-button compact danger" type="button" data-remove-trade="${escapeAttr(trade.id)}" data-trade-type="${trade.type}">删除</button>
            </span>
          </td>
        </tr>
      `;
    })
    .join("");

  els.buyRows.querySelectorAll("[data-analyze]").forEach((button) => {
    button.addEventListener("click", () => openAnalysis(button.dataset.analyze));
  });
  els.buyRows.querySelectorAll("[data-edit-trade]").forEach((button) => {
    button.addEventListener("click", () => startBuyEdit(button.dataset.tradeType, button.dataset.editTrade));
  });
  els.buyRows.querySelectorAll("[data-remove-trade]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.tradeType;
      const id = button.dataset.removeTrade;
      if (editingTrade?.id === id && editingTrade?.type === type) cancelBuyEdit();
      const collection = type === "sell" ? state.sells : state.buys;
      const removed = (collection || []).find((item) => item.id === id);
      if (type === "sell") state.sells = (state.sells || []).filter((item) => item.id !== id);
      else state.buys = (state.buys || []).filter((item) => item.id !== id);
      if (removed?.symbol) syncHoldingFromTrades(removed.symbol);
      persistWorkspace();
      renderBuys();
      renderMetrics();
      renderRows();
      renderSidebarEtfs();
      if (state.selectedEtf) selectEtfChart(state.selectedEtf);
      if (els.buyFormStatus) els.buyFormStatus.textContent = `已删除${type === "sell" ? "卖出" : "买入"}记录`;
    });
  });
}

function startBuyEdit(type, id) {
  const collection = type === "sell" ? state.sells : state.buys;
  const trade = (collection || []).find((item) => item.id === id);
  if (!trade) return;
  editingTrade = { id: trade.id, type };
  if (els.tradeType) els.tradeType.value = type;
  if (els.buySymbol) els.buySymbol.value = trade.symbol;
  if (els.buyDate) els.buyDate.value = trade.date;
  if (els.buyPrice) els.buyPrice.value = String(trade.price);
  if (els.buyShares) els.buyShares.value = String(trade.shares);
  if (els.buyFee) els.buyFee.value = trade.fee > 0 ? String(trade.fee) : "";
  if (els.buyNote) els.buyNote.value = trade.note || "";
  if (els.buySubmit) els.buySubmit.textContent = "保存修改";
  if (els.buyCancelEdit) els.buyCancelEdit.hidden = false;
  if (els.buyFormStatus) els.buyFormStatus.textContent = `正在修改 ${trade.symbol} ${trade.date} 的${type === "sell" ? "卖出" : "买入"}记录`;
  renderBuys();
  els.buyForm?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function cancelBuyEdit() {
  editingTrade = null;
  confirmingDraftId = null;
  if (els.buySubmit) els.buySubmit.textContent = els.tradeType?.value === "sell" ? "添加卖出" : "添加买入";
  if (els.buyCancelEdit) els.buyCancelEdit.hidden = true;
  if (els.buyPrice) els.buyPrice.value = "";
  if (els.buyShares) els.buyShares.value = "";
  if (els.buyFee) els.buyFee.value = "";
  if (els.buyNote) els.buyNote.value = "";
  if (els.buyFormStatus) els.buyFormStatus.textContent = "";
  renderBuys();
}

function syncHoldingFromTrades(symbol) {
  const entry = state.etfs.find((item) => item.symbol === symbol);
  if (!entry) return;
  const derived = holdingFromTrades(state.buys, state.sells, symbol);
  const hasTrades = (state.buys || []).some((item) => item.symbol === symbol)
    || (state.sells || []).some((item) => item.symbol === symbol);
  if (!hasTrades) return;
  entry.shares = derived.shares;
  entry.cost = derived.cost;
}

function newTradeId(type, symbol, date) {
  return `${type}_${symbol}_${date}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function addBuyRecord() {
  const type = els.tradeType?.value === "sell" ? "sell" : "buy";
  const symbol = String(els.buySymbol?.value || "").trim();
  const date = String(els.buyDate?.value || "").trim();
  const price = Number(els.buyPrice?.value);
  const shares = Number(els.buyShares?.value);
  const feeInput = Number(els.buyFee?.value);
  const note = String(els.buyNote?.value || "").trim();
  if (!symbol) {
    if (els.buyFormStatus) els.buyFormStatus.textContent = "请选择 ETF";
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (els.buyFormStatus) els.buyFormStatus.textContent = "请填写交易日期";
    return;
  }
  if (!(price > 0) || !(shares > 0)) {
    if (els.buyFormStatus) els.buyFormStatus.textContent = "成交价与份额需大于 0";
    return;
  }
  if (!state.etfs.some((item) => item.symbol === symbol)) {
    if (els.buyFormStatus) els.buyFormStatus.textContent = "该 ETF 不在计划中";
    return;
  }

  // 执行清单确认：走纯函数入账，保证与测试路径一致
  const confirming =
    confirmingDraftId &&
    (state.executionDrafts || []).find((item) => item.id === confirmingDraftId);
  const expectedSide = confirming?.side === "sell" ? "sell" : "buy";
  if (confirming && confirming.status === "pending" && type === expectedSide) {
    try {
      const result = confirmDraftIntoLedger({
        draft: confirming,
        etfs: state.etfs,
        buys: state.buys,
        sells: state.sells,
        executionDrafts: state.executionDrafts,
        plan: state.plan,
        tradingCost: state.plan?.trading_cost,
        price,
        shares,
        fee:
          Number.isFinite(feeInput) && feeInput >= 0 && els.buyFee?.value !== ""
            ? feeInput
            : null,
        date,
        note,
      });
      state.etfs = result.etfs;
      state.buys = result.buys;
      state.sells = result.sells;
      state.executionDrafts = result.executionDrafts;
      state.plan = result.plan;
      state.plan = settlePlanAfterDrafts({ plan: state.plan }) || state.plan;
      confirmingDraftId = null;
      editingTrade = null;
      persistWorkspace();
      if (els.buySubmit) els.buySubmit.textContent = type === "sell" ? "添加卖出" : "添加买入";
      if (els.buyCancelEdit) els.buyCancelEdit.hidden = true;
      if (els.buyPrice) els.buyPrice.value = "";
      if (els.buyShares) els.buyShares.value = "";
      if (els.buyFee) els.buyFee.value = "";
      if (els.buyNote) els.buyNote.value = "";
      renderBuys();
      syncHomeExecutionDrafts({ persist: true });
      renderExecDraftPanel();
      renderPoolAllocation();
      renderMetrics();
      renderRows();
      renderSidebarEtfs();
      if (state.selectedEtf) selectEtfChart(state.selectedEtf);
      if (els.buyFormStatus) {
        els.buyFormStatus.textContent = `已入账 ${symbol} ${date}`;
      }
      callRenderer("switchView", "home");
      return;
    } catch (error) {
      if (els.buyFormStatus) {
        els.buyFormStatus.textContent = `入账失败：${String(error).replace("Error: ", "")}`;
      }
      return;
    }
  }

  const wasEditing = Boolean(editingTrade);
  const previousSymbol = editingTrade
    ? ((editingTrade.type === "sell" ? state.sells : state.buys).find((item) => item.id === editingTrade.id) || {})
        .symbol
    : null;
  if (editingTrade) {
    if (editingTrade.type === "sell") state.sells = state.sells.filter((item) => item.id !== editingTrade.id);
    else state.buys = state.buys.filter((item) => item.id !== editingTrade.id);
  }
  const record = {
    id: editingTrade?.id || newTradeId(type, symbol, date),
    symbol,
    date,
    price,
    shares,
    fee:
      Number.isFinite(feeInput) && feeInput >= 0 && els.buyFee?.value !== ""
        ? feeInput
        : estimatedTradeFee(price * shares, state.plan?.trading_cost),
    note,
  };
  if (type === "sell") state.sells = upsertSell(state.sells, record);
  else state.buys = upsertBuy(state.buys, record);
  syncHoldingFromTrades(symbol);
  if (previousSymbol && previousSymbol !== symbol) syncHoldingFromTrades(previousSymbol);
  editingTrade = null;
  persistWorkspace();
  if (els.buySubmit) els.buySubmit.textContent = type === "sell" ? "添加卖出" : "添加买入";
  if (els.buyCancelEdit) els.buyCancelEdit.hidden = true;
  if (els.buyPrice) els.buyPrice.value = "";
  if (els.buyShares) els.buyShares.value = "";
  if (els.buyFee) els.buyFee.value = "";
  if (els.buyNote) els.buyNote.value = "";
  renderBuys();
  renderPoolAllocation();
  renderMetrics();
  renderRows();
  renderSidebarEtfs();
  if (state.selectedEtf) selectEtfChart(state.selectedEtf);
  if (els.buyFormStatus) {
    const label = type === "sell" ? "卖出" : "买入";
    els.buyFormStatus.textContent = wasEditing
      ? `已更新 ${symbol} ${date} 的${label}记录，并同步含费成本`
      : `已记录 ${symbol} ${date} ${label}，并同步含费成本`;
  }
}

export async function renderEtfPool({ refresh = false } = {}) {
  if (!els.etfRows) return;
  syncPlanForm();
  if (refresh) homeQuoteRefreshCooldownUntil = 0;
  await refreshQuotes(refresh);
  const execution = planExecutionContext({ plan: state.plan, holdings: currentPlanHoldings() });
  if (execution.reached && !state.plan.initial_build_completed_at) {
    state.plan.initial_build_completed_at = new Date().toISOString();
    persistWorkspace();
    if (els.planInitialCompleted) els.planInitialCompleted.checked = true;
  }
  renderInitialSummary();
  renderMetrics();
  syncHomeExecutionDrafts({ persist: true });
  renderHomeTodayCard();
  renderHomeReturnsPanel();
  renderExecDraftPanel();
  renderPoolAllocation();
  renderRows();
  renderBuys();
  renderSidebarEtfs();
  if (els.homeEmptyGuide) els.homeEmptyGuide.hidden = state.etfs.length > 0;
}

export function renderSidebarEtfs() {
  if (!els.sidebarEtfList) return;
  if (els.sidebarPoolCount) els.sidebarPoolCount.textContent = String(state.etfs.length);
  if (!state.etfs.length) {
    els.sidebarEtfList.innerHTML = `<p class="sidebar-etf-empty muted">计划为空，去「定投计划」添加</p>`;
    return;
  }
  const activeSymbol = state.analysisSymbol;
  const allocMap = state.lastPoolAllocBySymbol || {};
  els.sidebarEtfList.innerHTML = state.etfs
    .map((entry) => {
      const quote = state.quotesBySymbol[entry.symbol];
      const name = etfDisplayName(entry, quote);
      const shortLabel = etfShortLabel(name, entry.symbol);
      const change = quote?.change_pct;
      const changeClass = change > 0 ? "up" : change < 0 ? "down" : "";
      const active = activeSymbol === entry.symbol ? " active" : "";
      const fullIndex = analysisIsFullIndex(appConfig, entry.symbol);
      const target = Number(entry.target_weight) || 0;
      const alloc = allocMap[entry.symbol];
      const allocText =
        alloc?.amount > 0 ? money(alloc.amount) : alloc?.chip ? alloc.chip : "";
      const label = `${name}（${entry.symbol}）${target ? ` · 目标 ${target}%` : ""}${
        allocText ? ` · ${allocText}` : ""
      }${fullIndex ? "" : " · ETF 口径"}`;
      return `
        <div class="sidebar-etf-item${active}" data-symbol="${escapeAttr(entry.symbol)}">
          <span class="sidebar-etf-handle" draggable="true" title="拖动排序" aria-label="拖动排序">⋮⋮</span>
          <button
            class="sidebar-etf-button"
            type="button"
            data-analyze="${escapeAttr(entry.symbol)}"
            title="${escapeAttr(label)}"
            aria-label="${escapeAttr(label)}"
          >
            <span class="sidebar-etf-mark" aria-hidden="true">${escapeHtml(shortLabel)}</span>
            <span class="sidebar-etf-name">
              <strong>${escapeHtml(name)}</strong>
              <em>${escapeHtml(entry.symbol)}${allocText ? ` · ${escapeHtml(allocText)}` : target ? ` · ${target}%` : ""}</em>
            </span>
            <span class="sidebar-etf-meta ${changeClass}">
              ${change != null ? `${signed(change)}%` : "—"}
            </span>
          </button>
        </div>
      `;
    })
    .join("");

  els.sidebarEtfList.querySelectorAll("[data-analyze]").forEach((button) => {
    button.addEventListener("click", () => openAnalysis(button.dataset.analyze));
  });
  bindDragReorder(els.sidebarEtfList, {
    itemSelector: ".sidebar-etf-item[data-symbol]",
    handleSelector: ".sidebar-etf-handle",
  });
}

registerRenderers({ renderEtfPool, renderSidebarEtfs });
