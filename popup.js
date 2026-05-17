const el = {
  toggleCurrentTabBtn: document.getElementById("toggleCurrentTabBtn"),
  scanNowBtn: document.getElementById("scanNowBtn"),
  keywords: document.getElementById("keywords"),
  maxItems: document.getElementById("maxItems"),
  refreshMinutes: document.getElementById("refreshMinutes"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  saveBtn: document.getElementById("saveBtn"),
  clearBtn: document.getElementById("clearBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  markReadBtn: document.getElementById("markReadBtn"),
  alertInfo: document.getElementById("alertInfo"),
  status: document.getElementById("status"),
  monitoredList: document.getElementById("monitoredList"),
  matchList: document.getElementById("matchList"),
  tabBtnSettings: document.getElementById("tabBtnSettings"),
  tabBtnMonitored: document.getElementById("tabBtnMonitored"),
  tabBtnMatches: document.getElementById("tabBtnMatches"),
  matchBadge: document.getElementById("matchBadge")
};

let currentState = {
  settings: {},
  matches: [],
  alertState: { unreadCount: 0, latestAt: "" },
  monitoredTabs: [],
  currentTab: null,
  currentTabMonitored: false
};

let isEditing = false;
let popupTabId = null;

boot().catch((error) => setStatus(`初始化失败: ${error}`));

async function boot() {
  await resolvePopupTabId();
  await refreshState();
  bindEvents();
  window.setInterval(refreshState, 5000);
}

function bindEvents() {
  el.tabBtnSettings.addEventListener("click", () => switchTab("tab-settings"));
  el.tabBtnMonitored.addEventListener("click", () => switchTab("tab-monitored"));
  el.tabBtnMatches.addEventListener("click", () => switchTab("tab-matches"));
  el.toggleCurrentTabBtn.addEventListener("click", onToggleCurrentTab);
  el.scanNowBtn.addEventListener("click", onScanNow);
  el.saveBtn.addEventListener("click", onSaveSettings);
  el.startBtn.addEventListener("click", () => onToggleMonitoring(true));
  el.stopBtn.addEventListener("click", () => onToggleMonitoring(false));
  el.clearBtn.addEventListener("click", onClear);
  el.exportJsonBtn.addEventListener("click", () => onExport("json"));
  el.exportCsvBtn.addEventListener("click", () => onExport("csv"));
  el.markReadBtn.addEventListener("click", onMarkRead);
  el.keywords.addEventListener("input", () => {
    isEditing = true;
  });
}

async function switchTab(tabId) {
  const tabPanels = document.querySelectorAll(".tab-panel");
  const tabButtons = document.querySelectorAll(".tab-btn");

  for (const panel of tabPanels) {
    panel.classList.toggle("active", panel.id === tabId);
  }

  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  }

  if (tabId === "tab-matches" && (currentState.alertState?.unreadCount || 0) > 0) {
    await sendMessage({ type: "markAlertsRead" });
    currentState.alertState.unreadCount = 0;
    renderMatchBadge();
    renderAlert();
  }
}

async function refreshState() {
  const state = await sendMessage({ type: "getState" });
  currentState = {
    settings: state.settings || {},
    matches: state.matches || [],
    alertState: state.alertState || { unreadCount: 0, latestAt: "" },
    monitoredTabs: state.monitoredTabs || [],
    currentTab: state.currentTab || null,
    currentTabMonitored: Boolean(state.currentTabMonitored)
  };
  if (!isEditing) {
    applySettings(currentState.settings);
  }
  updateCurrentTabButton();
  renderMatchBadge();
  renderAlert();
  renderMonitoredTabs();
  renderMatches();
}

function renderMatchBadge() {
  const count = Number(currentState.alertState?.unreadCount || 0);
  if (count <= 0) {
    el.matchBadge.classList.add("hidden");
    el.matchBadge.textContent = "0";
    return;
  }
  el.matchBadge.classList.remove("hidden");
  el.matchBadge.textContent = count > 99 ? "99+" : String(count);
}

function applySettings(settings) {
  el.keywords.value = settings.keywords || "";
  el.maxItems.value = settings.maxItems || 200;
  el.refreshMinutes.value = settings.refreshMinutes || 2;
}

async function onToggleCurrentTab() {
  const result = await sendMessage({ type: "toggleCurrentTabMonitoring", tabId: popupTabId });
  if (!result.ok) {
    setStatus(`切换监听失败: ${result.error || "未知错误"}`);
    return;
  }
  setStatus(result.monitored ? "当前标签页已加入监听" : "当前标签页已移除监听");
  await refreshState();
}

async function onScanNow() {
  const result = await sendMessage({ type: "scanNow", tabId: popupTabId });
  if (!result.ok) {
    setStatus(`立即扫描失败: ${result.error || "未知错误"}`);
    return;
  }
  setStatus("已触发立即扫描");
  await refreshState();
}

async function onRemoveMonitoredTab(tabId) {
  const result = await sendMessage({ type: "removeMonitoredTab", tabId });
  if (!result.ok) {
    setStatus(`移除失败: ${result.error || "未知错误"}`);
    return;
  }
  setStatus("已移除监听");
  await refreshState();
}

async function onSaveSettings() {
  const payload = {
    keywords: el.keywords.value,
    maxItems: Number(el.maxItems.value || 200),
    refreshMinutes: Number(el.refreshMinutes.value || 2),
    enabled: currentState.settings.enabled,
    monitoredTabIds: currentState.monitoredTabs.map((t) => t.id)
  };
  const result = await sendMessage({ type: "saveSettings", payload });
  if (!result.ok) {
    setStatus(`保存失败: ${result.error || "未知错误"}`);
    return;
  }
  isEditing = false;
  setStatus("设置已保存");
  await refreshState();
}

async function onToggleMonitoring(enabled) {
  const result = await sendMessage({ type: "toggleMonitoring", enabled });
  if (!result.ok) {
    setStatus(`操作失败: ${result.error || "未知错误"}`);
    return;
  }
  setStatus(enabled ? "已开始监听" : "已停止监听");
  await refreshState();
}

async function onClear() {
  const result = await sendMessage({ type: "clearMatches" });
  if (!result.ok) return setStatus(`清空失败: ${result.error || "未知错误"}`);
  setStatus("列表已清空");
  await refreshState();
}

async function onExport(format) {
  const result = await sendMessage({ type: "exportData", format });
  if (!result.ok) return setStatus(`导出失败: ${result.error || "未知错误"}`);
  setStatus(format === "json" ? "已导出 JSON" : "已导出 CSV，可用 Excel 打开");
}

async function onMarkRead() {
  const result = await sendMessage({ type: "markAlertsRead" });
  if (!result.ok) return setStatus(`提醒清零失败: ${result.error || "未知错误"}`);
  setStatus("提醒已清零");
  await refreshState();
}

function renderAlert() {
  const s = currentState.settings;
  const a = currentState.alertState;
  el.alertInfo.textContent = [
    `状态:${s.enabled ? "监听中" : "未监听"}`,
    `当前页:${currentState.currentTab ? (currentState.currentTabMonitored ? "已监听" : "未监听") : "不可用"}`,
    `监听标签:${(currentState.monitoredTabs || []).length}`,
    `未读:${a.unreadCount || 0}`,
    `最近:${fmt(a.latestAt) || "无"}`
  ].join(" | ");
}

function updateCurrentTabButton() {
  const hasCurrent = Boolean(currentState.currentTab?.id) && Boolean(popupTabId) && Number(currentState.currentTab.id) === Number(popupTabId);
  el.toggleCurrentTabBtn.disabled = !hasCurrent;
  el.scanNowBtn.disabled = !hasCurrent;
  if (!hasCurrent) {
    el.toggleCurrentTabBtn.textContent = "当前标签页不可监听";
    return;
  }
  el.toggleCurrentTabBtn.textContent = currentState.currentTabMonitored ? "移除当前标签页监听" : "加入监听当前标签页";
}

async function resolvePopupTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        popupTabId = null;
        resolve();
        return;
      }
      popupTabId = tabs?.[0]?.id || null;
      resolve();
    });
  });
}

