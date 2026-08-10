/**
 * 卖出纪律：估值止盈 + 年度硬再平衡（纯函数，不落库、不下单）。
 *
 * holdings 结构对齐 pool-alloc.buildPoolHoldingsForAllocation：
 *   { symbol, name, targetWeight, actualWeight, marketValue, pePct, grade, assetClass, shares? }
 *
 * 建仓期（phase=initial）：
 * - 未超过绝对目标金额时，不得因相对超配卖出
 * - 禁用一月年度再平衡
 * - 估值止盈仅卖出绝对超额部分（current - absolute_target）
 */

import { estimatedTradeFee } from "./decision-support.js";
import { normalizeTradingCost } from "./workspace_model.js";

/** 卖出金额：使卖后权重逼近 sellToWeight（百分点）。 */
export function sellAmountToWeight({ marketValue, totalValue, sellToWeight } = {}) {
  const m = Number(marketValue);
  const v = Number(totalValue);
  const w = Number(sellToWeight) / 100;
  if (!(m > 0) || !(v > 0) || !(w >= 0) || w >= 1) return 0;
  if (m / v <= w + 1e-12) return 0;
  // (M - S) / (V - S) = w  ⇒  S = (M - wV) / (1 - w)
  const amount = (m - w * v) / (1 - w);
  return amount > 0 ? amount : 0;
}

function lotFloorShares(amount, price, lotSize, maxShares) {
  const quote = Number(price);
  const lot = Math.max(1, Math.round(Number(lotSize) || 100));
  if (!(quote > 0) || !(amount > 0)) return 0;
  let shares = Math.floor(amount / quote / lot) * lot;
  const held = Number.isFinite(Number(maxShares)) ? Math.max(0, Number(maxShares)) : Infinity;
  if (Number.isFinite(held)) {
    shares = Math.min(shares, Math.floor(held / lot) * lot);
  }
  return shares > 0 ? shares : 0;
}

function heldShares(item, price) {
  const explicit = Number(item.shares);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const mv = Number(item.marketValue);
  const quote = Number(price);
  if (mv > 0 && quote > 0) return mv / quote;
  return 0;
}

function quotePrice(quotes, symbol) {
  const row = quotes && typeof quotes === "object" ? quotes[symbol] : null;
  const price = Number(row?.price);
  return price > 0 ? price : 0;
}

function isRich(item) {
  const pe = Number(item.pePct);
  const pe01 = Number.isFinite(pe) ? (pe <= 1 ? pe : pe / 100) : null;
  const grade = String(item.grade || "").toUpperCase();
  return (pe01 != null && pe01 > 0.85) || grade === "E";
}

/**
 * @returns {Array<object>}
 */
