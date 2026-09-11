/**
 * 分析缓存与全池预取：内存 + sessionStorage，优先队列 + 有限并发，支持 lite 预取与后台刷新。
 */

import { ANALYSIS_CACHE_TTL_MS } from "./constants.js";
import { state } from "./state.js";

const SESSION_KEY = "stockagent.analysisCache.v1";
const PREFETCH_CONCURRENCY = 2;
const loadingByKey = new Map();
let prefetchPromise = null;
let prefetchListener = null;
/** @type {string[]} */
let prefetchQueue = [];
/** @type {Set<string>} */
let prefetchQueued = new Set();
let sessionHydrated = false;

export function analysisCacheKey(symbol) {
  return symbol || "__default__";
}

function poolSymbols() {
  return (state.etfs || []).map((item) => item.symbol).filter(Boolean);
}

export function isAnalysisUsable(payload) {
  return Boolean(payload && payload.supported !== false && !payload.error);
}

/** 缓存有效：有载荷、无错误、且未超过 TTL。 */
export function isAnalysisFresh(payload, now = Date.now()) {
  if (!isAnalysisUsable(payload)) return false;
  const updated = Date.parse(String(payload.updated_at || ""));
  if (!Number.isFinite(updated)) return true;
  return now - updated < ANALYSIS_CACHE_TTL_MS;
}

function persistSessionCache() {
  if (typeof sessionStorage === "undefined") return;
  try {
    const out = {};
    for (const [key, payload] of Object.entries(state.analysisCache || {})) {
      if (!isAnalysisUsable(payload)) continue;
      out[key] = payload;
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ savedAt: Date.now(), items: out }));
  } catch {
    // quota / private mode — ignore
  }
}

/** 启动时灌入 sessionStorage 软缓存（不覆盖已有内存条目）。 */
export function hydrateAnalysisCacheFromSession() {
  if (sessionHydrated) return;
  sessionHydrated = true;
  if (typeof sessionStorage === "undefined") return;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const items = parsed?.items && typeof parsed.items === "object" ? parsed.items : null;
    if (!items) return;
    state.analysisCache = state.analysisCache || {};
    for (const [key, payload] of Object.entries(items)) {
      if (state.analysisCache[key] || !isAnalysisUsable(payload)) continue;
      state.analysisCache[key] = payload;
    }
  } catch {
    // ignore corrupt cache
  }
}

export function getCachedAnalysis(symbol) {
  hydrateAnalysisCacheFromSession();
  return state.analysisCache[analysisCacheKey(symbol)] || null;
}

function analyzedCount(symbols = poolSymbols()) {
  return symbols.filter((symbol) => isAnalysisUsable(getCachedAnalysis(symbol))).length;
}

function setPrefetchState(partial) {
  state.analysisPrefetch = {
    ...(state.analysisPrefetch || { status: "idle", total: 0, done: 0, current: null }),
    ...partial,
  };
}

function storeAnalysis(symbol, payload) {
  const key = analysisCacheKey(symbol);
  state.analysisCache[key] = payload;
  persistSessionCache();
  return payload;
}

/**
 * 拉取单只分析。
 * @param {string} symbol
 * @param {{ force?: boolean, lite?: boolean }} [opts]
 */
export async function fetchAnalysis(symbol, { force = false, lite = false } = {}) {
  hydrateAnalysisCacheFromSession();
  const key = analysisCacheKey(symbol);
  const cached = state.analysisCache[key];
  // 详情需要全量：lite 缓存命中时仍要补拉全量
  if (!force && isAnalysisFresh(cached) && (!lite ? !cached?.lite : true)) {
    return cached;
  }
  if (!force && !lite && isAnalysisUsable(cached) && !cached?.lite && !isAnalysisFresh(cached)) {
    // 过期全量：调用方可先画缓存，再 force 刷新
  }
  const loadKey = `${key}:${lite ? "lite" : "full"}:${force ? "1" : "0"}`;
  if (loadingByKey.has(loadKey)) return loadingByKey.get(loadKey);
  // 同 symbol 的全量 in-flight 可复用
  const fullKey = `${key}:full:${force ? "1" : "0"}`;
  if (!lite && loadingByKey.has(fullKey)) return loadingByKey.get(fullKey);

  const request = (async () => {
    try {
      const params = new URLSearchParams();
      if (force) params.set("refresh", "1");
      if (symbol) params.set("symbol", symbol);
      if (lite) params.set("lite", "1");
      const query = params.toString();
      const response = await fetch(`/api/dividend/daily${query ? `?${query}` : ""}`);
      const payload = await response.json();
      if (lite && payload && typeof payload === "object") payload.lite = true;
      // 全量结果覆盖 lite；勿用过期 lite 覆盖已有全量
      const existing = state.analysisCache[key];
      if (lite && isAnalysisUsable(existing) && !existing.lite) {
        return existing;
      }
      return storeAnalysis(symbol, payload);
    } catch (error) {
      const payload = { supported: false, error: String(error), symbol };
      return storeAnalysis(symbol, payload);
    } finally {
      loadingByKey.delete(loadKey);
      if (!lite) loadingByKey.delete(fullKey);
    }
  })();

  loadingByKey.set(loadKey, request);
  if (!lite) loadingByKey.set(fullKey, request);
  return request;
}

