/**
 * 组合收益走势：由买卖记录 + 历史收盘价重建日度市值曲线，并按日/周/月/年重采样。
 */

import { holdingFromTrades } from "./decision-support.js";

export const HOME_EQUITY_PERIODS = [
  { id: "day", label: "日度", maxPoints: 120 },
  { id: "week", label: "周度", maxPoints: 160 },
  { id: "month", label: "月度", maxPoints: 120 },
  { id: "year", label: "年度", maxPoints: 40 },
];

export function symbolsForEquityCurve(etfs = [], buys = [], sells = []) {
  const set = new Set();
  for (const entry of etfs || []) {
    if (entry?.symbol) set.add(String(entry.symbol));
  }
  for (const row of buys || []) {
    if (row?.symbol) set.add(String(row.symbol));
  }
  for (const row of sells || []) {
    if (row?.symbol) set.add(String(row.symbol));
  }
  return [...set];
}

export function equityDataFingerprint(etfs = [], buys = [], sells = []) {
  return JSON.stringify({
    e: (etfs || []).map((row) => [row.symbol, Number(row.shares) || 0, Number(row.cost) || 0]),
    b: (buys || []).map((row) => [
      row.id,
      row.symbol,
      row.date,
      Number(row.shares) || 0,
      Number(row.price) || 0,
      Number(row.fee) || 0,
    ]),
    s: (sells || []).map((row) => [
      row.id,
      row.symbol,
      row.date,
      Number(row.shares) || 0,
      Number(row.price) || 0,
      Number(row.fee) || 0,
    ]),
  });
}

export function holdingAsOf(buys, sells, symbol, asOfDate) {
  const date = String(asOfDate || "");
  const filteredBuys = (buys || []).filter((row) => String(row.date || "") <= date);
  const filteredSells = (sells || []).filter((row) => String(row.date || "") <= date);
  return holdingFromTrades(filteredBuys, filteredSells, symbol);
}

function symbolHasAnyTrades(buys, sells, symbol) {
  return (
    (buys || []).some((row) => row?.symbol === symbol) ||
    (sells || []).some((row) => row?.symbol === symbol)
  );
}

/** 组合最早一笔买卖日期；无交易时返回 null。 */
export function earliestTradeDate(buys = [], sells = []) {
  let earliest = null;
  for (const row of [...(buys || []), ...(sells || [])]) {
    const date = String(row?.date || "");
    if (!date) continue;
    if (earliest == null || date < earliest) earliest = date;
  }
  return earliest;
}

/** ISO 周键：YYYY-Www */
export function periodBucketKey(dateStr, period = "month") {
  const raw = String(dateStr || "");
  if (period === "day") return raw;
  const parts = raw.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!(year > 0) || !(month > 0) || !(day > 0)) return raw;
  if (period === "month") return `${year}-${String(month).padStart(2, "0")}`;
  if (period === "year") return String(year);
  if (period === "week") {
    const date = new Date(Date.UTC(year, month - 1, day));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const isoYear = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
  }
  return raw;
}

export function resampleEquityCurve(points = [], period = "month") {
  if (!points.length) return [];
  if (period === "day") return points.slice();
  const buckets = new Map();
  for (const point of points) {
    const key = periodBucketKey(point.date, period);
    buckets.set(key, point);
  }
  return [...buckets.values()];
}

export function limitEquityPoints(points = [], period = "month") {
  const meta = HOME_EQUITY_PERIODS.find((item) => item.id === period);
  const maxPoints = meta?.maxPoints || 120;
  if (points.length <= maxPoints) return points;
  return points.slice(-maxPoints);
}

/**
 * 按交易日重建组合市值 / 浮动盈亏曲线。
 * - 有买卖记录的品种：严格按截至当日的台账推算份额（买入前为 0）。
 * - 无买卖记录的品种：仅从组合首笔交易日起按当前份额回溯；若全组合无交易，则只计入最后一个交易日。
 * 返回点：{ date, close(=pnl), marketValue, costValue, pnl }
 */
export function buildDailyEquityCurve({
  buys = [],
  sells = [],
  etfs = [],
  historyBySymbol = {},
} = {}) {
  const symbols = symbolsForEquityCurve(etfs, buys, sells);
  if (!symbols.length) return [];

  const traded = new Set(symbols.filter((symbol) => symbolHasAnyTrades(buys, sells, symbol)));
  const portfolioStart = earliestTradeDate(buys, sells);

  const rawBySymbol = {};
  const allDates = new Set();
  for (const symbol of symbols) {
    const payload = historyBySymbol[symbol];
    const points = Array.isArray(payload) ? payload : payload?.points || [];
    const map = new Map();
    for (const point of points) {
      const date = String(point?.date || "");
      const close = Number(point?.close);
      if (!date || !Number.isFinite(close)) continue;
      map.set(date, close);
      allDates.add(date);
    }
    rawBySymbol[symbol] = map;
  }

  const dates = [...allDates].sort();
  if (!dates.length) return [];
  const lastHistoryDate = dates[dates.length - 1];
  // 无任何交易时，禁止用当前份额回填整段历史
  const untradedStart = portfolioStart || lastHistoryDate;

  const filled = {};
  for (const symbol of symbols) {
    filled[symbol] = new Map();
    let last = null;
    for (const date of dates) {
      if (rawBySymbol[symbol].has(date)) last = rawBySymbol[symbol].get(date);
      if (last != null) filled[symbol].set(date, last);
    }
  }

  const etfBySymbol = Object.fromEntries((etfs || []).filter((row) => row?.symbol).map((row) => [row.symbol, row]));
  const curve = [];

  for (const date of dates) {
    if (portfolioStart && date < portfolioStart) continue;

    let marketValue = 0;
    let costValue = 0;
    let hasPosition = false;

    for (const symbol of symbols) {
      const price = filled[symbol].get(date);
      if (price == null) continue;

      let shares = 0;
      let positionCost = 0;
      if (traded.has(symbol)) {
        const ledger = holdingAsOf(buys, sells, symbol, date);
        shares = Number(ledger.shares) || 0;
        positionCost = Number(ledger.costValue) || 0;
      } else if (date >= untradedStart) {
        const entry = etfBySymbol[symbol];
        shares = Math.max(0, Number(entry?.shares) || 0);
        const cost = Math.max(0, Number(entry?.cost) || 0);
        positionCost = shares > 0 && cost > 0 ? shares * cost : 0;
      }

      if (!(shares > 0)) continue;
      marketValue += shares * price;
      costValue += positionCost;
      hasPosition = true;
    }

    if (!hasPosition) continue;
    const pnl = marketValue - costValue;
    curve.push({
      date,
      close: Math.round(pnl * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      costValue: Math.round(costValue * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
    });
  }

  return curve;
}

export function prepareEquityChartPoints(dailyPoints, period = "month") {
  return limitEquityPoints(resampleEquityCurve(dailyPoints, period), period);
}
