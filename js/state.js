export let appConfig = null;
export function setAppConfig(nextConfig) {
  appConfig = nextConfig;
}

export const state = {
  // 定投计划内 ETF：[{symbol, name, shares, cost, target_weight, note}]
  etfs: [],
  // 买入记录：[{id, symbol, date, price, shares, fee, note}]
  buys: [],
  // 卖出记录：[{id, symbol, date, price, shares, fee, note}]
  sells: [],
  plan: {
    name: "默认定投计划",
    amount: 2000,
    capital_base: 0,
    initial_target_pct: 0,
    initial_months: 1,
    initial_build_started_at: null,
    initial_build_completed_at: null,
    cadence: "monthly",
    day: 1,
    note: "",
    strategy: "valuation",
    strategy_config: {
      pe_bands: [
        { max_pct: 20, mult: 1.5, label: "低估区" },
        { max_pct: 40, mult: 1.2, label: "偏低区" },
        { max_pct: 60, mult: 1.0, label: "正常区" },
        { max_pct: 80, mult: 0.5, label: "偏高区" },
        { max_pct: 100, mult: 0, label: "高估区" },
      ],
      grade_mult: { A: 1.5, B: 1.2, C: 1.0, D: 0.5, E: 0 },
      use_rebalance: true,
      sentiment: {
        enabled: true,
        mode: "overlay",
        extremes_only: true,
        extreme_low: 25,
        extreme_high: 75,
        apply_to: ["valuation", "grade", "custom"],
        bands: [
          { max_score: 20, mult: 1.3, label: "极端恐慌" },
          { max_score: 40, mult: 1.15, label: "偏恐慌" },
          { max_score: 60, mult: 1.0, label: "中性" },
          { max_score: 80, mult: 0.75, label: "偏热" },
          { max_score: 100, mult: 0.4, label: "极端狂热" },
        ],
        market_by_asset_class: {
          dividend: "A",
          equity_core: "A",
          equity_growth: "auto",
          commodity: "off",
          bond: "off",
        },
      },
    },
    strategy_overrides: {},
    add_plan: { enabled: true, anchor: "price", levels: null },
    trading_cost: {
      min_commission: 5,
      commission_rate_pct: 0.03,
      max_fee_ratio_pct: 0.25,
      lot_size: 100,
    },
    pending_orders: {},
    cash_reserve: { balance: 0, history: [] },
    execution_policy: {
      premium_warn_pct: 2,
      premium_block_pct: 5,
      discount_warn_pct: 2,
      discount_block_pct: 5,
      spread_warn_pct: 0.2,
      spread_block_pct: 0.3,
      quote_max_age_minutes: 15,
      pe_hysteresis_pp: 3,
      allow_warning_override: true,
    },
    signal_snapshots: {},
  },
  quotesBySymbol: {},
  quotesMeta: null,
  quotesFetchedAt: 0,
  selectedEtf: null,
  priceRange: "1y",
  indexChartRange: "1y",
  /** 首页收益走势：day | week | month | year */
  homeEquityPeriod: "month",
  /** 首页收益走势历史价缓存：{ status, fingerprint, range, bySymbol, error, fetchedAt } */
  homeEquityHistory: {
    status: "idle",
    fingerprint: "",
    range: "5y",
    bySymbol: {},
    error: null,
    fetchedAt: 0,
  },
  activeView: "home",
  // 分析页当前 ETF 代码；由侧栏池条目打开
  analysisSymbol: null,
  analysisCache: {}, // symbolKey -> payload
  // 全池分析预取进度：idle | running | done
  analysisPrefetch: { status: "idle", total: 0, done: 0, current: null },
  // 本期执行草稿：[{id, period, symbol, name, suggested_amount, price, shares, fee, date, status, skip_reason?}]
  executionDrafts: [],
  execDraftsMeta: { synced_at: null, fingerprint: "", signal_snapshot_id: null },
  decisionHistory: [],
  // 最近一次全池分配摘要：symbol -> { amount, chip }
  lastPoolAllocBySymbol: {},
  aiReviews: {}, // symbol -> { status, result?, error? }
  // 全池 AI 审视：{ status: idle|loading|ready|error, result?, error? }
  aiPortfolioReview: { status: "idle" },
  marketSentiment: null,
  marketSentimentFetchedAt: 0,
  marketSentimentError: null,
  goldMacro: null,
  goldMacroFetchedAt: 0,
  goldMacroError: null,
  workspaceSync: {
    status: "idle",
    updatedAt: null,
    error: null,
    source: "local",
  },
};

