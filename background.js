const DEFAULT_SETTINGS = {
  keywords: "",
  enabled: false,
  maxItems: 200,
  refreshMinutes: 2,
  panelAlertEnabled: true,
  monitoredTabIds: []
};

const STORAGE_KEYS = {
  settings: "settings",
  matches: "matches",
  dedupSet: "dedupSet",
  alertState: "alertState"
};

let cacheSettings = { ...DEFAULT_SETTINGS };
let cacheMatches = [];
let cacheDedupSet = {};
let alertState = { unreadCount: 0, latestAt: "" };

init().catch((error) => {
  console.error("Init failed:", error);
});

async function init() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.matches,
    STORAGE_KEYS.dedupSet,
    STORAGE_KEYS.alertState
  ]);

  cacheSettings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  cacheSettings.monitoredTabIds = normalizeTabIds(cacheSettings.monitoredTabIds);
  cacheMatches = Array.isArray(stored[STORAGE_KEYS.matches]) ? stored[STORAGE_KEYS.matches] : [];
  cacheDedupSet = isObject(stored[STORAGE_KEYS.dedupSet]) ? stored[STORAGE_KEYS.dedupSet] : {};
  alertState = isObject(stored[STORAGE_KEYS.alertState])
    ? { unreadCount: 0, latestAt: "", ...stored[STORAGE_KEYS.alertState] }
    : { unreadCount: 0, latestAt: "" };

  registerListeners();
  await syncMonitoredTabs();
  await ensureRefreshAlarm();
}

function registerListeners() {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "watch-tabs" || !cacheSettings.enabled) return;
    await refreshMonitoredTabs();
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!cacheSettings.enabled || changeInfo.status !== "complete") return;
    if (!isMonitoredTab(tabId)) return;
    await scanTab(tabId, tab?.url || "");
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (!isMonitoredTab(tabId)) return;
    cacheSettings.monitoredTabIds = cacheSettings.monitoredTabIds.filter((id) => id !== tabId);
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: cacheSettings });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "getState") {
      getStatePayload().then((payload) => sendResponse(payload));
      return true;
    }

    if (message?.type === "listTabs") {
      listHttpTabs().then((tabs) => sendResponse({ ok: true, tabs }));
      return true;
    }

    if (message?.type === "addMonitoredTab") {
      addMonitoredTab(message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "removeMonitoredTab") {
      removeMonitoredTab(message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "toggleCurrentTabMonitoring") {
      toggleCurrentTabMonitoring(message.tabId)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "scanNow") {
      scanNow(message.tabId)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "saveSettings") {
      updateSettings(message.payload)
        .then(() => sendResponse({ ok: true, settings: cacheSettings }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "toggleMonitoring") {
      setMonitoring(Boolean(message.enabled))
        .then(() => sendResponse({ ok: true, enabled: cacheSettings.enabled }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "clearMatches") {
      clearMatchesAndDedup()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "markAlertsRead") {
      alertState.unreadCount = 0;
      chrome.storage.local
        .set({ [STORAGE_KEYS.alertState]: alertState })
        .then(() => sendResponse({ ok: true, alertState }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "exportData") {
      exportMatches(message.format)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
  });
}

async function getStatePayload() {
  const monitoredTabs = await getMonitoredTabsStatus();
  const currentTab = await getCurrentActiveTab();
  const currentTabMonitored = Boolean(currentTab?.id) && isMonitoredTab(currentTab.id);
  return {
    settings: cacheSettings,
    matches: cacheMatches,
    alertState,
    monitoredTabs,
    currentTab,
    currentTabMonitored
  };
}

async function listHttpTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id && isSupportedUrl(t.url || ""))
    .map((t) => ({ id: t.id, title: t.title || "(no title)", url: t.url || "" }));
}

async function addMonitoredTab(tabId) {
  const id = normalizeSingleTabId(tabId);
  if (!id) throw new Error("无效标签页");
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab || !isSupportedUrl(tab.url || "")) throw new Error("标签页不可监听");

  if (!cacheSettings.monitoredTabIds.includes(id)) {
    cacheSettings.monitoredTabIds.push(id);
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: cacheSettings });
  }
}

async function removeMonitoredTab(tabId) {
  const id = normalizeSingleTabId(tabId);
  if (!id) return;
  cacheSettings.monitoredTabIds = cacheSettings.monitoredTabIds.filter((x) => x !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: cacheSettings });
}

