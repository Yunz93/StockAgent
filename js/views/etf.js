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
import { currentPoolAllocationResult, poolAllocationHtml } from "../pool-alloc.js";
import {
  buildPortfolioReviewBaseline,
  isPortfolioAiReady,
} from "../ai-portfolio.js";
import { ensurePoolAnalysisPrefetch } from "../analysis-cache.js";
import {
  buildExecutionDraftsFromAllocation,
  executionDraftSummary,
  settleCashReserveOnPeriodComplete,
  updateExecutionDraft,
} from "../execution-drafts.js";
import { normalizeTradingCost, upsertBuy, upsertSell } from "../workspace_model.js";
import { ADD_PLAN_PRESETS, normalizeAddPlanConfig } from "../add-plan.js";
import { estimatedTradeFee, holdingFromTrades, planExecutionContext } from "../decision-support.js";
import { callRenderer, openAnalysis, registerRenderers } from "./render.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  normalizeStrategyConfig,
  normalizeStrategyId,
  STRATEGY_PRESETS,
  strategySummary,
} from "../strategy.js";
import { entryMetrics, overviewGlanceLine, portfolioTotals } from "../etf-portfolio.js";
import { confirmDraftIntoLedger, settlePlanAfterDrafts } from "../trade-apply.js";

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
            : `数据更新于 ${payload.updated_at || "—"}${payload.warning ? ` · ${payload.warning}` : ""}`,
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
    els.planInitialSummary.textContent = "";
    return;
  }
  if (execution.markedComplete || execution.reached) {
    els.planInitialSummary.textContent =
      `目标 ${money(execution.targetAmount)} · 当前 ${money(execution.currentValue)} · 已完成`;
    return;
  }
  els.planInitialSummary.textContent =
    `目标 ${money(execution.targetAmount)} · 分 ${execution.initialMonths} 个月` +
    ` · 每月约 ${money(execution.monthlyInstallment)} · 尚缺 ${money(execution.initialGap)}` +
    ` · 本期 ${money(execution.budget)}`;
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
  };
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
    renderPoolAllocation();
    return;
  }
  state.aiPortfolioReview = { status: "loading" };
  renderPoolAllocation();
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
  renderPoolAllocation();
}

function bindDraftActions(root) {
  if (!root) return;
  root.querySelectorAll("[data-generate-exec-drafts]").forEach((button) => {
    button.addEventListener("click", () => {
      state.executionDrafts = buildExecutionDraftsFromAllocation();
      persistWorkspace();
      renderPoolAllocation();
      renderExecDraftPanel();
      const summary = executionDraftSummary();
      if (summary.pending > 0) {
        activateHomeExec();
      } else if (els.poolAllocPanel) {
        const note = document.createElement("p");
        note.className = "muted pool-alloc-note";
        note.textContent = "本期无可执行整手";
        els.poolAllocPanel.querySelector(".pool-alloc-block")?.appendChild(note);
      }
    });
  });
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
}

function confirmExecutionDraft(id) {
  const draft = (state.executionDrafts || []).find((item) => item.id === id);
  if (!draft || draft.status !== "pending") return;
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
  if (els.buySubmit) els.buySubmit.textContent = "确认入账";
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
  applyCashReserveSettlement();
  persistWorkspace();
  renderPoolAllocation();
  renderExecDraftPanel();
}

