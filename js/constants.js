export const CURRENCY = {
  CNY: "¥",
};

export const PAGE_TITLES = {
  home: "今日执行",
  dividend: "分析",
  etf: "定投计划",
  settings: "设置",
};

/** 种子池目标仓位（%），与后端 DEFAULT_TARGET_WEIGHTS 对齐；同指数不双开 */
export const DEFAULT_TARGET_WEIGHTS = {
  "563360": 20,
  "513390": 15,
  "513500": 15,
  "512890": 35,
  "513010": 10,
  "159937": 5,
};

export const PLAN_CADENCE_LABELS = {
  weekly: "每周",
  biweekly: "每两周",
  monthly: "每月",
};

/** ETF 走势可见区间（相对最新交易日往前推） */
export const INDEX_CHART_RANGE_WINDOWS = {
  "1w": { days: 7 },
  "1m": { months: 1 },
  "3m": { months: 3 },
  "6m": { months: 6 },
  "1y": { months: 12 },
  "3y": { months: 36 },
  "5y": { months: 60 },
  max: null,
};

export const INDEX_CHART_RANGE_LABELS = {
  "1w": "1周",
  "1m": "1月",
  "3m": "3月",
  "6m": "6M",
  "1y": "1Y",
  "3y": "3Y",
  "5y": "5Y",
  max: "全部",
};

export const THEME_KEY = "stockagent.theme";
export const SIDEBAR_KEY = "stockagent.sidebar";
/** 宽于该值才显示可收起的侧栏图标轨；更窄时改用抽屉导航。 */
export const SIDEBAR_COLLAPSE_MIN = 1181;
/** 含平板：抽屉导航上限（与 styles.css 侧栏抽屉断点一致）。 */
export const MOBILE_SIDEBAR_MAX = 1180;
export const WORKSPACE_CACHE_KEY = "stockagent.workspace.cache";
export const WORKSPACE_SYNC_DEBOUNCE_MS = 500;
export const ETF_QUOTE_TTL_MS = 60_000;
/** 前端分析缓存 TTL，与后端 DIVIDEND_CACHE 默认 1800s 对齐 */
export const ANALYSIS_CACHE_TTL_MS = 30 * 60_000;

export const GRADE_GUIDE =
  "A 很有吸引力 · B 偏有利 · C 中性 · D 偏弱 · E 很弱";

/** 定投池内 ETF 均可分析；无指数映射时后端走 ETF 行情兜底。 */
export function analysisSupported(appConfig, symbol) {
  if (!symbol) return true;
  const support = appConfig?.etf?.analysis_support?.[symbol];
  if (support && Object.prototype.hasOwnProperty.call(support, "supported")) {
    return Boolean(support.supported);
  }
  return true;
}

/** 是否为完整指数估值（相对 ETF 行情兜底）。 */
export function analysisIsFullIndex(appConfig, symbol) {
  if (!symbol) return true;
  const support = appConfig?.etf?.analysis_support?.[symbol];
  if (support?.mode) return support.mode !== "etf_proxy";
  const registry = appConfig?.etf?.analysis_registry || {};
  return Boolean(registry[symbol]?.index_code);
}