async function toggleCurrentTabMonitoring(tabId) {
  const current = tabId ? await getTabById(tabId) : await getCurrentActiveTab();
  if (!current?.id || !isSupportedUrl(current.url || "")) {
    throw new Error("当前标签页不可监听");
  }

  if (isMonitoredTab(current.id)) {
    await removeMonitoredTab(current.id);
    return { monitored: false, tabId: current.id };
  }

  await addMonitoredTab(current.id);
  return { monitored: true, tabId: current.id };
}

async function scanNow(tabId) {
  const current = tabId ? await getTabById(tabId) : await getCurrentActiveTab();
  if (!current?.id || !isSupportedUrl(current.url || "")) {
    throw new Error("当前标签页不可扫描");
  }

  await scanTab(current.id, current.url);
  return { tabId: current.id };
}

async function updateSettings(nextSettings) {
  cacheSettings = {
    ...cacheSettings,
    ...nextSettings,
    maxItems: normalizeNumber(nextSettings.maxItems, cacheSettings.maxItems, 10),
    refreshMinutes: normalizeNumber(nextSettings.refreshMinutes, cacheSettings.refreshMinutes, 1),
    enabled: Boolean(nextSettings.enabled ?? cacheSettings.enabled),
    panelAlertEnabled: Boolean(nextSettings.panelAlertEnabled ?? cacheSettings.panelAlertEnabled),
    monitoredTabIds: normalizeTabIds(nextSettings.monitoredTabIds ?? cacheSettings.monitoredTabIds)
  };

  await syncMonitoredTabs();
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: cacheSettings });
  await ensureRefreshAlarm();
}

async function setMonitoring(enabled) {
  cacheSettings.enabled = enabled;
  await syncMonitoredTabs();
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: cacheSettings });
  await ensureRefreshAlarm();
  if (enabled) await refreshMonitoredTabs();
}

async function ensureRefreshAlarm() {
  await chrome.alarms.clear("watch-tabs");
  if (!cacheSettings.enabled || !cacheSettings.monitoredTabIds.length) return;
  chrome.alarms.create("watch-tabs", {
    periodInMinutes: Math.max(1, cacheSettings.refreshMinutes || 1)
  });
}

async function refreshMonitoredTabs() {
  await syncMonitoredTabs();
  for (const tabId of cacheSettings.monitoredTabIds) {
    await chrome.tabs.reload(tabId).catch(() => null);
  }
}

async function scanTab(tabId, knownUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const targetUrl = knownUrl || tab?.url || "";
  if (!isMonitoredTab(tabId) || !isSupportedUrl(targetUrl)) return;

  const extracted = await chrome.scripting
    .executeScript({ target: { tabId }, func: extractPageContent })
    .then((result) => result?.[0]?.result || null)
    .catch(() => null);

  if (!extracted?.text) return;

  const matched = matchByKeywords(extracted.text, cacheSettings.keywords);
  if (!matched.hasMatch) return;

  const records = Array.isArray(matched.records) ? matched.records : [];
  let addedCount = 0;
  for (const record of records) {
    const dedupKey = makeDedupKey(String(tabId), targetUrl, record.keyword, record.snippet);
    if (cacheDedupSet[dedupKey]) continue;
    cacheDedupSet[dedupKey] = new Date().toISOString();

    const item = {
      id: makeId(String(tabId), targetUrl, record.keyword, extracted.pageTime, record.snippet),
      tabId,
      url: targetUrl,
      title: extracted.title || tab?.title || "(no title)",
      matchedKeywords: [record.keyword],
      matchText: record.keyword,
      snippetIndex: record.index,
      snippet: record.snippet,
      hasDetailPage: extracted.hasDetailPage,
      detailLinks: extracted.detailLinks || [],
      pageTime: extracted.pageTime,
      capturedAt: new Date().toISOString()
    };

    cacheMatches.unshift(item);
    addedCount += 1;
  }

  if (!addedCount) return;
  cacheMatches = cacheMatches
    .sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())
    .slice(0, cacheSettings.maxItems || DEFAULT_SETTINGS.maxItems);

  pruneDedupSet();
  bumpAlert(addedCount);
  await persistState();
}

