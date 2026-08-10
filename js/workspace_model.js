import { DEFAULT_TARGET_WEIGHTS } from "./constants.js";
import { normalizeAddPlanConfig } from "./add-plan.js";
import {
  DEFAULT_EXECUTION_POLICY,
  normalizeExecutionPolicy,
} from "./execution-policy.js";
import {
  normalizeStrategyConfig,
  normalizeStrategyId,
  STRATEGY_IDS,
} from "./strategy.js";

export { normalizeExecutionPolicy, DEFAULT_EXECUTION_POLICY };

export const WORKSPACE_VERSION = 9;

export const DEFAULT_TRADING_COST = Object.freeze({
  min_commission: 5,
  commission_rate_pct: 0.03,
  max_fee_ratio_pct: 0.25,
  lot_size: 100,
});

export const DEFAULT_ADD_PLAN = Object.freeze({
  enabled: true,
  anchor: "price",
  preset: "auto",
  levels: null,
});

/** 按品种策略覆盖：key 为 6 位代码，value 为合法 strategy id；非法项丢弃。 */
export function normalizeStrategyOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawId] of Object.entries(value)) {
    const digits = String(rawKey || "").replace(/\D/g, "");
    const symbol = digits.padStart(6, "0");
    if (symbol.length !== 6 || !digits) continue;
    const id = String(rawId || "").trim().toLowerCase();
    if (!STRATEGY_IDS.includes(id)) continue;
    result[symbol] = id;
  }
  return result;
}

function nonnegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeTradingCost(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    min_commission: nonnegative(source.min_commission, DEFAULT_TRADING_COST.min_commission),
    commission_rate_pct: Math.min(
      10,
      nonnegative(source.commission_rate_pct, DEFAULT_TRADING_COST.commission_rate_pct),
    ),
    max_fee_ratio_pct: Math.min(
      100,
      nonnegative(source.max_fee_ratio_pct, DEFAULT_TRADING_COST.max_fee_ratio_pct),
    ),
    lot_size: Math.min(
      100000,
      Math.max(1, Math.round(nonnegative(source.lot_size, DEFAULT_TRADING_COST.lot_size))),
    ),
  };
}

const CASH_RESERVE_TYPES = new Set(["keep", "release", "sell"]);

/** 现金池：旧数据缺字段时补默认（纯增量）。 */
export function normalizeCashReserve(value) {
  const source = value && typeof value === "object" ? value : {};
  const balance = nonnegative(source.balance, 0);
  const history = [];
  for (const item of Array.isArray(source.history) ? source.history : []) {
    if (!item || typeof item !== "object") continue;
    const period = String(item.period || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) continue;
    const type = String(item.type || "").trim().toLowerCase();
    if (!CASH_RESERVE_TYPES.has(type)) continue;
    const amount = nonnegative(item.amount, 0);
    if (!(amount > 0)) continue;
    history.push({ period, amount: Math.round(amount * 100) / 100, type });
  }
  return { balance: Math.round(balance * 100) / 100, history };
}

function normalizePendingOrders(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([symbol, row]) => /^\d{6}$/.test(symbol) && row && typeof row === "object")
      .map(([symbol, row]) => [
        symbol,
        {
          period: /^\d{4}-\d{2}-\d{2}$/.test(String(row.period || "")) ? String(row.period) : "",
          carry: nonnegative(row.carry),
          scheduled: nonnegative(row.scheduled),
          remaining: nonnegative(row.remaining),
        },
      ]),
  );
}

export function clampWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(100, Math.round(number * 100) / 100);
}

function normalizeSignalHolding(row) {
  if (!row || typeof row !== "object") return null;
  const pe = Number(row.pe_pct);
  const base = Number(row.base_mult);
  const sent = Number(row.sentiment_mult);
  const eff = Number(row.effective_mult);
  const score = Number(row.sentiment_score);
  const bandIndex = Number.parseInt(row.band_index, 10);
  return {
    pe_pct: Number.isFinite(pe) ? Math.round(pe * 1e4) / 1e4 : null,
    grade: row.grade != null ? String(row.grade).toUpperCase() : null,
    asset_class: row.asset_class != null ? String(row.asset_class) : null,
    spread_pct: Number.isFinite(Number(row.spread_pct))
      ? Math.round(Number(row.spread_pct) * 1e4) / 1e4
      : null,
    bias_pct: Number.isFinite(Number(row.bias_pct))
      ? Math.round(Number(row.bias_pct) * 1e4) / 1e4
      : null,
    sentiment_market: row.sentiment_market != null ? String(row.sentiment_market) : null,
    sentiment_score: Number.isFinite(score) ? score : null,
    base_mult: Number.isFinite(base) ? Math.round(base * 1000) / 1000 : null,
    sentiment_mult: Number.isFinite(sent) ? Math.round(sent * 1000) / 1000 : null,
    effective_mult: Number.isFinite(eff) ? Math.round(eff * 1000) / 1000 : null,
    band: row.band != null ? String(row.band) : null,
    band_index: Number.isFinite(bandIndex) ? bandIndex : null,
    data_as_of: row.data_as_of != null ? String(row.data_as_of) : null,
    analysis_usable: row.analysis_usable == null ? true : Boolean(row.analysis_usable),
    index_code: row.index_code != null ? String(row.index_code) : null,
    strategy: row.strategy != null ? normalizeStrategyId(row.strategy) : null,
  };
}

