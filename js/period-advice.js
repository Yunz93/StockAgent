/**
 * 本期执行结论：以定投策略分配结果为唯一「投 / 不投 / 投多少」来源。
 * 评分档位、盘面点评只作诊断背景，不另开买卖指令。
 */

import { state } from "./state.js";
import { money } from "./utils.js";
import {
  allocatePoolBudget,
  allocationForSymbol,
  dcaMultiplier,
  normalizeStrategyConfig,
  normalizeStrategyId,
  POSITION_TOLERANCE_PP,
  sentimentMarketForHolding,
  sentimentMultiplier,
  STRATEGY_IDS,
  strategyLabel,
} from "./strategy.js";
import {
  buildPoolHoldingsForAllocation,
  prepareHoldingsForAllocation,
} from "./pool-alloc.js";
import { planExecutionContext } from "./decision-support.js";
import {
  analysisRegistryFromConfig,
  sentimentByMarketFromState,
} from "./market-sentiment.js";
import { goldMacroFromState } from "./gold-macro.js";

export const STANCE = Object.freeze({
  NEED_BUDGET: "need_budget",
  HOLD_CASH: "hold_cash",
  INVEST: "invest",
  SKIP: "skip",
});

function formatAdviceMult(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${Math.round(num * 1000) / 1000}×`;
}

function resolveSymbolStrategy(plan, symbol) {
  const globalId = normalizeStrategyId(plan?.strategy);
  const overrides = plan?.strategy_overrides;
  const raw = overrides && typeof overrides === "object" ? overrides[symbol] : null;
  if (raw == null || raw === "") {
    return { strategy: globalId, overridden: false };
  }
  const id = String(raw || "").trim().toLowerCase();
  if (!STRATEGY_IDS.includes(id)) {
    return { strategy: globalId, overridden: false };
  }
  return { strategy: id, overridden: true };
}

/**
 * @param {{ symbol?: string, preferLive?: object|null, plan?: object, holdings?: array, sentimentByMarket?: object|null, goldMacro?: object|null }} [opts]
 */
export function getPeriodAdvice({
  symbol = "",
  preferLive = null,
  plan = null,
  holdings = null,
  sentimentByMarket = null,
  goldMacro = null,
} = {}) {
  const activePlan = plan || state.plan || {};
  const { strategy, overridden } = resolveSymbolStrategy(activePlan, symbol);
  const strategyName = overridden
    ? `${strategyLabel(strategy)}(指定)`
    : strategyLabel(strategy);
  const strategyConfig = normalizeStrategyConfig(activePlan.strategy_config);
  const strategyOverrides = activePlan.strategy_overrides;
  const rawPoolHoldings =
    holdings ||
    buildPoolHoldingsForAllocation({ preferLive: preferLive || null });
  const poolHoldings = prepareHoldingsForAllocation(rawPoolHoldings);
  const holding = poolHoldings.find((item) => item.symbol === symbol) || null;
  const execution = planExecutionContext({ plan: activePlan, holdings: poolHoldings });
  const budget = execution.budget;
  const markets = sentimentByMarket || sentimentByMarketFromState();
  const macro = goldMacro || holding?.goldMacro || goldMacroFromState();
  const registry = analysisRegistryFromConfig();

  const grid = dcaMultiplier({
    strategy,
    strategyConfig,
    pePct: holding?.pePct,
    grade: holding?.grade,
    assetClass: holding?.assetClass,
    spreadPct: holding?.spreadPct,
    biasPct: holding?.biasPct,
    goldMacro: macro,
  });

  const market = holding
    ? sentimentMarketForHolding(holding, strategyConfig.sentiment, registry)
    : null;
  const sentSnap = market && markets ? markets[market] : null;
  const sentAllowed =
    strategyConfig.sentiment.enabled &&
    strategyConfig.sentiment.mode === "overlay" &&
    strategyConfig.sentiment.apply_to.includes(strategy);
  const sent =
    sentAllowed && grid.mult > 0
      ? sentimentMultiplier(sentSnap, strategyConfig.sentiment)
      : { mult: 1, zone: "unknown", band: "未启用", hint: "", score: null };
  const effectiveMult =
    grid.mult <= 0 ? 0 : Math.round(grid.mult * (sentAllowed ? sent.mult : 1) * 1000) / 1000;

  const pool = allocatePoolBudget({
    budget,
    holdings: poolHoldings,
    strategy: normalizeStrategyId(activePlan.strategy),
    strategyConfig,
    strategyOverrides,
    preferTargetGap: execution.phase === "initial",
    buildTargetAmount: execution.phase === "initial" ? execution.targetAmount : null,
    sentimentByMarket: markets,
    analysisRegistry: registry,
    goldMacro: macro,
    cashReserve: Number(activePlan.cash_reserve?.balance) || 0,
  });
  const mine = symbol ? allocationForSymbol(pool, symbol) : null;
  const amount = mine?.amount ?? 0;
  const skipped = symbol
    ? (pool.skipped || []).find((item) => item.symbol === symbol) || null
    : null;

  let stance;
  let headline;
  let reason;
  if (!(budget > 0)) {
    stance = STANCE.NEED_BUDGET;
    headline =
      execution.phase === "initial"
        ? "先配置可投资总资金与初期目标仓位"
        : "先在定投计划设置「全池每期预算」";
    reason =
      execution.phase === "initial"
        ? "缺少建仓目标，无法计算建仓额度"
        : "未设置全池预算，无法给出执行金额";
  } else if (pool.deployTotal <= 0) {
    stance = STANCE.HOLD_CASH;
    headline = "本期建议不投，保留现金";
    reason = pool.note || skipped?.reason || "当期均偏弱，建议留现金";
  } else if (amount > 0) {
    stance = STANCE.INVEST;
    headline = `${execution.phase === "initial" ? "建议投入" : "本期建议投入"} ${money(amount)}`;
    reason = mine?.reason || `${grid.band} · ${effectiveMult}×`;
  } else {
    stance = STANCE.SKIP;
    headline = "本期不投";
    reason = skipped?.reason || "本期未分到额度";
  }

  const strategyBase =
    grid.techMult != null && Number.isFinite(Number(grid.techMult))
      ? Number(grid.techMult)
      : Number(grid.mult) || 0;
  const macroPart =
    grid.macroMult != null && Number.isFinite(Number(grid.macroMult))
      ? Number(grid.macroMult)
      : null;
  const sentPart = sentAllowed ? Number(sent.mult) || 1 : null;
  const multFactors = [
    {
      role: "策略",
      multText: formatAdviceMult(strategyBase),
      note: grid.band || "—",
    },
  ];
  if (macroPart != null) {
    multFactors.push({
      role: "宏观",
      multText: formatAdviceMult(macroPart),
      note: null,
    });
  }
  if (sentPart != null) {
    multFactors.push({
      role: "情绪",
      multText: formatAdviceMult(sentPart),
      note: null,
    });
  }
  const formatFactorPlain = (factor) => {
    const core = `${factor.role} ${factor.multText}`;
    return factor.note ? `${core}（${factor.note}）` : core;
  };
  const multBreakdown =
    multFactors.length > 1
      ? {
          factors: multFactors,
          result: formatAdviceMult(effectiveMult),
        }
      : null;
  const bullets = multBreakdown
    ? [
        `倍率拆解：${multBreakdown.factors.map(formatFactorPlain).join(" × ")} = ${multBreakdown.result}`,
      ]
    : [`定投倍率 ${formatAdviceMult(effectiveMult)}`];
  if (holding?.assetClass === "commodity" || grid.macroMult != null) {
    const macroMult = grid.macroMult;
    const macroBand = grid.goldMacro?.band || macro?.band;
    const macroScore = grid.goldMacro?.score ?? macro?.score;
    if (macroMult != null && macroMult !== 1) {
      bullets.push(
        `黄金宏观 ${macroBand || "调节"}` +
          (macroScore != null ? `（${macroScore}）` : "") +
          ` · ${formatAdviceMult(macroMult)}`,
      );
    } else if (holding?.assetClass === "commodity" && macro && !macro.degraded && macroScore != null) {
      bullets.push(`黄金宏观 ${macroBand || "中性"}（${macroScore}）· 不调节`);
    } else if (holding?.assetClass === "commodity" && macro?.degraded) {
      bullets.push("黄金宏观暂不可用 · 按中性");
    }
  }
  if (sentAllowed && market) {
    if (sent.score != null && sent.mult !== 1) {
      bullets.push(`市场情绪 ${sent.band}（${market} ${sent.score}）· ${formatAdviceMult(sent.mult)}`);
    } else if (sent.score != null) {
      bullets.push(`市场情绪 ${sent.band || "中性"}（${market} ${sent.score}）· 不调节`);
    } else if (strategyConfig.sentiment.enabled) {
      bullets.push("市场情绪暂不可用 · 按中性");
    }
  }
  if (stance === STANCE.INVEST && mine) {
    bullets.push(`约占全池部署 ${mine.sharePct.toFixed(0)}%`);
  } else if (stance === STANCE.SKIP || stance === STANCE.HOLD_CASH) {
    bullets.push(reason);
  } else if (stance === STANCE.NEED_BUDGET) {
    bullets.push(reason);
  }
  const targetWeight =
    holding?.targetWeight != null && Number.isFinite(Number(holding.targetWeight))
      ? Number(holding.targetWeight)
      : null;
  const actualWeight =
    holding?.actualWeight != null && Number.isFinite(Number(holding.actualWeight))
      ? Number(holding.actualWeight)
      : null;
  const drift =
    targetWeight != null && actualWeight != null
      ? Math.round((actualWeight - targetWeight) * 10_000) / 10_000
      : null;
  const overweight =
    drift != null && drift > POSITION_TOLERANCE_PP;
  const positionBlocked =
    execution.phase !== "initial" &&
    (Boolean(skipped?.positionBlocked) ||
      (drift != null && drift >= POSITION_TOLERANCE_PP));
  const position = holding
    ? {
        targetWeight,
        actualWeight,
        drift,
        maxWeight: targetWeight != null ? targetWeight + POSITION_TOLERANCE_PP : null,
        overweight,
        blocked: positionBlocked,
      }
    : null;

  return {
    symbol,
    strategy,
    strategyName,
    strategyOverridden: overridden,
    assetClass: holding?.assetClass || null,
    spreadPct: holding?.spreadPct ?? null,
    stance,
    headline,
    reason,
    amount,
    mult: effectiveMult,
    baseMult: grid.techMult ?? grid.baseMult ?? grid.mult,
    techMult: grid.techMult ?? null,
    macroMult: grid.macroMult ?? null,
    goldMacro: grid.goldMacro || (macro && !macro.degraded ? macro : null),
    sentimentMult: sentAllowed ? sent.mult : 1,
    sentiment: sentAllowed
      ? { market, score: sent.score, zone: sent.zone, band: sent.band, hint: sent.hint }
      : null,
    band: grid.band,
    hint: grid.hint,
    grade: holding?.grade || null,
    pePct: holding?.pePct ?? null,
    pool,
    execution,
    mine,
    skipped,
    bullets,
    multBreakdown,
    position,
    canAdd: stance === STANCE.INVEST,
  };
}