function bumpAlert(increase = 1) {
  if (!cacheSettings.panelAlertEnabled) return;
  alertState.unreadCount = (alertState.unreadCount || 0) + Math.max(1, Number(increase) || 1);
  alertState.latestAt = new Date().toISOString();
}

async function clearMatchesAndDedup() {
  cacheMatches = [];
  cacheDedupSet = {};
  alertState.unreadCount = 0;
  await persistState();
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.matches]: cacheMatches,
    [STORAGE_KEYS.dedupSet]: cacheDedupSet,
    [STORAGE_KEYS.alertState]: alertState
  });
}

async function syncMonitoredTabs() {
  const valid = [];
  for (const tabId of normalizeTabIds(cacheSettings.monitoredTabIds)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.id && isSupportedUrl(tab.url || "")) valid.push(tab.id);
  }
  cacheSettings.monitoredTabIds = valid;
}

async function getMonitoredTabsStatus() {
  const result = [];
  for (const tabId of cacheSettings.monitoredTabIds) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id || !isSupportedUrl(tab.url || "")) continue;
    result.push({ id: tab.id, title: tab.title || "(no title)", url: tab.url || "" });
  }
  return result;
}

function isMonitoredTab(tabId) {
  return cacheSettings.monitoredTabIds.includes(Number(tabId));
}

function normalizeTabIds(value) {
  if (!Array.isArray(value)) return [];
  const uniq = new Set();
  for (const item of value) {
    const id = normalizeSingleTabId(item);
    if (id) uniq.add(id);
  }
  return Array.from(uniq);
}

function normalizeSingleTabId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseCsv(text) {
  return String(text || "")
    .split(/[;；,，]/)
    .map((x) => stripWrappingQuotes(x.trim().toLowerCase()))
    .filter(Boolean);
}

async function getCurrentActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return null;
  return { id: tab.id, title: tab.title || "(no title)", url: tab.url || "" };
}

async function getTabById(tabId) {
  const id = normalizeSingleTabId(tabId);
  if (!id) return null;
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab?.id) return null;
  return { id: tab.id, title: tab.title || "(no title)", url: tab.url || "" };
}

function isSupportedUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function matchByKeywords(text, keywordText) {
  const keywords = parseCsv(keywordText);
  if (!keywords.length) return { hasMatch: true, keywords: [], snippet: trimSnippet(text) };

  const normalizedText = normalizeForMatch(text);
  const matchedKeywords = keywords.filter((kw) => normalizedText.includes(normalizeForMatch(kw)));
  if (!matchedKeywords.length) return { hasMatch: false, keywords: [], snippet: "" };

  const records = buildKeywordRecords(text, matchedKeywords);
  return {
    hasMatch: true,
    keywords: matchedKeywords,
    snippet: records[0]?.snippet || trimSnippet(text),
    records
  };
}