export function normalizeSignalSnapshots(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = [];
  for (const [rawKey, raw] of Object.entries(value)) {
    const period = String(rawKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || !raw || typeof raw !== "object") continue;
    const holdingsIn = raw.holdings && typeof raw.holdings === "object" ? raw.holdings : {};
    const holdings = {};
    for (const [symRaw, row] of Object.entries(holdingsIn)) {
      const digits = String(symRaw || "").replace(/\D/g, "");
      const symbol = digits.padStart(6, "0");
      if (symbol.length !== 6 || !digits) continue;
      const normalized = normalizeSignalHolding(row);
      if (normalized) holdings[symbol] = normalized;
    }
    entries.push({
      period,
      snapshot: {
        id: String(raw.id || "").trim() || `sig_${period}`,
        period,
        created_at: String(raw.created_at || "").trim() || null,
        strategy: normalizeStrategyId(raw.strategy),
        strategy_config: normalizeStrategyConfig(raw.strategy_config),
        holdings,
        config_fingerprint: String(raw.config_fingerprint || "").trim(),
      },
    });
  }
  entries.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  const kept = entries.slice(-24);
  return Object.fromEntries(kept.map((row) => [row.period, row.snapshot]));
}

export function normalizeDecisionHistory(items = []) {
  if (!Array.isArray(items)) return [];
  const actions = new Set(["confirmed", "skipped", "blocked", "override"]);
  const sides = new Set(["buy", "sell"]);
  const statuses = new Set(["ready", "warning", "preview", "blocked"]);
  const rows = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const digits = String(item.symbol || "").replace(/\D/g, "");
    if (digits.length < 1 || digits.length > 6) continue;
    const symbol = digits.padStart(6, "0");
    const period = String(item.period || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) continue;
    const action = String(item.action || "").trim().toLowerCase();
    if (!actions.has(action)) continue;
    const side = sides.has(String(item.side || "").toLowerCase())
      ? String(item.side).toLowerCase()
      : "buy";
    const policyStatus = String(item.policy_status || "").trim().toLowerCase();
    const strategic = Number(item.strategic_amount);
    const orderAmt = Number(item.order_amount);
    const fee = Number(item.fee);
    const premium = Number(item.premium_discount_pct);
    const spread = Number(item.bid_ask_spread_pct);
    const reasons = Array.isArray(item.policy_reasons)
      ? item.policy_reasons.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 12)
      : [];
    rows.push({
      id: String(item.id || "").trim() || `dec_${period}_${symbol}_${action}`,
      period,
      symbol,
      side,
      action,
      strategic_amount:
        Number.isFinite(strategic) && strategic > 0 ? Math.round(strategic * 100) / 100 : 0,
      order_amount: Number.isFinite(orderAmt) && orderAmt > 0 ? Math.round(orderAmt * 100) / 100 : 0,
      fee: Number.isFinite(fee) && fee > 0 ? Math.round(fee * 100) / 100 : 0,
      premium_discount_pct: Number.isFinite(premium) ? Math.round(premium * 10000) / 10000 : null,
      bid_ask_spread_pct: Number.isFinite(spread) ? Math.round(spread * 10000) / 10000 : null,
      policy_status: statuses.has(policyStatus) ? policyStatus : "",
      policy_reasons: reasons,
      signal_snapshot_id: String(item.signal_snapshot_id || "").trim() || null,
      created_at: String(item.created_at || "").trim() || null,
    });
  }
  rows.sort((a, b) => {
    const at = String(a.created_at || "");
    const bt = String(b.created_at || "");
    if (at !== bt) return at < bt ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  return rows.slice(0, 500);
}

export function normalizeExecutionDraftsMeta(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    synced_at: String(source.synced_at || source.syncedAt || "").trim() || null,
    fingerprint: String(source.fingerprint || "").trim(),
    signal_snapshot_id:
      String(source.signal_snapshot_id || source.signalSnapshotId || "").trim() || null,
  };
}

function normalizeDecisionSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const strategic = Number(value.strategic_amount);
  const reasons = Array.isArray(value.policy_reasons)
    ? value.policy_reasons.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  const status = String(value.policy_status || "").trim().toLowerCase();
  return {
    phase: String(value.phase || "").trim() || null,
    strategic_amount:
      Number.isFinite(strategic) && strategic > 0 ? Math.round(strategic * 100) / 100 : 0,
    target_amount: nonnegative(value.target_amount, 0),
    current_market_value: nonnegative(value.current_market_value, 0),
    target_gap: nonnegative(value.target_gap, 0),
    strategy: String(value.strategy || "").trim(),
    band: String(value.band || "").trim(),
    base_mult: Number.isFinite(Number(value.base_mult)) ? Number(value.base_mult) : null,
    sentiment_mult: Number.isFinite(Number(value.sentiment_mult))
      ? Number(value.sentiment_mult)
      : null,
    effective_mult: Number.isFinite(Number(value.effective_mult))
      ? Number(value.effective_mult)
      : null,
    quote_price: nonnegative(value.quote_price, 0),
    quote_as_of: value.quote_as_of != null ? String(value.quote_as_of) : null,
    market_timestamp: value.market_timestamp != null ? String(value.market_timestamp) : null,
    provider: value.provider != null ? String(value.provider) : null,
    iopv: Number.isFinite(Number(value.iopv)) ? Number(value.iopv) : null,
    premium_discount_pct: Number.isFinite(Number(value.premium_discount_pct))
      ? Number(value.premium_discount_pct)
      : null,
    bid_ask_spread_pct: Number.isFinite(Number(value.bid_ask_spread_pct))
      ? Number(value.bid_ask_spread_pct)
      : null,
    analysis_usable: value.analysis_usable == null ? true : Boolean(value.analysis_usable),
    policy_status: ["ready", "warning", "preview", "blocked"].includes(status) ? status : "",
    policy_reasons: reasons,
    policy_fingerprint: String(value.policy_fingerprint || "").trim(),
    signal_snapshot_id: String(value.signal_snapshot_id || "").trim() || null,
    created_at: String(value.created_at || "").trim() || null,
  };
}

export function normalizePlan(plan) {
  const base = {
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
    strategy_config: normalizeStrategyConfig(null),
    strategy_overrides: {},
    add_plan: { ...DEFAULT_ADD_PLAN },
    trading_cost: normalizeTradingCost(null),
    pending_orders: {},
    cash_reserve: normalizeCashReserve(null),
    execution_policy: normalizeExecutionPolicy(null),
    signal_snapshots: {},
  };
  if (!plan || typeof plan !== "object") {
    return {
      ...base,
      strategy_config: normalizeStrategyConfig(null),
      strategy_overrides: {},
      add_plan: { ...DEFAULT_ADD_PLAN },
      cash_reserve: normalizeCashReserve(null),
      execution_policy: normalizeExecutionPolicy(null),
      signal_snapshots: {},
    };
  }
  let cadence = String(plan.cadence || base.cadence).toLowerCase();
  if (!["weekly", "biweekly", "monthly"].includes(cadence)) cadence = base.cadence;
  let day = Number.parseInt(plan.day, 10);
  if (!Number.isFinite(day)) day = base.day;
  if (cadence === "monthly") day = Math.min(28, Math.max(1, day));
  else day = Math.min(7, Math.max(1, day));
  const amount = Number(plan.amount);
  const capitalBase = Number(plan.capital_base);
  const initialTargetPct = Number(plan.initial_target_pct);
  let initialMonths = Number.parseInt(plan.initial_months ?? plan.initialMonths, 10);
  if (!Number.isFinite(initialMonths) || initialMonths < 1) initialMonths = base.initial_months;
  initialMonths = Math.min(36, initialMonths);
  return {
    name: String(plan.name || base.name).trim() || base.name,
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    capital_base: Number.isFinite(capitalBase) && capitalBase > 0 ? capitalBase : 0,
    initial_target_pct:
      Number.isFinite(initialTargetPct) && initialTargetPct > 0
        ? Math.min(100, initialTargetPct)
        : 0,
    initial_months: initialMonths,
    initial_build_started_at:
      String(plan.initial_build_started_at || "").trim() || null,
    initial_build_completed_at:
      String(plan.initial_build_completed_at || "").trim() || null,
    cadence,
    day,
    note: String(plan.note || "").trim(),
    strategy: normalizeStrategyId(plan.strategy),
    strategy_config: normalizeStrategyConfig(plan.strategy_config ?? plan.strategyConfig),
    strategy_overrides: normalizeStrategyOverrides(
      plan.strategy_overrides ?? plan.strategyOverrides,
    ),
    add_plan: normalizeAddPlanConfig(plan.add_plan ?? plan.addPlan),
    trading_cost: normalizeTradingCost(plan.trading_cost),
    pending_orders: normalizePendingOrders(plan.pending_orders),
    cash_reserve: normalizeCashReserve(plan.cash_reserve ?? plan.cashReserve),
    execution_policy: normalizeExecutionPolicy(plan.execution_policy ?? plan.executionPolicy),
    signal_snapshots: normalizeSignalSnapshots(plan.signal_snapshots ?? plan.signalSnapshots),
  };
}

