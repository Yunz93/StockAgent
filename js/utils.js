import { CURRENCY } from "./constants.js";

export function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const AI_PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
};

/** 设置页同款品牌写法：deepseek → DeepSeek。 */
export function aiProviderLabel(provider) {
  const id = String(provider || "").trim().toLowerCase();
  return AI_PROVIDER_LABELS[id] || String(provider || "").trim();
}

export function money(value, currency = "CNY", digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const fractionDigits = Number.isFinite(Number(digits)) ? Math.max(0, Math.min(8, Number(digits))) : 2;
  const factor = 10 ** fractionDigits;
  let amount = Math.round(Number(value) * factor) / factor;
  if (Object.is(amount, -0) || amount === 0) amount = 0;
  return `${CURRENCY[currency] || ""}${amount.toLocaleString("zh-CN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function signed(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}`;
}

export function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function normalizeEtfSymbol(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(6, "0").slice(-6);
}

/** 侧栏收起态可读缩写：优先从名称提炼，避免代码后三位。 */
const ETF_SHORT_LABEL_RULES = [
  { pattern: /A500|中证A500/i, label: "A500" },
  { pattern: /红利低波|红利/, label: "红利" },
  { pattern: /标普\s*500|标普|S\s*&\s*P\s*500|SP500/i, label: "标普" },
  { pattern: /纳指|纳斯达克/, label: "纳指" },
  { pattern: /恒生科技|恒科/, label: "恒科" },
  { pattern: /恒生/, label: "恒生" },
  { pattern: /黄金|Gold/i, label: "黄金" },
  { pattern: /沪深\s*300|沪深300/, label: "沪深" },
  { pattern: /中证\s*1000|中证1000/, label: "千指" },
  { pattern: /中证\s*500|中证500/, label: "中证" },
  { pattern: /创业板/, label: "创业" },
  { pattern: /科创\s*50|科创50/, label: "科创" },
  { pattern: /上证\s*50|上证50/, label: "上证" },
];

const FUND_MANAGER_SUFFIXES =
  /华泰柏瑞|易方达|博时|国泰|华夏|南方|嘉实|广发|工银瑞信|工银|汇添富|富国|鹏华|景顺长城|中欧|银华|天弘|华安|建信|招商|兴全|交银|平安|永赢|万家|泰康|摩根|施罗德/;

export function etfShortLabel(name, symbol = "") {
  const text = String(name || "").trim();
  if (text) {
    for (const rule of ETF_SHORT_LABEL_RULES) {
      if (rule.pattern.test(text)) return rule.label;
    }
    const core = text
      .replace(FUND_MANAGER_SUFFIXES, "")
      .replace(/ETF/gi, "")
      .replace(/联接|基金|指数/g, "")
      .replace(/\s+/g, "")
      .trim();
    const alnum = core.match(/[A-Za-z]+\d{2,4}|\d{2,4}[A-Za-z]+/);
    if (alnum) return alnum[0].slice(0, 4);
    const cjk = core.match(/[\u4e00-\u9fff]{1,2}/);
    if (cjk) return cjk[0];
    if (core) return core.slice(0, 4);
  }
  const code = String(symbol || "").replace(/\D/g, "");
  return code ? code.slice(-3) : "?";
}

/**
 * 侧栏/持仓显示名：计划名优先；若为空或仅为行情短名，则用 registry/种子池友好名。
 */
export function resolveEtfDisplayName({
  name,
  symbol,
  quoteName,
  registryName,
  seedName,
} = {}) {
  const stored = String(name || "").trim();
  const friendly = String(registryName || seedName || "").trim();
  const quote = String(quoteName || "").trim();
  const code = String(symbol || "").trim();

  if (friendly) {
    if (!stored || stored === quote) return friendly;
    const storedCore = stored.replace(/ETF$/i, "");
    if (
      stored.length < friendly.length &&
      storedCore &&
      friendly.includes(storedCore)
    ) {
      return friendly;
    }
  }
  return stored || friendly || quote || code;
}
