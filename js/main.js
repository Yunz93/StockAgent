import { initEls, setRuntimeInfo } from "./state.js";
import { loadAppConfig } from "./settings.js";
import { bindEvents } from "./events.js";
import { hydrateWorkspace, renderWorkspaceStatus } from "./workspace.js";
import { initSidebar, initTheme, switchView } from "./navigation.js";
import { renderEtfPool, renderSidebarEtfs } from "./views/render.js";
import { ensureMarketSentiment } from "./market-sentiment.js";
import { ensureGoldMacro } from "./gold-macro.js";
import "./views/dividend.js";
import "./views/etf.js";

async function loadRuntimeInfo() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) throw new Error(`runtime API ${response.status}`);
    setRuntimeInfo(await response.json());
  } catch {
    setRuntimeInfo({ ephemeral_storage: false });
  }
}

export async function init() {
  initEls();
  initTheme();
  initSidebar();
  bindEvents();
  await loadRuntimeInfo();
  await loadAppConfig();
  await hydrateWorkspace();
  renderWorkspaceStatus();
  renderSidebarEtfs();
  await Promise.all([
    renderEtfPool({ refresh: false }).catch(() => {}),
    ensureMarketSentiment({ refresh: false }).catch(() => {}),
    ensureGoldMacro({ refresh: false }).catch(() => {}),
  ]);
  switchView("home");
}

init();