/** 后台刷新（不阻塞 UI）；已有 in-flight 则复用。 */
export function refreshAnalysisInBackground(symbol, { lite = false } = {}) {
  if (!symbol) return null;
  return fetchAnalysis(symbol, { force: true, lite }).catch(() => null);
}

function enqueuePrefetch(symbol, { front = false } = {}) {
  if (!symbol || prefetchQueued.has(symbol)) return;
  if (isAnalysisFresh(getCachedAnalysis(symbol))) return;
  prefetchQueued.add(symbol);
  if (front) prefetchQueue.unshift(symbol);
  else prefetchQueue.push(symbol);
}

function takeNextPrefetchSymbol() {
  while (prefetchQueue.length) {
    const symbol = prefetchQueue.shift();
    prefetchQueued.delete(symbol);
    if (!poolSymbols().includes(symbol)) continue;
    if (isAnalysisFresh(getCachedAnalysis(symbol))) continue;
    return symbol;
  }
  return null;
}

/**
 * 将标的插到预取队列最前，并立即开始/加速预取。
 * 悬停或点击详情前调用。
 */
export function prioritizeAnalysis(symbol, { onUpdate } = {}) {
  if (!symbol) return null;
  enqueuePrefetch(symbol, { front: true });
  return ensurePoolAnalysisPrefetch({ onUpdate });
}

/**
 * 有限并发预取池内分析（默认 lite）；已有未过期缓存的跳过。
 * onUpdate 在每只完成后回调，便于渐进重渲染。
 */
export async function ensurePoolAnalysisPrefetch({ onUpdate, lite = true } = {}) {
  hydrateAnalysisCacheFromSession();
  if (typeof onUpdate === "function") prefetchListener = onUpdate;
  const notify = () => {
    if (typeof prefetchListener === "function") prefetchListener();
  };

  const symbols = poolSymbols();
  if (!symbols.length) {
    setPrefetchState({ status: "done", total: 0, done: 0, current: null });
    return;
  }

  for (const symbol of symbols) enqueuePrefetch(symbol, { front: false });

  if (!prefetchQueue.length && !prefetchPromise) {
    setPrefetchState({
      status: "done",
      total: symbols.length,
      done: symbols.length,
      current: null,
    });
    return;
  }

  if (prefetchPromise) return prefetchPromise;

  setPrefetchState({
    status: "running",
    total: symbols.length,
    done: analyzedCount(symbols),
    current: null,
  });
  notify();

  prefetchPromise = (async () => {
    const worker = async () => {
      for (;;) {
        const symbol = takeNextPrefetchSymbol();
        if (!symbol) return;
        setPrefetchState({
          status: "running",
          total: poolSymbols().length,
          done: analyzedCount(),
          current: symbol,
        });
        notify();
        await fetchAnalysis(symbol, { force: false, lite });
        setPrefetchState({
          status: "running",
          total: poolSymbols().length,
          done: analyzedCount(),
          current: symbol,
        });
        notify();
      }
    };
    const workers = Array.from({ length: PREFETCH_CONCURRENCY }, () => worker());
    await Promise.all(workers);
    setPrefetchState({
      status: "done",
      total: poolSymbols().length,
      done: analyzedCount(),
      current: null,
    });
    notify();
  })().finally(() => {
    prefetchPromise = null;
  });

  return prefetchPromise;
}

/** 空闲时把过期/lite 缓存刷成新鲜全量（低优先级）。 */
export async function refreshStalePoolAnalysis({ onUpdate } = {}) {
  hydrateAnalysisCacheFromSession();
  const stale = poolSymbols().filter((symbol) => {
    const cached = getCachedAnalysis(symbol);
    return !cached || cached.lite || !isAnalysisFresh(cached);
  });
  for (const symbol of stale.reverse()) enqueuePrefetch(symbol, { front: true });
  return ensurePoolAnalysisPrefetch({ onUpdate, lite: false });
}

export function analysisPrefetchIsPreliminary() {
  const prefetch = state.analysisPrefetch;
  if (!poolSymbols().length) return false;
  if (!prefetch || prefetch.status === "idle") return true;
  if (prefetch.status === "running") return true;
  return false;
}
