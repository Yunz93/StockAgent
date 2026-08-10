import { appConfig, state } from "./state.js";
import { renderDividend, renderEtfPool } from "./views/render.js";
import { ensureMarketSentiment } from "./market-sentiment.js";
import { ensureGoldMacro } from "./gold-macro.js";

export const DEFAULT_AUTO_REFRESH_SECONDS = 300;
export const MIN_AUTO_REFRESH_SECONDS = 30;

let refreshTimer = null;
let refreshRunning = false;
let lastRefreshAt = Date.now();
let visibilityBound = false;

export function autoRefreshSettings(config = appConfig) {
  const quotes = config?.quotes || {};
  const rawSeconds = Number.parseInt(quotes.refresh_interval_seconds, 10);
  return {
    enabled: quotes.auto_refresh_enabled !== false,
    seconds:
      Number.isFinite(rawSeconds) && rawSeconds >= MIN_AUTO_REFRESH_SECONDS
        ? rawSeconds
        : DEFAULT_AUTO_REFRESH_SECONDS,
  };
}

async function refreshCurrentView() {
  const sentiment = ensureMarketSentiment({ refresh: true }).catch(() => {});
  const goldMacro = ensureGoldMacro({ refresh: true }).catch(() => {});
  if (state.activeView === "dividend") {
    await Promise.all([renderDividend({ force: true }), sentiment, goldMacro]);
    return;
  }
  if (state.activeView === "etf" || state.activeView === "home") {
    await Promise.all([renderEtfPool({ refresh: true }), sentiment, goldMacro]);
    return;
  }
  await Promise.all([sentiment, goldMacro]);
}

function clearRefreshTimer() {
  if (refreshTimer != null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleNextRefresh(delayMs) {
  clearRefreshTimer();
  const { enabled } = autoRefreshSettings();
  if (!enabled) return;
  refreshTimer = window.setTimeout(runAutoRefresh, Math.max(0, delayMs));
}

async function runAutoRefresh() {
  refreshTimer = null;
  const { enabled, seconds } = autoRefreshSettings();
  if (!enabled) return;
  if (document.hidden || refreshRunning) {
    scheduleNextRefresh(seconds * 1000);
    return;
  }

  refreshRunning = true;
  try {
    await refreshCurrentView();
  } finally {
    refreshRunning = false;
    lastRefreshAt = Date.now();
    scheduleNextRefresh(seconds * 1000);
  }
}

function handleVisibilityChange() {
  if (document.hidden) return;
  const { enabled, seconds } = autoRefreshSettings();
  if (!enabled) return;
  const remainingMs = seconds * 1000 - (Date.now() - lastRefreshAt);
  scheduleNextRefresh(remainingMs);
}

export function configureAutoRefresh() {
  clearRefreshTimer();
  lastRefreshAt = Date.now();
  const { enabled, seconds } = autoRefreshSettings();
  if (enabled) scheduleNextRefresh(seconds * 1000);
  if (!visibilityBound) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilityBound = true;
  }
}