function stripWrappingQuotes(text) {
  return String(text || "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/["'“”‘’]/g, "")
    .replace(/\s+/g, "");
}

function buildKeywordRecords(text, keywords) {
  const source = String(text || "");
  const lowered = source.toLowerCase();
  const records = [];

  for (const keyword of keywords) {
    const needle = String(keyword || "").toLowerCase().replace(/\s+/g, "");
    if (!needle) continue;

    let cursor = 0;
    let count = 0;
    while (cursor < lowered.length && count < 5) {
      const index = lowered.indexOf(needle, cursor);
      if (index < 0) break;
      const piece = trimSnippet(source, index);
      if (piece) {
        records.push({ keyword, snippet: piece, index: count + 1 });
      }
      cursor = index + Math.max(1, needle.length);
      count += 1;
    }
  }

  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = `${record.keyword}|${record.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique.slice(0, 24);
}

function trimSnippet(text, focusIndex = 0) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 220) return clean;
  const start = Math.max(0, focusIndex - 60);
  return clean.slice(start, start + 220).trim();
}

function makeId(tabId, url, keyword, pageTime, snippet) {
  return simpleHash(`${tabId}|${url}|${keyword || ""}|${pageTime || ""}|${snippet}`);
}

function makeDedupKey(tabId, url, keyword, snippet) {
  return simpleHash(`${tabId}|${url}|${keyword || ""}|${snippet}`);
}

function simpleHash(text) {
  let hash = 0;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return `h${Math.abs(hash)}`;
}

function normalizeNumber(value, fallback, minValue) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(minValue, Math.round(num));
}

function pruneDedupSet() {
  const entries = Object.entries(cacheDedupSet)
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, Math.max(500, (cacheSettings.maxItems || 200) * 5));
  cacheDedupSet = Object.fromEntries(entries);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function exportMatches(format) {
  const safeFormat = format === "csv" ? "csv" : "json";
  const filename = `page-watcher-${Date.now()}.${safeFormat}`;
  const content = safeFormat === "csv" ? toCsv(cacheMatches) : JSON.stringify(cacheMatches, null, 2);
  const url = `data:text/${safeFormat === "csv" ? "csv" : "json"};charset=utf-8,${encodeURIComponent(content)}`;
  await chrome.downloads.download({ url, filename, saveAs: true });
}

function toCsv(rows) {
  const headers = [
    "tabId",
    "title",
    "url",
    "matchText",
    "snippetIndex",
    "hasDetailPage",
    "detailLinks",
    "pageTime",
    "capturedAt",
    "snippet"
  ];
  const body = rows.map((row) => {
    return [
      row.tabId || "",
      row.title,
      row.url,
      row.matchText || (Array.isArray(row.matchedKeywords) ? row.matchedKeywords.join("|") : ""),
      row.snippetIndex || "",
      row.hasDetailPage ? "yes" : "no",
      Array.isArray(row.detailLinks) ? row.detailLinks.map((x) => x?.url || "").filter(Boolean).join(" | ") : "",
      row.pageTime || "",
      row.capturedAt || "",
      row.snippet || ""
    ]
      .map(csvEscape)
      .join(",");
  });
  return [headers.join(","), ...body].join("\n");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function extractPageContent() {
  const bodyText = (document.body?.innerText || "").slice(0, 120000);
  const links = Array.from(document.querySelectorAll("a[href]"));
  const detailLinks = links
    .map((link) => {
      const text = (link.textContent || "").trim();
      const href = link.getAttribute("href") || "";
      const absolute = resolveAbsoluteUrl(href);
      const isDetail =
        /详情|detail|read more|更多|查看/i.test(text) ||
        /detail|article|post|news|doc|content|thread/i.test(href);
      if (!isDetail || !absolute) return null;
      return { text: text || "详情", url: absolute };
    })
    .filter(Boolean);

  const hasDetailPage = detailLinks.length > 0 || links.some((link) => {
    const text = (link.textContent || "").trim();
    const href = link.getAttribute("href") || "";
    return /详情|detail|read more|更多|查看/i.test(text) || /detail|article|post|news/i.test(href);
  });
  const pageTime = detectTimeFromPage(bodyText);
  return {
    title: document.title,
    text: bodyText,
    hasDetailPage,
    detailLinks: detailLinks.slice(0, 8),
    pageTime
  };

  function detectTimeFromPage(innerBodyText) {
    const timeElement = document.querySelector("time");
    if (timeElement?.getAttribute("datetime")) return timeElement.getAttribute("datetime");
    if (timeElement?.textContent?.trim()) return timeElement.textContent.trim();
    const matched = innerBodyText.match(
      /\b(20\d{2}[-\/.年](0?[1-9]|1[0-2])[-\/.月](0?[1-9]|[12]\d|3[01])(?:日)?(?:\s+[0-2]?\d:[0-5]\d(?::[0-5]\d)?)?)\b/
    );
    return matched?.[1] || "";
  }

  function resolveAbsoluteUrl(href) {
    if (!href) return "";
    try {
      return new URL(href, window.location.href).toString();
    } catch {
      return "";
    }
  }
}
