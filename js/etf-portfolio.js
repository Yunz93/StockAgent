/**
 * ETF 池市值 / 行指标计算（无 DOM）。
 */

import { state } from "./state.js";
import { money, signed } from "./utils.js";

export function entryMetrics(entry, quotesBySymbol = state.quotesBySymbol) {
  const quote = quotesBySymbol?.[entry.symbol];
  const price = quote?.price;
  const shares = Math.max(0, Number(entry.shares) || 0);
  const cost = Math.max(0, Number(entry.cost) || 0);
  // 有行情即参与统计：份额为 0 时市值 / 权重记 0，而不是缺省
  const value = price != null ? price * shares : null;
  // 成本未填（0）且已有份额时不把浮盈当成「全额盈利」
  const costValue =
    price != null && (cost > 0 || shares === 0) ? cost * shares : null;
  const pnl = value != null && costValue != null ? value - costValue : null;
  const pnlPct = pnl != null && costValue > 0 ? (pnl / costValue) * 100 : null;
  return { quote, price, value, costValue, pnl, pnlPct, shares, cost };
}

export function portfolioTotals(etfs = state.etfs, quotesBySymbol = state.quotesBySymbol) {
  let totalValue = 0;
  let totalCost = 0;
  let held = 0;
  let quoted = 0;
  (etfs || []).forEach((entry) => {
    const { value, costValue, shares } = entryMetrics(entry, quotesBySymbol);
    if (value != null) {
      totalValue += value;
      quoted += 1;
      if (shares > 0) held += 1;
    }
    if (costValue != null) totalCost += costValue;
  });
  return { totalValue, totalCost, held, quoted };
}

function resolveIndexMeta(entry, analysisRegistry = {}, analysisCache = {}) {
  const symbol = entry?.symbol || "";
  const reg = analysisRegistry[symbol] || {};
  const cached = analysisCache[symbol] || {};
  const indexCode = String(reg.index_code || cached.index_code || "").trim();
  const indexName = String(reg.index_name || cached.index_name || "").trim();
  if (indexCode || indexName) {
    return {
      indexCode: indexCode || indexName,
      indexName: indexName || indexCode,
    };
  }
  return {
    indexCode: `etf:${symbol || "unknown"}`,
    indexName: entry?.name || symbol || "未归类",
  };
}

function summarizeBucket(rows) {
  let marketValue = 0;
  let costValue = 0;
  let hasValue = false;
  let hasCost = false;
  for (const row of rows) {
    if (row.marketValue != null) {
      marketValue += row.marketValue;
      hasValue = true;
    }
    if (row.costValue != null) {
      costValue += row.costValue;
      hasCost = true;
    }
  }
  const pnl = hasValue && hasCost ? marketValue - costValue : null;
  const pnlPct = pnl != null && costValue > 0 ? (pnl / costValue) * 100 : null;
  return {
    marketValue: hasValue ? marketValue : null,
    costValue: hasCost ? costValue : null,
    pnl,
    pnlPct,
    shares: rows.reduce((sum, row) => sum + (Number(row.shares) || 0), 0),
  };
}

/**
 * 历史收益汇总：组合合计 + 按指数分组（同指数多只 ETF 合并）。
 */
export function portfolioReturnsByIndex({
  etfs = state.etfs,
  quotesBySymbol = state.quotesBySymbol,
  analysisRegistry = {},
  analysisCache = {},
} = {}) {
  const groups = new Map();
  for (const entry of etfs || []) {
    const metrics = entryMetrics(entry, quotesBySymbol);
    if (!(metrics.shares > 0) && !(metrics.costValue > 0)) continue;
    const { indexCode, indexName } = resolveIndexMeta(entry, analysisRegistry, analysisCache);
    if (!groups.has(indexCode)) {
      groups.set(indexCode, {
        indexCode,
        indexName,
        etfs: [],
      });
    }
    const group = groups.get(indexCode);
    if (!group.indexName && indexName) group.indexName = indexName;
    group.etfs.push({
      symbol: entry.symbol,
      name: entry.name || entry.symbol,
      shares: metrics.shares,
      marketValue: metrics.value,
      costValue: metrics.costValue,
      pnl: metrics.pnl,
      pnlPct: metrics.pnlPct,
      price: metrics.price,
      cost: metrics.cost,
    });
  }

  const indices = [...groups.values()]
    .map((group) => {
      const summary = summarizeBucket(group.etfs);
      return {
        indexCode: group.indexCode,
        indexName: group.indexName || group.indexCode,
        ...summary,
        etfs: group.etfs.sort(
          (a, b) => (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0),
        ),
      };
    })
    .sort((a, b) => (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0));

  const total = summarizeBucket(indices.flatMap((row) => row.etfs));
  return {
    total: {
      ...total,
      heldCount: indices.reduce((sum, row) => sum + row.etfs.length, 0),
      indexCount: indices.length,
    },
    indices,
  };
}

/** 概览首屏一行摘要，避免四张指标卡占满视口。 */
export function overviewGlanceLine({
  etfs = state.etfs,
  quotesBySymbol = state.quotesBySymbol,
  capitalBase = 0,
} = {}) {
  const { totalValue, totalCost, held, quoted } = portfolioTotals(etfs, quotesBySymbol);
  const pnl = totalCost ? totalValue - totalCost : null;
  const pnlPct = totalCost ? ((totalValue - totalCost) / totalCost) * 100 : null;
  const poolPct = capitalBase > 0 && totalValue > 0 ? (totalValue / capitalBase) * 100 : null;
  const bits = [`${(etfs || []).length} 只 · 持仓 ${held}`];
  if (quoted) bits.push(`市值 ${money(totalValue)}`);
  if (poolPct != null) bits.push(`池总仓 ${poolPct.toFixed(1)}%`);
  else if (capitalBase > 0) bits.push("池总仓 0%");
  if (pnl != null) {
    bits.push(`盈亏 ${money(pnl)}${pnlPct != null ? `（${signed(pnlPct, 1)}%）` : ""}`);
  }
  return bits.join(" · ");
}
