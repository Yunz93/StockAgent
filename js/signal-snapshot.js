/**
 * 月度信号快照：同一期内冻结 PE 档位 / 评分 / 情绪倍率。
 */

import { normalizeStrategyConfig, normalizeStrategyId } from "./strategy.js";
import { DEFAULT_PE_BANDS, dcaMultiplier } from "./strategy-multipliers.js";
import { normalizeExecutionPolicy } from "./execution-policy.js";

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e4) / 1e4;
}

function pePct01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n : n / 100;
}

function pePct100(value) {
  const p = pePct01(value);
  return p == null ? null : p * 100;
}

/** 根据 PE 分位落入的档位索引（0-based）。 */
export function peBandIndex(pePct, bands = DEFAULT_PE_BANDS) {
  const pct = pePct100(pePct);
  if (pct == null || !Array.isArray(bands) || !bands.length) return null;
  for (let i = 0; i < bands.length; i += 1) {
    if (pct <= Number(bands[i].max_pct)) return i;
  }
  return bands.length - 1;
}

/**
 * PE 分位滞回：恶化需越过边界 +hysteresis；改善需低于边界 -hysteresis。
 * @returns {{ pe_pct: number|null, band_index: number|null, band: string|null, mult: number|null }}
 */
export function applyPeHysteresis({
  pePct,
  previousBandIndex = null,
  bands = DEFAULT_PE_BANDS,
  hysteresisPp = 3,
} = {}) {
  const pct = pePct100(pePct);
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_PE_BANDS;
  const h = Math.max(0, Number(hysteresisPp) || 0);
  if (pct == null) {
    return { pe_pct: null, band_index: null, band: null, mult: null };
  }
  let rawIndex = peBandIndex(pct / 100, list);
  if (rawIndex == null) rawIndex = list.length - 1;
  let index = rawIndex;
  if (Number.isInteger(previousBandIndex) && previousBandIndex >= 0 && previousBandIndex < list.length) {
    const prev = previousBandIndex;
    if (rawIndex > prev) {
      // 恶化（分位升高 → 更高索引）：需超过上一档上沿 + h
      const boundary = Number(list[prev].max_pct);
      if (!(pct > boundary + h)) index = prev;
    } else if (rawIndex < prev) {
      // 改善：需低于当前档下沿 - h；当前档下沿 = 上一档 max_pct
      const lower = prev > 0 ? Number(list[prev - 1].max_pct) : 0;
      if (!(pct < lower - h)) index = prev;
    } else {
      index = prev;
    }
  }
  const band = list[index] || list[list.length - 1];
  return {
    pe_pct: round4(pct / 100),
    band_index: index,
    band: band?.label || null,
    mult: Number.isFinite(Number(band?.mult)) ? Number(band.mult) : null,
  };
}

export function signalSnapshotFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const holdings = snapshot.holdings && typeof snapshot.holdings === "object" ? snapshot.holdings : {};
  const parts = Object.keys(holdings)
    .sort()
    .map((symbol) => {
      const row = holdings[symbol] || {};
      return [
        symbol,
        row.band || "",
        row.base_mult ?? "",
        row.sentiment_mult ?? "",
        row.effective_mult ?? "",
        row.grade || "",
      ].join(":");
    });
  return [snapshot.id || "", snapshot.period || "", snapshot.config_fingerprint || "", ...parts].join("|");
}

function configFingerprint(plan) {
  const strategy = normalizeStrategyId(plan?.strategy);
  const config = normalizeStrategyConfig(plan?.strategy_config);
  const policy = normalizeExecutionPolicy(plan?.execution_policy);
  return [
    strategy,
    JSON.stringify(config.pe_bands),
    JSON.stringify(config.grade_mult),
    policy.pe_hysteresis_pp,
  ].join("::");
}