export function buildRebalanceSellSuggestions({
  holdings = [],
  quotes = {},
  plan = {},
  now = new Date(),
  phase = "recurring",
  absoluteTargetsBySymbol = {},
} = {}) {
  const tradingCost = normalizeTradingCost(plan?.trading_cost);
  const isJanuary = now instanceof Date && !Number.isNaN(now.getTime()) && now.getMonth() === 0;
  const isInitial = String(phase || "").toLowerCase() === "initial";
  const rows = Array.isArray(holdings) ? holdings : [];
  const totalValue = rows.reduce((sum, item) => sum + Math.max(0, Number(item.marketValue) || 0), 0);
  if (!(totalValue > 0)) return [];

  const suggestions = [];
  for (const item of rows) {
    const target = Number(item.targetWeight);
    const actual = Number(item.actualWeight);
    if (!(target >= 0) || !Number.isFinite(actual)) continue;
    const drift = actual - target;
    if (!(drift > 0)) continue;

    const mv = Math.max(0, Number(item.marketValue) || 0);
    const absTarget = Math.max(
      0,
      Number(
        absoluteTargetsBySymbol?.[item.symbol] ??
          item.absoluteTargetAmount ??
          item.absolute_target_amount,
      ) || 0,
    );
    const cls = String(item.assetClass || "").trim().toLowerCase();
    const rich = isRich(item);

    if (isInitial) {
      // 未超过绝对目标：禁止因相对权重卖出
      if (!(absTarget > 0) || !(mv > absTarget + 1e-9)) continue;
      const excess = mv - absTarget;
      const driftOk = cls === "equity_growth" ? drift > 15 : drift > 10;
      if (!(rich && driftOk)) continue;

      const price = quotePrice(quotes, item.symbol);
      if (!(price > 0)) continue;
      const shares = lotFloorShares(excess, price, tradingCost.lot_size, heldShares(item, price));
      if (!(shares > 0)) continue;
      // 不得卖到绝对目标以下：整手后仍需 MV - shares*price >= absTarget - epsilon
      let safeShares = shares;
      while (safeShares >= tradingCost.lot_size) {
        const after = mv - safeShares * price;
        if (after + 1e-6 >= absTarget) break;
        safeShares -= tradingCost.lot_size;
      }
      if (!(safeShares > 0)) continue;
      const suggested_amount = Math.round(safeShares * price * 100) / 100;
      const fee = Math.round(estimatedTradeFee(suggested_amount, tradingCost) * 100) / 100;
      suggestions.push({
        symbol: item.symbol,
        name: item.name || item.symbol,
        side: "sell",
        rule: "valuation_trim_absolute",
        band: "估值止盈",
        hint: `建仓期绝对超额 ${suggested_amount.toFixed(0)}，止盈至目标金额`,
        suggested_amount,
        price: Math.round(price * 1e6) / 1e6,
        shares: safeShares,
        fee,
        targetWeight: target,
        actualWeight: actual,
        sellToWeight: target,
        drift: Math.round(drift * 10) / 10,
        absoluteTargetAmount: absTarget,
      });
      continue;
    }

    const candidates = [];
    if (cls === "equity_growth") {
      if (drift > 15) {
        candidates.push({
          sellToWeight: target + 5,
          rule: "valuation_trim",
          band: "估值止盈",
          hint: `高出目标 ${drift.toFixed(1)}%，成长类漂移止盈`,
        });
      }
    } else if (drift > 10 && rich) {
      candidates.push({
        sellToWeight: target + 5,
        rule: "valuation_trim",
        band: "估值止盈",
        hint: `高出目标 ${drift.toFixed(1)}% 且估值偏贵，止盈至目标+5%`,
      });
    }
    if (isJanuary && drift > 10) {
      candidates.push({
        sellToWeight: target,
        rule: "annual_rebalance",
        band: "年度再平衡",
        hint: `1 月硬再平衡：高出目标 ${drift.toFixed(1)}%，卖回目标仓位`,
      });
    }
    if (!candidates.length) continue;

    let best = null;
    for (const candidate of candidates) {
      const amount = sellAmountToWeight({
        marketValue: item.marketValue,
        totalValue,
        sellToWeight: candidate.sellToWeight,
      });
      if (!(amount > 0)) continue;
      if (
        !best ||
        amount > best.amount + 1e-9 ||
        (Math.abs(amount - best.amount) <= 1e-9 && candidate.rule === "annual_rebalance")
      ) {
        best = { ...candidate, amount };
      }
    }
    if (!best) continue;

    const price = quotePrice(quotes, item.symbol);
    if (!(price > 0)) continue;
    const shares = lotFloorShares(best.amount, price, tradingCost.lot_size, heldShares(item, price));
    if (!(shares > 0)) continue;
    const suggested_amount = Math.round(shares * price * 100) / 100;
    const fee = Math.round(estimatedTradeFee(suggested_amount, tradingCost) * 100) / 100;

    suggestions.push({
      symbol: item.symbol,
      name: item.name || item.symbol,
      side: "sell",
      rule: best.rule,
      band: best.band,
      hint: best.hint,
      suggested_amount,
      price: Math.round(price * 1e6) / 1e6,
      shares,
      fee,
      targetWeight: target,
      actualWeight: actual,
      sellToWeight: best.sellToWeight,
      drift: Math.round(drift * 10) / 10,
    });
  }

  suggestions.sort((a, b) => b.suggested_amount - a.suggested_amount || a.symbol.localeCompare(b.symbol));
  return suggestions;
}
