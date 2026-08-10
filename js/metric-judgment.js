/**
 * 将「偏高 / 超买」等文字判断映射为数值后的方向箭头。
 * 中性、中位、数据不足不标箭头。
 */

/** @param {string|null|undefined} label */
export function judgmentArrow(label) {
  const text = String(label || "").trim();
  if (!text || text === "—" || text === "数据不足" || text === "不适用" || text === "正常") return "";
  if (/超买|偏高|高位|偏热/.test(text)) return "↑";
  if (/超卖|偏低|低估|低位/.test(text)) return "↓";
  return "";
}

/** @param {string|null|undefined} label */
export function judgmentTone(label) {
  const arrow = judgmentArrow(label);
  if (arrow === "↑") return "up";
  if (arrow === "↓") return "down";
  return "";
}

/**
 * PE 近十年分位（0–1）→ 偏高 / 正常 / 低估。
 * 阈值与后端 percentile_label 带一致（≥60 / 40–60 / <40）。
 * @param {number|null|undefined} pePct
 */
export function pePercentileBias(pePct) {
  if (pePct == null || !Number.isFinite(Number(pePct))) return "";
  const pct = Number(pePct) * 100;
  if (pct >= 60) return "偏高";
  if (pct < 40) return "低估";
  return "正常";
}