function holdingSignalRow({
  holding,
  plan,
  sentimentByMarket,
  previousRow,
  hysteresisPp,
  now,
}) {
  const strategy = normalizeStrategyId(
    plan.strategy_overrides?.[holding.symbol] || plan.strategy,
  );
  const config = normalizeStrategyConfig(plan.strategy_config);
  const prevIndex =
    previousRow && Number.isInteger(previousRow.band_index)
      ? previousRow.band_index
      : previousRow
        ? peBandIndex(previousRow.pe_pct, config.pe_bands)
        : null;
  const peHyst = applyPeHysteresis({
    pePct: holding.pePct,
    previousBandIndex: prevIndex,
    bands: config.pe_bands,
    hysteresisPp,
  });
  // 同档位冻结：同一期内用快照 pe 参与倍率；跨期新建时用滞回后的 pe 档
  const peForMult = peHyst.pe_pct != null ? peHyst.pe_pct : holding.pePct;
  const grid = dcaMultiplier({
    strategy,
    strategyConfig: config,
    pePct: peForMult,
    grade: holding.grade,
    assetClass: holding.assetClass,
    spreadPct: holding.spreadPct,
    biasPct: holding.biasPct,
    goldMacro: holding.goldMacro,
  });
  const market =
    sentimentByMarket && holding.assetClass
      ? sentimentByMarket[String(holding.assetClass).toLowerCase()] ||
        sentimentByMarket.A ||
        null
      : sentimentByMarket?.A || null;
  const sentimentMult = Number(market?.mult);
  const baseMult = Number(grid.mult);
  const sent = Number.isFinite(sentimentMult) && sentimentMult > 0 ? sentimentMult : 1;
  const effective = Math.min(1.8, (Number.isFinite(baseMult) ? baseMult : 1) * sent);
  return {
    pe_pct: peHyst.pe_pct,
    grade: holding.grade != null ? String(holding.grade).toUpperCase() : null,
    asset_class: holding.assetClass || null,
    spread_pct: round4(holding.spreadPct),
    bias_pct: round4(holding.biasPct),
    sentiment_market: market?.market || market?.label || null,
    sentiment_score: Number.isFinite(Number(market?.score)) ? Number(market.score) : null,
    base_mult: Number.isFinite(baseMult) ? Math.round(baseMult * 1000) / 1000 : null,
    sentiment_mult: Math.round(sent * 1000) / 1000,
    effective_mult: Math.round(effective * 1000) / 1000,
    band: peHyst.band || grid.band || null,
    band_index: peHyst.band_index,
    data_as_of: holding.dataAsOf || null,
    analysis_usable: Boolean(holding.analyzed),
    index_code: holding.indexCode || null,
    strategy,
    frozen_at: now instanceof Date ? now.toISOString() : String(now || ""),
  };
}

export function buildSignalSnapshot({
  plan = {},
  period = "",
  holdings = [],
  previousSnapshot = null,
  sentimentByMarket = null,
  now = new Date(),
  id = null,
} = {}) {
  const policy = normalizeExecutionPolicy(plan.execution_policy);
  const hysteresisPp = policy.pe_hysteresis_pp;
  const prevHoldings =
    previousSnapshot?.holdings && typeof previousSnapshot.holdings === "object"
      ? previousSnapshot.holdings
      : {};
  const holdingsMap = {};
  for (const holding of holdings || []) {
    const symbol = String(holding.symbol || "").trim();
    if (!symbol) continue;
    holdingsMap[symbol] = holdingSignalRow({
      holding,
      plan,
      sentimentByMarket,
      previousRow: prevHoldings[symbol] || null,
      hysteresisPp,
      now,
    });
  }
  const created = now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
  const snapshotId =
    String(id || "").trim() ||
    `sig_${period || "na"}_${created.replace(/[:.]/g, "").slice(0, 15)}`;
  return {
    id: snapshotId,
    period: String(period || "").trim(),
    created_at: created,
    strategy: normalizeStrategyId(plan.strategy),
    strategy_config: normalizeStrategyConfig(plan.strategy_config),
    holdings: holdingsMap,
    config_fingerprint: configFingerprint(plan),
  };
}

export function getCurrentSignalSnapshot(plan = {}, period = "") {
  const map = plan?.signal_snapshots;
  if (!map || typeof map !== "object") return null;
  const key = String(period || "").trim();
  if (key && map[key]) return map[key];
  const keys = Object.keys(map)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  if (!keys.length) return null;
  return map[keys[keys.length - 1]] || null;
}

/** pending 草稿与快照不一致时标记失效（confirmed/skipped 保留）。 */
export function invalidatePendingDraftsForSnapshot(drafts = [], snapshotId = null) {
  const sid = String(snapshotId || "").trim();
  return (Array.isArray(drafts) ? drafts : []).map((draft) => {
    if (!draft || draft.status !== "pending") return draft;
    const draftSid = draft.decision_snapshot?.signal_snapshot_id || null;
    if (sid && draftSid && draftSid === sid && !draft.stale) return draft;
    return { ...draft, stale: true };
  });
}

export function upsertSignalSnapshot(plan = {}, snapshot) {
  if (!snapshot || !snapshot.period) return plan;
  const current = plan?.signal_snapshots && typeof plan.signal_snapshots === "object"
    ? { ...plan.signal_snapshots }
    : {};
  current[snapshot.period] = snapshot;
  const keys = Object.keys(current)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  while (keys.length > 24) {
    const oldest = keys.shift();
    delete current[oldest];
  }
  return { ...plan, signal_snapshots: current };
}