export function normalizeWorkspaceEntries(items = []) {
  const hadTarget = items.some(
    (item) => item && (item.target_weight != null || item.targetWeight != null),
  );
  const etfs = items
    .filter((item) => item && item.symbol)
    .map((item) => {
      const symbol = String(item.symbol || "");
      const targetRaw = item.target_weight ?? item.targetWeight;
      return {
        symbol,
        name: String(item.name || ""),
        shares: Number(item.shares) > 0 ? Number(item.shares) : 0,
        cost: Number(item.cost) > 0 ? Number(item.cost) : 0,
        target_weight: clampWeight(targetRaw),
        note: String(item.note || ""),
      };
    });
  if (!hadTarget) {
    etfs.forEach((entry) => {
      entry.target_weight = clampWeight(DEFAULT_TARGET_WEIGHTS[entry.symbol] || 0);
    });
  }
  return etfs;
}

export function normalizeTrades(items = [], kind = "buy") {
  const seen = new Set();
  const buys = [];
  for (const item of items) {
    if (!item || !item.symbol || !item.date) continue;
    const digits = String(item.symbol).replace(/\D/g, "");
    if (digits.length < 1 || digits.length > 6) continue;
    const symbol = digits.padStart(6, "0");
    const date = String(item.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const [year, month, day] = date.split("-").map(Number);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 1990 ||
      year > 2100 ||
      parsedDate.getUTCFullYear() !== year ||
      parsedDate.getUTCMonth() !== month - 1 ||
      parsedDate.getUTCDate() !== day
    ) {
      continue;
    }
    const shares = Number(item.shares);
    const price = Number(item.price);
    if (!(shares > 0) || !(price > 0)) continue;
    const id = String(item.id || "").trim() || `${kind}_${symbol}_${date}_${Math.round(shares)}_${Math.round(price * 10000)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    buys.push({
      id,
      symbol,
      date,
      price: Math.round(price * 1e6) / 1e6,
      shares: Math.round(shares * 1e4) / 1e4,
      fee: Math.round(nonnegative(item.fee) * 100) / 100,
      note: String(item.note || "").trim(),
    });
  }
  buys.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
  return buys;
}

export function normalizeBuys(items = []) {
  return normalizeTrades(items, "buy");
}

export function normalizeSells(items = []) {
  return normalizeTrades(items, "sell");
}

export function upsertBuy(items, record) {
  if (!record?.id) return normalizeBuys(items);
  return normalizeBuys([record, ...(items || []).filter((item) => item?.id !== record.id)]);
}

export function upsertSell(items, record) {
  if (!record?.id) return normalizeSells(items);
  return normalizeSells([record, ...(items || []).filter((item) => item?.id !== record.id)]);
}

const DRAFT_STATUSES = new Set(["pending", "confirmed", "skipped"]);
const READINESS_STATUSES = new Set(["ready", "warning", "preview", "blocked"]);

export function normalizeExecutionDrafts(items = []) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const drafts = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const digits = String(item.symbol || "").replace(/\D/g, "");
    if (digits.length < 1 || digits.length > 6) continue;
    const symbol = digits.padStart(6, "0");
    const period = String(item.period || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) continue;
    const date = String(item.date || "").trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const status = DRAFT_STATUSES.has(item.status) ? item.status : "pending";
    const id = String(item.id || "").trim() || `draft_${period}_${symbol}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const suggested = Number(item.suggested_amount);
    const orderAmt = Number(item.order_amount);
    const totalCash = Number(item.total_cash);
    const price = Number(item.price);
    const shares = Number(item.shares);
    const fee = Number(item.fee);
    const side = String(item.side || "buy").trim().toLowerCase() === "sell" ? "sell" : "buy";
    const decisionSnapshot = normalizeDecisionSnapshot(item.decision_snapshot);
    const readinessRaw = String(item.readiness_status || decisionSnapshot?.policy_status || "").trim().toLowerCase();
    const readiness_status = READINESS_STATUSES.has(readinessRaw)
      ? readinessRaw
      : status === "pending"
        ? ""
        : "ready";
    const readiness_reasons = Array.isArray(item.readiness_reasons)
      ? item.readiness_reasons.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 12)
      : decisionSnapshot?.policy_reasons || [];
    // 旧 pending 草稿缺 decision_snapshot → stale，下次同步重建
    const stale =
      status === "pending" && !decisionSnapshot
        ? true
        : Boolean(item.stale);
    drafts.push({
      id,
      period,
      symbol,
      name: String(item.name || "").trim(),
      side,
      suggested_amount: Number.isFinite(suggested) && suggested > 0 ? Math.round(suggested * 100) / 100 : 0,
      order_amount:
        Number.isFinite(orderAmt) && orderAmt > 0
          ? Math.round(orderAmt * 100) / 100
          : Number.isFinite(price) && Number.isFinite(shares) && price > 0 && shares > 0
            ? Math.round(price * shares * 100) / 100
            : 0,
      total_cash: Number.isFinite(totalCash) && totalCash > 0 ? Math.round(totalCash * 100) / 100 : 0,
      price: Number.isFinite(price) && price > 0 ? Math.round(price * 1e6) / 1e6 : 0,
      shares: Number.isFinite(shares) && shares > 0 ? Math.round(shares * 1e4) / 1e4 : 0,
      fee: Number.isFinite(fee) && fee > 0 ? Math.round(fee * 100) / 100 : 0,
      date: date || period,
      status,
      skip_reason: String(item.skip_reason || "").trim(),
      confirmed_trade_id: String(item.confirmed_trade_id || "").trim() || null,
      note: String(item.note || "").trim(),
      readiness_status,
      readiness_reasons,
      stale,
      decision_snapshot: decisionSnapshot,
    });
  }
  drafts.sort((a, b) => {
    if (a.period !== b.period) return a.period < b.period ? 1 : -1;
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
    if (a.side !== b.side) return a.side === "sell" ? -1 : 1;
    return 0;
  });
  return drafts;
}

