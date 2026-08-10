import { WORKSPACE_CACHE_KEY, WORKSPACE_SYNC_DEBOUNCE_MS, DEFAULT_TARGET_WEIGHTS } from "./constants.js";
import { appConfig, els, state, workspaceRuntime } from "./state.js";
import { loadJSON, saveJSON } from "./utils.js";
import {
  applySettingsSnapshot,
  hasSettingsSnapshot,
  settingsSnapshot,
} from "./backup.js";
import {
  chooseWorkspaceSource,
  clampWeight,
  normalizeBuys,
  normalizeDecisionHistory,
  normalizeExecutionDrafts,
  normalizeExecutionDraftsMeta,
  normalizeSells,
  normalizePlan,
  normalizeWorkspaceEntries,
  WORKSPACE_VERSION,
} from "./workspace_model.js";

export function buildWorkspacePayload() {
  return {
    version: WORKSPACE_VERSION,
    etfs: state.etfs,
    buys: state.buys,
    sells: state.sells,
    plan: state.plan,
    execution_drafts: state.executionDrafts || [],
    execution_drafts_meta: normalizeExecutionDraftsMeta(state.execDraftsMeta || {}),
    decision_history: normalizeDecisionHistory(state.decisionHistory || []),
    prefs: {},
    updated_at: new Date().toISOString(),
  };
}

/** 完整备份：定投计划工作区 + 可导出设置（不含 API Key）。 */
export function buildBackupPayload() {
  return {
    ...buildWorkspacePayload(),
    settings: settingsSnapshot(appConfig),
  };
}

export function readLocalWorkspaceCache() {
  return loadJSON(WORKSPACE_CACHE_KEY, null);
}

export function writeLocalWorkspaceCache({ updatedAt = null } = {}) {
  const payload = buildWorkspacePayload();
  // 与服务器时钟对齐，避免 hydrate/PUT 成功后本地 ISO 永远“更新”而盖掉磁盘计划。
  if (updatedAt) payload.updated_at = updatedAt;
  saveJSON(WORKSPACE_CACHE_KEY, payload);
}

function applyWorkspace(payload, source) {
  if (!payload || !Array.isArray(payload.etfs)) return false;
  state.etfs = normalizeWorkspaceEntries(payload.etfs);
  state.buys = normalizeBuys(payload.buys || []);
  state.sells = normalizeSells(payload.sells || []);
  state.plan = normalizePlan(payload.plan);
  state.executionDrafts = normalizeExecutionDrafts(payload.execution_drafts || []);
  state.execDraftsMeta = normalizeExecutionDraftsMeta(payload.execution_drafts_meta || {});
  state.decisionHistory = normalizeDecisionHistory(payload.decision_history || []);
  state.workspaceSync.source = source;
  return true;
}

function seedDefaultPool() {
  const pool = appConfig?.etf?.pool || [];
  state.etfs = pool.map((item) => ({
    symbol: String(item.symbol),
    name: String(item.name || ""),
    shares: 0,
    cost: 0,
    target_weight: clampWeight(DEFAULT_TARGET_WEIGHTS[item.symbol] || 0),
    note: "",
  }));
  state.buys = [];
  state.sells = [];
  state.executionDrafts = [];
  state.execDraftsMeta = normalizeExecutionDraftsMeta(null);
  state.decisionHistory = [];
  state.plan = normalizePlan(null);
  state.workspaceSync.source = "default-pool";
}

export async function hydrateWorkspace() {
  const local = readLocalWorkspaceCache();
  let cacheUpdatedAt = null;
  try {
    const response = await fetch("/api/workspace");
    if (!response.ok) throw new Error(`workspace API ${response.status}`);
    const remote = await response.json();
    const selected = chooseWorkspaceSource(remote, local);
    if (selected.source === "server") {
      applyWorkspace(selected.payload, selected.source);
      state.workspaceSync.status = "synced";
      state.workspaceSync.updatedAt = remote.updated_at || null;
      cacheUpdatedAt = remote.updated_at || null;
    } else if (selected.source === "local-cache") {
      // 服务器为空，或本地确有未落盘的更新时迁移浏览器缓存
      applyWorkspace(selected.payload, selected.source);
      await persistWorkspace({ immediate: true });
      cacheUpdatedAt = state.workspaceSync.updatedAt;
    } else {
      seedDefaultPool();
      await persistWorkspace({ immediate: true });
      cacheUpdatedAt = state.workspaceSync.updatedAt;
    }
  } catch (error) {
    if (local && Array.isArray(local.etfs) && local.etfs.length) {
      applyWorkspace(local, "local-cache");
      cacheUpdatedAt = local.updated_at || null;
    } else {
      seedDefaultPool();
    }
    state.workspaceSync.status = "offline";
    state.workspaceSync.error = String(error);
  }
  writeLocalWorkspaceCache({ updatedAt: cacheUpdatedAt });
  renderWorkspaceStatus();
}

