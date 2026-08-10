/**
 * 决策状态统一语言：分配芯片、不买原因、仓位一眼读。
 */

/** @typedef {"可买"|"偏贵"|"攒一手"|"已满"|"等行情"|"无目标"|"不投"} AllocChip */

/**
 * @param {{ amount?: number, band?: string, reason?: string }} row
 * @returns {AllocChip}
 */
export function allocStatusChip({ amount = 0, band = "", reason = "" } = {}) {
  if (Number(amount) > 0) return "可买";
  const text = `${band} ${reason}`;
  if (/行情/.test(text)) return "等行情";
  if (/无目标/.test(text)) return "无目标";
  if (/已达目标|已满/.test(text)) return "已满";
  if (/偏贵|高估|不建议|暂停|留现金/.test(text)) return "偏贵";
  if (/不足|一手|经济/.test(text)) return "攒一手";
  if (/不投|跳过|skip/i.test(text)) return "不投";
  return "不投";
}

/** 芯片旁一句解释（可空）。 */
export function allocStatusHint(chip) {
  switch (chip) {
    case "可买":
      return "本期建议买入";
    case "偏贵":
      return "估值偏高，额度让出或留现金";
    case "攒一手":
      return "金额不足整手/手续费门槛";
    case "已满":
      return "已达建仓目标金额";
    case "等行情":
      return "缺少有效报价";
    case "无目标":
      return "未设配置%";
    default:
      return "本期不买入";
  }
}

/**
 * 仓位一眼读：只标当前池内比例与相对目标的偏移。
 * @returns {{ primary: string }}
 */
export function positionGlance({
  targetWeight = null,
  actualWeight = null,
  drift = null,
} = {}) {
  const fmt = (value, digits = 1) =>
    value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : null;
  const target = fmt(targetWeight);
  const actual = fmt(actualWeight);
  let driftText =
    drift != null && Number.isFinite(Number(drift))
      ? `${Number(drift) > 0 ? "+" : ""}${Number(drift).toFixed(1)}pp`
      : null;
  if (
    driftText == null &&
    actualWeight != null &&
    targetWeight != null &&
    Number.isFinite(Number(actualWeight)) &&
    Number.isFinite(Number(targetWeight))
  ) {
    const d = Number(actualWeight) - Number(targetWeight);
    driftText = `${d > 0 ? "+" : ""}${d.toFixed(1)}pp`;
  }

  if (actual != null && driftText) return { primary: `${actual}%（${driftText}）` };
  if (actual != null) return { primary: `${actual}%` };
  if (target != null) return { primary: `目标 ${target}%` };
  return { primary: "—" };
}

/**
 * 执行面板标题：与分配芯片同一套词。
 */
export function orderActionLabel({
  cycleCompleted = false,
  willOrder = false,
  shares = 0,
  inefficient = false,
  overweight = false,
  blockedReason = null,
  initial = false,
  hasAmount = false,
} = {}) {
  if (cycleCompleted) return "本期已完成";
  if (willOrder) {
    const base = `${inefficient ? "仍可买" : "可买"} ${Number(shares).toLocaleString("zh-CN")} 份`;
    return overweight ? `${base} · 已超目标` : base;
  }
  if (blockedReason === "fee_inefficient") return "攒一手";
  if (blockedReason === "fee_rate_exceeds_limit") return "费率超限";
  if (blockedReason === "insufficient_lot") {
    return initial ? "攒一手（余量下期）" : "攒一手";
  }
  if (hasAmount) return "攒一手";
  return "不投";
}