/** 计划字段“已填写强度”：避免仅因本地 updated_at 更新就用默认/空 plan 覆盖服务器。 */
export function planPersistenceScore(plan) {
  if (!plan || typeof plan !== "object") return 0;
  let score = 0;
  const capital = Number(plan.capital_base);
  const target = Number(plan.initial_target_pct);
  const amount = Number(plan.amount);
  const name = String(plan.name || "").trim();
  const note = String(plan.note || "").trim();
  if (Number.isFinite(capital) && capital > 0) score += 4;
  if (Number.isFinite(target) && target > 0) score += 4;
  if (Number.isFinite(amount) && amount > 0) {
    // 默认预算 2000：有值但不算强信号
    score += amount === 2000 ? 1 : 2;
  }
  if (name && name !== "默认定投计划") score += 1;
  if (note) score += 1;
  if (plan.initial_build_completed_at) score += 1;
  const overrides = plan.strategy_overrides;
  if (overrides && typeof overrides === "object" && Object.keys(overrides).length) score += 1;
  return score;
}

export function parseWorkspaceTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || 0),
  ).getTime();
}

export function chooseWorkspaceSource(remote, local) {
  if (Array.isArray(remote?.etfs) && remote.etfs.length) {
    // Local cache may be newer when a debounced server PUT did not finish before reload.
    // But never let a weaker/default plan stampede over a richer server plan just because
    // hydrate rewrote local updated_at with a fresher ISO timestamp.
    if (shouldPreferLocalCache(local, remote)) {
      return { source: "local-cache", payload: local, migrate: true };
    }
    return { source: "server", payload: remote, migrate: false };
  }
  if (Array.isArray(local?.etfs) && local.etfs.length) {
    return { source: "local-cache", payload: local, migrate: true };
  }
  return { source: "default-pool", payload: null, migrate: true };
}

function shouldPreferLocalCache(local, remote) {
  if (!isLocalWorkspaceNewer(local, remote)) return false;
  const localScore = planPersistenceScore(local?.plan);
  const remoteScore = planPersistenceScore(remote?.plan);
  if (remoteScore > localScore) return false;
  return true;
}

function isLocalWorkspaceNewer(local, remote) {
  if (!local || typeof local !== "object") return false;
  const localAt = parseWorkspaceTimestamp(local.updated_at);
  const remoteAt = parseWorkspaceTimestamp(remote?.updated_at);
  return localAt > 0 && localAt > remoteAt;
}