export function persistWorkspace({ immediate = false, announce = false } = {}) {
  writeLocalWorkspaceCache();
  state.workspaceSync.status = "pending";
  if (announce) renderWorkspaceStatus({ announce: true });
  if (workspaceRuntime.saveTimer) {
    clearTimeout(workspaceRuntime.saveTimer);
    workspaceRuntime.saveTimer = null;
  }
  const run = async () => {
    state.workspaceSync.status = "syncing";
    if (announce) renderWorkspaceStatus({ announce: true });
    try {
      const payload = buildWorkspacePayload();
      const response = await fetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`workspace API ${response.status}`);
      const saved = await response.json();
      state.workspaceSync.status = "synced";
      state.workspaceSync.updatedAt = saved.updated_at || null;
      state.workspaceSync.error = null;
      // 对齐服务器时间戳，避免下次 hydrate 误判本地更新
      writeLocalWorkspaceCache({ updatedAt: saved.updated_at || payload.updated_at });
    } catch (error) {
      state.workspaceSync.status = "offline";
      state.workspaceSync.error = String(error);
    }
    if (announce) renderWorkspaceStatus({ announce: true });
  };
  if (immediate) return run();
  workspaceRuntime.saveTimer = setTimeout(run, WORKSPACE_SYNC_DEBOUNCE_MS);
  return undefined;
}

let workspaceStatusClearTimer = null;

function formatWorkspaceLocalTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setWorkspaceStatusText(text, { status = null, clearAfterMs = 0 } = {}) {
  if (!els.workspaceStatus) return;
  if (workspaceStatusClearTimer) {
    clearTimeout(workspaceStatusClearTimer);
    workspaceStatusClearTimer = null;
  }
  const message = String(text || "").trim();
  els.workspaceStatus.textContent = message;
  if (status) els.workspaceStatus.dataset.status = status;
  else els.workspaceStatus.removeAttribute("data-status");
  els.workspaceStatus.hidden = !message;
  if (message && clearAfterMs > 0) {
    workspaceStatusClearTimer = setTimeout(() => {
      workspaceStatusClearTimer = null;
      if (!els.workspaceStatus) return;
      els.workspaceStatus.textContent = "";
      els.workspaceStatus.removeAttribute("data-status");
      els.workspaceStatus.hidden = true;
    }, clearAfterMs);
  }
}

/** 空闲不常驻；仅在用户点同步（announce）或导入/导出反馈时短暂展示。 */
export function renderWorkspaceStatus({ announce = false } = {}) {
  if (!els.workspaceStatus) return;
  const { status, updatedAt, error } = state.workspaceSync;
  if (!announce) {
    // 后台 hydrate / 自动落盘：不占版面
    if (status === "idle" || status === "synced" || status === "pending" || status === "syncing") {
      setWorkspaceStatusText("");
      return;
    }
    if (status === "offline") {
      setWorkspaceStatusText(`离线（仅浏览器缓存）${error ? ` · ${error}` : ""}`, {
        status: "offline",
        clearAfterMs: 6000,
      });
    }
    return;
  }
  if (status === "pending") {
    setWorkspaceStatusText("待同步…", { status: "pending" });
    return;
  }
  if (status === "syncing") {
    setWorkspaceStatusText("同步中…", { status: "syncing" });
    return;
  }
  if (status === "synced") {
    const time = formatWorkspaceLocalTime(updatedAt);
    setWorkspaceStatusText(time ? `已同步 · ${time}` : "已同步", {
      status: "synced",
      clearAfterMs: 3500,
    });
    return;
  }
  if (status === "offline") {
    setWorkspaceStatusText(`同步失败${error ? ` · ${error}` : ""}`, {
      status: "offline",
      clearAfterMs: 6000,
    });
    return;
  }
  setWorkspaceStatusText("");
}

export async function exportWorkspaceBackup() {
  try {
    const { readPlanFormIntoState } = await import("./views/etf.js");
    readPlanFormIntoState();
  } catch {
    /* plan form may be unavailable */
  }
  writeLocalWorkspaceCache();
  const payload = JSON.stringify(buildBackupPayload(), null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stockagent-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setWorkspaceStatusText("已导出定投计划与设置", { status: "synced", clearAfterMs: 3500 });
}

export async function importWorkspaceBackup(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!Array.isArray(payload.etfs)) throw new Error("备份文件缺少 etfs 字段");
    applyWorkspace(payload, "import");
    await persistWorkspace({ immediate: true });
    let settingsNote = "";
    if (hasSettingsSnapshot(payload)) {
      await applySettingsSnapshot(payload.settings);
      const { configureAutoRefresh } = await import("./auto-refresh.js");
      const { renderSettings } = await import("./settings.js");
      configureAutoRefresh();
      renderSettings();
      settingsNote = "与设置";
    }
    const { renderEtfPool, renderSidebarEtfs } = await import("./views/render.js");
    renderSidebarEtfs();
    await renderEtfPool({ refresh: true });
    setWorkspaceStatusText(`已导入定投计划${settingsNote}`, { status: "synced", clearAfterMs: 3500 });
  } catch (error) {
    setWorkspaceStatusText(`导入失败：${error}`, { status: "error", clearAfterMs: 6000 });
  } finally {
    event.target.value = "";
  }
}
