import { MOBILE_SIDEBAR_MAX, PAGE_TITLES, SIDEBAR_COLLAPSE_MIN, SIDEBAR_KEY, THEME_KEY } from "./constants.js";
import { appConfig, els, state } from "./state.js";
import { registerRenderers, renderDividend, renderEtfPool, renderSettings, renderSidebarEtfs, openAnalysis } from "./views/render.js";

export function switchView(view) {
  if (view === "dividend") {
    const symbol = state.analysisSymbol || defaultAnalysisSymbol();
    if (symbol) {
      openAnalysis(symbol);
      return;
    }
    view = "home";
  }
  if (!PAGE_TITLES[view]) view = "home";
  state.activeView = view;
  if (view !== "dividend") state.analysisSymbol = null;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === `${view}View`));
  if (els.pageTitle) els.pageTitle.textContent = PAGE_TITLES[view] || "ETF Agent";
  if (els.pageSubtitle) {
    els.pageSubtitle.hidden = true;
    if (els.pageSubtitleText) els.pageSubtitleText.textContent = "";
    else els.pageSubtitle.textContent = "";
  }
  document.querySelector(`#${view}View`)?.scrollIntoView({ block: "start" });
  if (view === "home" || view === "etf") renderEtfPool();
  if (view === "settings") renderSettings();
  renderSidebarEtfs();
  closeMobileSidebar();
}

function defaultAnalysisSymbol() {
  const preferred = appConfig?.dividend?.etf_symbol || "512890";
  if (state.etfs.some((item) => item.symbol === preferred)) return preferred;
  return state.etfs[0]?.symbol || null;
}

export function setSourceStatus(label, statusKey = "connected") {
  if (els.topSourceStatus) els.topSourceStatus.textContent = label;
  document.body.dataset.quoteStatus = statusKey;
}

export function resolveTheme(stored) {
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 无本地偏好时默认收起；仅显式 expanded 才展开。 */
export function resolveSidebarPreference(stored) {
  return stored === "expanded" ? "expanded" : "collapsed";
}

export function initSidebar() {
  applySidebarForViewport({ persist: false });
  applyMobileSidebar(false);
}

export function toggleSidebar() {
  // 抽屉断点下侧栏始终全宽展示，不切换图标轨
  if (window.innerWidth < SIDEBAR_COLLAPSE_MIN) return;
  const next = document.documentElement.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
  applySidebar(next);
}

export function syncSidebarForViewport() {
  const width = window.innerWidth;
  if (width > MOBILE_SIDEBAR_MAX) {
    applyMobileSidebar(false);
  }
  applySidebarForViewport({ persist: false });
}

/** 桌面恢复收起偏好；抽屉断点强制展开布局（偏好仍留在 localStorage）。 */
function applySidebarForViewport({ persist = false } = {}) {
  if (window.innerWidth >= SIDEBAR_COLLAPSE_MIN) {
    applySidebar(resolveSidebarPreference(localStorage.getItem(SIDEBAR_KEY)), { persist });
    return;
  }
  applySidebar("expanded", { persist: false });
}

function applyMobileSidebar(open, { restoreFocus = false } = {}) {
  const mobileViewport = window.innerWidth <= MOBILE_SIDEBAR_MAX;
  const nextOpen = open && mobileViewport;
  const sidebar = document.querySelector("#appSidebar");
  if (nextOpen) document.documentElement.dataset.mobileSidebar = "open";
  else delete document.documentElement.dataset.mobileSidebar;
  if (sidebar) {
    sidebar.toggleAttribute("inert", mobileViewport && !nextOpen);
    if (mobileViewport) sidebar.setAttribute("aria-hidden", String(!nextOpen));
    else sidebar.removeAttribute("aria-hidden");
  }
  if (els.mobileSidebarToggle) {
    els.mobileSidebarToggle.setAttribute("aria-expanded", String(nextOpen));
    els.mobileSidebarToggle.setAttribute("aria-label", nextOpen ? "关闭导航" : "打开导航");
  }
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.setAttribute("aria-hidden", String(!nextOpen));
    els.sidebarBackdrop.tabIndex = nextOpen ? 0 : -1;
  }
  if (nextOpen) els.mobileSidebarClose?.focus();
  if (!nextOpen && restoreFocus) els.mobileSidebarToggle?.focus();
}

export function closeMobileSidebar({ restoreFocus = false } = {}) {
  applyMobileSidebar(false, { restoreFocus });
}

export function toggleMobileSidebar() {
  const open = document.documentElement.dataset.mobileSidebar === "open";
  applyMobileSidebar(!open, { restoreFocus: open });
}

export function applySidebar(next, { persist = true } = {}) {
  if (next === "collapsed") document.documentElement.dataset.sidebar = "collapsed";
  else delete document.documentElement.dataset.sidebar;
  if (persist) localStorage.setItem(SIDEBAR_KEY, next);
  if (els.sidebarToggle) {
    els.sidebarToggle.setAttribute("aria-expanded", next !== "collapsed" ? "true" : "false");
    els.sidebarToggle.setAttribute("aria-label", next === "collapsed" ? "展开侧边栏" : "收起侧边栏");
  }
}

export function initTheme() {
  applyTheme(document.documentElement.dataset.theme || resolveTheme(localStorage.getItem(THEME_KEY)));
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  if (els.themeToggle) {
    els.themeToggle.setAttribute("aria-label", theme === "dark" ? "切换到明亮模式" : "切换到暗黑模式");
    els.themeToggle.setAttribute("title", theme === "dark" ? "切换到明亮模式" : "切换到暗黑模式");
  }
  if (state.activeView === "dividend") renderDividend();
  if (state.activeView === "home" || state.activeView === "etf") renderEtfPool();
}

export function themeChartColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    grid: styles.getPropertyValue("--chart-grid").trim(),
    line: styles.getPropertyValue("--chart-line").trim(),
    label: styles.getPropertyValue("--chart-label").trim(),
  };
}

registerRenderers({ switchView });