function renderMonitoredTabs() {
  el.monitoredList.innerHTML = "";
  if (!currentState.monitoredTabs.length) {
    const li = document.createElement("li");
    li.className = "match-item";
    li.textContent = "当前没有监听中的标签页";
    el.monitoredList.appendChild(li);
    return;
  }

  for (const tab of currentState.monitoredTabs) {
    const li = document.createElement("li");
    li.className = "match-item";
    const refreshText = tab.lastRefreshAt ? `最近刷新:${escapeHtml(fmt(tab.lastRefreshAt))}` : "最近刷新:无";
    li.innerHTML = `<strong>${escapeHtml(tab.title)}</strong><br><a href="${escapeAttr(tab.url)}" target="_blank" rel="noreferrer">${escapeHtml(tab.url)}</a><div class="meta">${refreshText}</div>`;

    const row = document.createElement("div");
    row.className = "actions";
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "移除监听";
    btn.addEventListener("click", () => onRemoveMonitoredTab(tab.id));
    row.appendChild(btn);
    li.appendChild(row);
    el.monitoredList.appendChild(li);
  }
}

function renderMatches() {
  const matches = currentState.matches || [];
  el.matchList.innerHTML = "";
  if (!matches.length) {
    const li = document.createElement("li");
    li.className = "match-item";
    li.textContent = "暂时没有匹配结果";
    el.matchList.appendChild(li);
    return;
  }

  for (const item of matches) {
    const li = document.createElement("li");
    li.className = "match-item";
    const keyword = item.matchText || (Array.isArray(item.matchedKeywords) && item.matchedKeywords.length ? item.matchedKeywords.join("/") : "(全部)");
    const detailLinks = Array.isArray(item.detailLinks) ? item.detailLinks : [];
    const detailHtml = detailLinks.length
      ? `<div class="meta">详情链接: ${detailLinks
          .slice(0, 3)
          .map((x) => `<a href="${escapeAttr(x.url || "")}" target="_blank" rel="noreferrer">${escapeHtml(x.text || x.url || "详情")}</a>`)
          .join(" | ")}</div>`
      : "";
    li.innerHTML = `<strong>${escapeHtml(item.title || "(无标题)")}</strong><br><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a><div class="meta">Tab:${item.tabId || "-"} | 关键词:${escapeHtml(keyword)} | 片段序号:${escapeHtml(String(item.snippetIndex || 1))} | 详情页:${item.hasDetailPage ? "有" : "无"} | 页面时间:${escapeHtml(item.pageTime || "未识别")} | 抓取:${escapeHtml(fmt(item.capturedAt))}</div>${detailHtml}<div class="snippet">${escapeHtml(shortSnippet(item.snippet || "", 80))}</div>`;
    el.matchList.appendChild(li);
  }
}

function shortSnippet(text, maxChars) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const limit = Math.max(10, Number(maxChars) || 80);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}...`;
}

function fmt(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString();
}

function setStatus(text) {
  el.status.textContent = text;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}