export const workspaceRuntime = {
  saveTimer: null,
  saveInFlight: null,
  /** syncPlanForm 已把 state.plan 画进表单后才允许 beforeunload 回读，避免空表单冲掉已 hydrate 的计划。 */
  planFormReady: false,
};

/** /api/runtime 摘要：durableStorage=blob|local，ephemeralStorage 表示服务端不可持久。 */
export const runtimeInfo = {
  loaded: false,
  ephemeralStorage: false,
  durableStorage: "local",
  blobAuth: "",
  platform: "",
  mode: "server",
};

export function setRuntimeInfo(payload) {
  runtimeInfo.loaded = true;
  runtimeInfo.ephemeralStorage = Boolean(payload?.ephemeral_storage);
  runtimeInfo.durableStorage = payload?.durable_storage === "blob" ? "blob" : "local";
  runtimeInfo.blobAuth = payload?.blob_auth === "oidc" || payload?.blob_auth === "read_write"
    ? payload.blob_auth
    : "";
  runtimeInfo.platform = String(payload?.platform || "");
  runtimeInfo.mode = payload?.mode === "desktop" ? "desktop" : "server";
}

export const els = {};

export function initEls() {
  Object.assign(els, {
    pageTitle: document.querySelector("#pageTitle"),
    pageSubtitle: document.querySelector("#pageSubtitle"),
    pageSubtitleText: document.querySelector("#pageSubtitleText"),
    topSourceStatus: document.querySelector("#topSourceStatus"),
    themeToggle: document.querySelector("#themeToggle"),
    sidebarToggle: document.querySelector("#sidebarToggle"),
    mobileSidebarToggle: document.querySelector("#mobileSidebarToggle"),
    mobileSidebarClose: document.querySelector("#mobileSidebarClose"),
    sidebarBackdrop: document.querySelector("#sidebarBackdrop"),

    dividendStatus: document.querySelector("#dividendStatus"),
    dividendContent: document.querySelector("#dividendContent"),

    dcaPlanForm: document.querySelector("#dcaPlanForm"),
    planName: document.querySelector("#planName"),
    planAmount: document.querySelector("#planAmount"),
    planCapitalBase: document.querySelector("#planCapitalBase"),
    planInitialTargetPct: document.querySelector("#planInitialTargetPct"),
    planInitialMonths: document.querySelector("#planInitialMonths"),
    planInitialCompleted: document.querySelector("#planInitialCompleted"),
    planInitialSummary: document.querySelector("#planInitialSummary"),
    planMinCommission: document.querySelector("#planMinCommission"),
    planCommissionRatePct: document.querySelector("#planCommissionRatePct"),
    planMaxFeeRatioPct: document.querySelector("#planMaxFeeRatioPct"),
    planLotSize: document.querySelector("#planLotSize"),
    planCadence: document.querySelector("#planCadence"),
    planDay: document.querySelector("#planDay"),
    planNote: document.querySelector("#planNote"),
    planDayHint: document.querySelector("#planDayHint"),
    planStrategy: document.querySelector("#planStrategy"),
    planStrategyHint: document.querySelector("#planStrategyHint"),
    planSentimentEnabled: document.querySelector("#planSentimentEnabled"),
    planSentimentHint: document.querySelector("#planSentimentHint"),
    planStrategyCustom: document.querySelector("#planStrategyCustom"),
    planPeBands: document.querySelector("#planPeBands"),
    planGradeMult: document.querySelector("#planGradeMult"),
    planUseRebalance: document.querySelector("#planUseRebalance"),
    planAddPlan: document.querySelector("#planAddPlan"),
    planAddPlanEnabled: document.querySelector("#planAddPlanEnabled"),
    planAddPlanAnchor: document.querySelector("#planAddPlanAnchor"),
    planAddPlanPreset: document.querySelector("#planAddPlanPreset"),
    planAddPlanLevels: document.querySelector("#planAddPlanLevels"),
    planAddPlanPresetHint: document.querySelector("#planAddPlanPresetHint"),
    etfForm: document.querySelector("#etfForm"),
    etfSymbol: document.querySelector("#etfSymbol"),
    etfShares: document.querySelector("#etfShares"),
    etfCost: document.querySelector("#etfCost"),
    etfTargetWeight: document.querySelector("#etfTargetWeight"),
    etfFormStatus: document.querySelector("#etfFormStatus"),
    etfMetrics: document.querySelector("#etfMetrics"),
    overviewEmptyGuide: document.querySelector("#homeEmptyGuide"),
    homeEmptyGuide: document.querySelector("#homeEmptyGuide"),
    homeConfirmSheet: document.querySelector("#homeConfirmSheet"),
    homeTodayCard: document.querySelector("#homeTodayCard"),
    homeReturnsPanel: document.querySelector("#homeReturnsPanel"),
    etfRows: document.querySelector("#etfRows"),
    etfEmpty: document.querySelector("#etfEmpty"),
    importSeedPool: document.querySelector("#importSeedPool"),
    buyForm: document.querySelector("#buyForm"),
    tradeType: document.querySelector("#tradeType"),
    buySymbol: document.querySelector("#buySymbol"),
    buyDate: document.querySelector("#buyDate"),
    buyPrice: document.querySelector("#buyPrice"),
    buyShares: document.querySelector("#buyShares"),
    buyFee: document.querySelector("#buyFee"),
    buyNote: document.querySelector("#buyNote"),
    buySubmit: document.querySelector("#buySubmit"),
    buyCancelEdit: document.querySelector("#buyCancelEdit"),
    buyFormStatus: document.querySelector("#buyFormStatus"),
    buyFilterSymbol: document.querySelector("#buyFilterSymbol"),
    buyFilterType: document.querySelector("#buyFilterType"),
    buyFilterCount: document.querySelector("#buyFilterCount"),
    buyRows: document.querySelector("#buyRows"),
    buyEmpty: document.querySelector("#buyEmpty"),
    execDraftPanel: document.querySelector("#execDraftPanel"),
    etfRefresh: document.querySelector("#etfRefresh"),
    etfChartPanel: document.querySelector("#etfChartPanel"),
    etfChartTitle: document.querySelector("#etfChartTitle"),
    etfChartSummary: document.querySelector("#etfChartSummary"),
    etfChart: document.querySelector("#etfChart"),
    etfChartTooltip: document.querySelector("#etfChartTooltip"),
    sidebarEtfList: document.querySelector("#sidebarEtfList"),
    sidebarPoolCount: document.querySelector("#sidebarPoolCount"),

    settingsForm: document.querySelector("#settingsForm"),
    saveConfig: document.querySelector("#saveConfig"),
    settingsStatus: document.querySelector("#settingsStatus"),
    workspaceStatus: document.querySelector("#workspaceStatus"),
    exportWorkspace: document.querySelector("#exportWorkspace"),
    importWorkspace: document.querySelector("#importWorkspace"),
    importWorkspaceFile: document.querySelector("#importWorkspaceFile"),
    syncWorkspaceNow: document.querySelector("#syncWorkspaceNow"),
  });
}