function renderExecDraftPanel() {
  if (!els.execDraftPanel) return;
  const summary = executionDraftSummary();
  if (!summary.drafts.length) {
    els.execDraftPanel.hidden = true;
    els.execDraftPanel.innerHTML = "";
    return;
  }
  const headerParts = [];
  if (summary.pending > 0) headerParts.push(`待执行 ${summary.pending} 笔`);
  if (summary.executed > 0) headerParts.push(`已执行 ${money(summary.executed)}`);
  if (summary.drafts.length > 1) headerParts.push(`合计建议 ${money(summary.suggested)}`);
  if (!headerParts.length) headerParts.push("已处理完毕");
  els.execDraftPanel.hidden = false;
  els.execDraftPanel.innerHTML = `
    <div class="panel-heading">
      <div>
        <h3 class="section-title">本期执行清单</h3>
        <p class="muted">${headerParts.join(" · ")}</p>
      </div>
    </div>
    <div class="exec-draft-list">
      ${summary.drafts
        .map((draft) => {
          const statusLabel =
            draft.status === "confirmed" ? "已入账" : draft.status === "skipped" ? "已跳过" : "待执行";
          const side = draft.side === "sell" ? "sell" : "buy";
          const sideLabel = side === "sell" ? "卖出" : "买入";
          const actions =
            draft.status === "pending"
              ? `<span class="exec-draft-actions">
                  <button class="primary-button compact" type="button" data-draft-confirm="${escapeAttr(draft.id)}">确认入账</button>
                  <button class="ghost-button compact" type="button" data-draft-skip="${escapeAttr(draft.id)}">跳过</button>
                </span>`
              : `<span class="muted">${escapeHtml(statusLabel)}${draft.skip_reason ? ` · ${escapeHtml(draft.skip_reason)}` : ""}</span>`;
          const orderAmount = (Number(draft.shares) || 0) * (Number(draft.price) || 0);
          return `<div class="exec-draft-row${side === "sell" ? " is-sell" : ""}">
            <div class="exec-draft-main">
              <span class="trade-type ${side}">${sideLabel}</span>
              <strong>${escapeHtml(draft.name || draft.symbol)}</strong>
              <span class="muted">${escapeHtml(draft.symbol)}</span>
            </div>
            <div class="exec-draft-meta">
              <span>${draft.shares.toLocaleString("zh-CN")} 份 × ${money(draft.price, "CNY", 3)} ≈ ${money(orderAmount)}</span>
              <span>费 ${money(draft.fee)}</span>
            </div>
            ${actions}
          </div>`;
        })
        .join("")}
    </div>
  `;
  bindDraftActions(els.execDraftPanel);
}

function renderPoolAllocation() {
  if (!els.poolAllocPanel) return;
  els.poolAllocPanel.innerHTML = poolAllocationHtml({ clickable: true });
  els.poolAllocPanel.querySelectorAll("[data-analyze]").forEach((button) => {
    button.addEventListener("click", () => openAnalysis(button.dataset.analyze));
  });
  bindDraftActions(els.poolAllocPanel);
  renderSidebarEtfs();
  ensurePoolAnalysisPrefetch({
    onUpdate: () => {
      if (!els.poolAllocPanel || (state.activeView !== "etf" && state.activeView !== "home")) return;
      els.poolAllocPanel.innerHTML = poolAllocationHtml({ clickable: true });
      els.poolAllocPanel.querySelectorAll("[data-analyze]").forEach((button) => {
        button.addEventListener("click", () => openAnalysis(button.dataset.analyze));
      });
      bindDraftActions(els.poolAllocPanel);
      renderSidebarEtfs();
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
      renderPoolAllocation();
      renderMetrics();
      renderRows();
      renderSidebarEtfs();
      if (state.selectedEtf) selectEtfChart(state.selectedEtf);
      if (els.buyFormStatus) {
        els.buyFormStatus.textContent = `已入账 ${symbol} ${date}`;
      }
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
  await refreshQuotes(refresh);
  const execution = planExecutionContext({ plan: state.plan, holdings: currentPlanHoldings() });
  if (execution.reached && !state.plan.initial_build_completed_at) {
    state.plan.initial_build_completed_at = new Date().toISOString();
    persistWorkspace();
    if (els.planInitialCompleted) els.planInitialCompleted.checked = true;
  }
  renderInitialSummary();
  renderMetrics();
  renderPoolAllocation();
  renderRows();
  renderBuys();
  renderSidebarEtfs();
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
