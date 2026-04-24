const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const kuromoji = require('kuromoji');

const DEFAULT_SETTINGS = {
  hotkey: 'CommandOrControl+Shift+J',
  launchAtLogin: true,
  translationEnabled: true,
  overlayPinned: false,
  overlayPosition: 'top-right',
  fontScale: 1,
  reviewEnabled: false,
  reviewIntervalMinutes: 30,
  reviewJitterPct: 30
};
const WORKDAY_START_HOUR = 8;
const WORKDAY_START_MINUTE = 0;
const WORKDAY_END_HOUR = 16;
const MIN_REVIEW_GAP_MS = 3 * 60 * 1000;

class LRUCache {
  constructor(limit = 200) {
    this.limit = Math.max(20, limit);
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

let tray = null;
let overlayWindow = null;
let reviewWindow = null;
let preferencesWindow = null;
let tokenizer = null;
let localDict = {};
let kanjiDict = {};
let localNameDict = {};
let settings = { ...DEFAULT_SETTINGS };
let reviewWords = [];
let reviewPopupTimer = null;
let reviewPopupVisible = false;
let reviewScheduleState = null;
let lastReviewPopupAtMs = 0;
const translationCache = new LRUCache(250);
let translationPythonBin = null;
let argosModelReady = null;
let argosInstallPromise = null;
let translationSetupMessage = '';
let debugMode = process.argv.includes('--debug');
const DEBUG_CAPTURE_DIR = path.join(__dirname, 'debug-captures');

function debugLog(step, payload) {
  if (!debugMode) return;
  const stamp = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[DEBUG ${stamp}] ${step}`);
  } else {
    console.log(`[DEBUG ${stamp}] ${step}`, payload);
  }
}

function secureWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    enableBlinkFeatures: '',
    experimentalFeatures: false
  };
}

function lockDownWindow(win) {
  if (!win || win.isDestroyed()) return;
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function isTrustedSender(event) {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return typeof url === 'string' && (
    url.startsWith('file://') ||
    url === 'about:blank' ||
    url === ''
  );
}

function requireTrustedSender(event, action) {
  if (isTrustedSender(event)) return;
  throw new Error(`Blocked untrusted IPC sender for ${action}`);
}

function normalizeOverlayPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  if (typeof payload.statusType === 'string') out.statusType = payload.statusType;
  if (typeof payload.statusMessage === 'string') out.statusMessage = payload.statusMessage.slice(0, 500);
  if (typeof payload.statusSubtext === 'string') out.statusSubtext = payload.statusSubtext.slice(0, 1000);
  if (Number.isFinite(payload.statusPercent)) out.statusPercent = Math.max(0, Math.min(100, Math.round(payload.statusPercent)));
  if (typeof payload.original === 'string') out.original = payload.original.slice(0, 20_000);
  if (typeof payload.definition === 'string') out.definition = payload.definition.slice(0, 20_000);
  if (typeof payload.translation === 'string') out.translation = payload.translation.slice(0, 20_000);
  if (Array.isArray(payload.tokens)) {
    out.tokens = payload.tokens.slice(0, 1500).map((token) => ({
      surface: (token?.surface || '').toString().slice(0, 150),
      reading: (token?.reading || '').toString().slice(0, 150),
      showRuby: !!token?.showRuby
    }));
  }
  if (typeof payload.originalLoading === 'boolean') out.originalLoading = payload.originalLoading;
  if (typeof payload.definitionLoading === 'boolean') out.definitionLoading = payload.definitionLoading;
  if (typeof payload.translationLoading === 'boolean') out.translationLoading = payload.translationLoading;
  if (payload.reviewMeta && typeof payload.reviewMeta === 'object') {
    out.reviewMeta = {
      leftToday: Number.isFinite(Number(payload.reviewMeta.leftToday)) ? Math.max(0, Math.round(Number(payload.reviewMeta.leftToday))) : 0,
      totalToday: Number.isFinite(Number(payload.reviewMeta.totalToday)) ? Math.max(0, Math.round(Number(payload.reviewMeta.totalToday))) : 0,
      nextReviewAt: (payload.reviewMeta.nextReviewAt || '').toString().trim().slice(0, 64)
    };
  }
  return out;
}

function resolveRuntimeAssetPath(fileName) {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', fileName);
    if (fs.existsSync(unpacked)) return unpacked;
    return path.join(process.resourcesPath, fileName);
  }
  return path.join(__dirname, fileName);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getReviewWordsPath() {
  return path.join(app.getPath('userData'), 'review-words.json');
}

function normalizeReviewWordEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const word = (entry.word || '').toString().trim().slice(0, 150);
  const sentenceOriginal = (entry.sentenceOriginal || '').toString().trim().slice(0, 20_000);
  if (!word || !sentenceOriginal) return null;
  const nowIso = new Date().toISOString();
  const dueAtCandidate = (entry.dueAt || '').toString().trim();
  const dueAt = Number.isFinite(Date.parse(dueAtCandidate)) ? new Date(dueAtCandidate).toISOString() : nowIso;
  const ease = Number.isFinite(Number(entry.ease)) ? Math.max(1.3, Math.min(3, Number(entry.ease))) : 2.5;
  const repetitions = Number.isFinite(Number(entry.repetitions)) ? Math.max(0, Math.round(Number(entry.repetitions))) : 0;
  const intervalDays = Number.isFinite(Number(entry.intervalDays)) ? Math.max(0, Number(entry.intervalDays)) : 0;
  return {
    id: (entry.id || '').toString().trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    word,
    reading: (entry.reading || '').toString().trim().slice(0, 150),
    definition: (entry.definition || '').toString().trim().slice(0, 2_000),
    sentenceOriginal,
    sentenceTranslation: (entry.sentenceTranslation || '').toString().trim().slice(0, 20_000),
    savedAt: (entry.savedAt || '').toString().trim() || nowIso,
    dueAt,
    ease,
    repetitions,
    intervalDays,
    lastReviewedAt: Number.isFinite(Date.parse(entry.lastReviewedAt || '')) ? new Date(entry.lastReviewedAt).toISOString() : '',
    lastRating: ['again', 'good', 'easy'].includes((entry.lastRating || '').toString()) ? entry.lastRating : ''
  };
}

async function saveReviewWords() {
  const safeList = reviewWords.map((entry) => normalizeReviewWordEntry(entry)).filter(Boolean);
  reviewWords = safeList;
  await fs.promises.writeFile(getReviewWordsPath(), JSON.stringify(reviewWords, null, 2), 'utf8');
}

function loadReviewWords() {
  const reviewWordsPath = getReviewWordsPath();
  try {
    if (fs.existsSync(reviewWordsPath)) {
      const parsed = JSON.parse(fs.readFileSync(reviewWordsPath, 'utf8'));
      reviewWords = Array.isArray(parsed) ? parsed.map((entry) => normalizeReviewWordEntry(entry)).filter(Boolean) : [];
      return;
    }
  } catch (err) {
    console.error('Failed to load review words; using empty list.', err);
  }
  reviewWords = [];
}

function sanitizeSettings(input) {
  const merged = { ...DEFAULT_SETTINGS, ...(input || {}) };
  merged.hotkey = (merged.hotkey || DEFAULT_SETTINGS.hotkey).toString().trim() || DEFAULT_SETTINGS.hotkey;
  merged.launchAtLogin = !!merged.launchAtLogin;
  merged.translationEnabled = !!merged.translationEnabled;
  merged.overlayPinned = !!merged.overlayPinned;
  merged.overlayPosition = ['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(merged.overlayPosition)
    ? merged.overlayPosition
    : DEFAULT_SETTINGS.overlayPosition;
  const nextScale = Number(merged.fontScale);
  merged.fontScale = Number.isFinite(nextScale) ? Math.max(0.8, Math.min(1.5, nextScale)) : 1;
  merged.reviewEnabled = !!merged.reviewEnabled;
  const nextReviewInterval = Number(merged.reviewIntervalMinutes);
  merged.reviewIntervalMinutes = Number.isFinite(nextReviewInterval) ? Math.max(1, Math.min(240, nextReviewInterval)) : DEFAULT_SETTINGS.reviewIntervalMinutes;
  const nextJitter = Number(merged.reviewJitterPct);
  merged.reviewJitterPct = Number.isFinite(nextJitter) ? Math.max(0, Math.min(95, nextJitter)) : DEFAULT_SETTINGS.reviewJitterPct;
  return merged;
}

function loadSettings() {
  const settingsPath = getSettingsPath();
  try {
    if (fs.existsSync(settingsPath)) {
      settings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      return;
    }
  } catch (err) {
    console.error('Failed to load settings; using defaults.', err);
  }
  settings = { ...DEFAULT_SETTINGS };
}

async function saveSettings(nextSettings) {
  settings = sanitizeSettings(nextSettings);
  await fs.promises.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function applyLaunchAtLoginSetting() {
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    openAsHidden: true
  });
}

function applyOverlayPosition(win, width, height) {
  const primary = screen.getPrimaryDisplay();
  const margin = 20;
  const topY = primary.workArea.y + 40;
  const bottomY = primary.workArea.y + primary.workArea.height - height - margin;
  const leftX = primary.workArea.x + margin;
  const rightX = primary.workArea.x + primary.workArea.width - width - margin;

  let x = rightX;
  let y = topY;
  if (settings.overlayPosition === 'top-left') {
    x = leftX;
    y = topY;
  } else if (settings.overlayPosition === 'bottom-right') {
    x = rightX;
    y = bottomY;
  } else if (settings.overlayPosition === 'bottom-left') {
    x = leftX;
    y = bottomY;
  }
  win.setPosition(x, y);
}

async function loadLocalDict() {
  const dictPath = path.join(__dirname, 'data', 'dict.json');
  try {
    if (fs.existsSync(dictPath)) {
      localDict = JSON.parse(await fs.promises.readFile(dictPath, 'utf8'));
      console.log('Loaded local dictionary entries:', Object.keys(localDict).length);
    } else {
      console.log('No local dict found at', dictPath);
    }
  } catch (e) {
    console.error('Failed to load local dict', e);
  }
}

async function loadLocalNameDict() {
  const dictPath = path.join(__dirname, 'data', 'name_dict.json');
  try {
    if (fs.existsSync(dictPath)) {
      localNameDict = JSON.parse(await fs.promises.readFile(dictPath, 'utf8'));
      console.log('Loaded local name dictionary entries:', Object.keys(localNameDict).length);
    } else {
      console.log('No local name dict found at', dictPath);
    }
  } catch (e) {
    console.error('Failed to load local name dict', e);
  }
}

async function loadKanjiDict() {
  const dictPath = path.join(__dirname, 'data', 'kanji_dict.json');
  try {
    if (fs.existsSync(dictPath)) {
      kanjiDict = JSON.parse(await fs.promises.readFile(dictPath, 'utf8'));
      console.log('Loaded local kanji entries:', Object.keys(kanjiDict).length);
    } else {
      console.log('No local kanji dict found at', dictPath);
    }
  } catch (e) {
    console.error('Failed to load local kanji dict', e);
  }
}

function isKanjiChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  if (!Number.isFinite(cp)) return false;
  return (
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xF900 && cp <= 0xFAFF)
  );
}

function lookupKanjiInfo(ch) {
  const literal = (ch || '').toString().trim();
  if (!literal || !isKanjiChar(literal)) return null;
  const value = kanjiDict[literal];
  if (!value || typeof value !== 'object') return null;
  const on = Array.isArray(value.on) ? value.on.filter(Boolean).slice(0, 16) : [];
  const kun = Array.isArray(value.kun) ? value.kun.filter(Boolean).slice(0, 16) : [];
  const meanings = Array.isArray(value.meanings) ? value.meanings.filter(Boolean).slice(0, 20) : [];
  const nanori = Array.isArray(value.nanori) ? value.nanori.filter(Boolean).slice(0, 8) : [];
  return {
    literal,
    on,
    kun,
    meanings,
    nanori,
    grade: Number.isFinite(value.grade) ? value.grade : null,
    jlpt: Number.isFinite(value.jlpt) ? value.jlpt : null,
    strokes: Number.isFinite(value.strokes) ? value.strokes : null,
    freq: Number.isFinite(value.freq) ? value.freq : null
  };
}

function normalizeLookupKey(value) {
  return (value || '')
    .toString()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[。、，,\.\(\)\[\]「」『』【】]/g, '');
}

function definitionFromDictValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(Boolean).join('; ');
  if (typeof value === 'object') {
    if (Array.isArray(value.definitions)) return value.definitions.filter(Boolean).join('; ');
    if (typeof value.definition === 'string') return value.definition;
  }
  return '';
}

function showTranslationProgress(message, percent) {
  const payload = {
    statusType: 'translation-progress',
    statusMessage: message,
    statusPercent: Math.max(0, Math.min(100, Math.round(percent || 0))),
    statusSubtext: 'One-time setup installs translation dependencies and the Japanese-English model locally.'
  };
  translationSetupMessage = '';
  sendOverlayPayload(createOverlayWindow(), payload);
}

function showTranslationStatusError(title, subtext) {
  const payload = {
    statusType: 'translation-error',
    statusMessage: title,
    statusSubtext: subtext || 'Translation setup did not complete.'
  };
  translationSetupMessage = `${title}${subtext ? ` ${subtext}` : ''}`.trim();
  sendOverlayPayload(createOverlayWindow(), payload);
}

function sendOverlayPayload(win, payload) {
  if (!win || win.isDestroyed()) return;
  const withSettings = { ...payload, fontScale: settings.fontScale };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('show-result', withSettings);
      win.show();
      win.focus();
    });
    return;
  }
  win.webContents.send('show-result', withSettings);
  win.show();
  win.focus();
}

function pushOverlayResult(payload) {
  showOverlayPayload(payload);
}

function clearReviewPopupTimer() {
  if (reviewPopupTimer) {
    clearTimeout(reviewPopupTimer);
    reviewPopupTimer = null;
  }
}

function stopReviewPopups() {
  clearReviewPopupTimer();
  reviewPopupVisible = false;
  reviewScheduleState = null;
}

function getWorkdayBounds(now = new Date()) {
  const start = new Date(now);
  start.setHours(WORKDAY_START_HOUR, WORKDAY_START_MINUTE, 0, 0);
  const end = new Date(now);
  end.setHours(WORKDAY_END_HOUR, 0, 0, 0);
  return { start, end };
}

function inWorkdayWindow(now = new Date()) {
  const { start, end } = getWorkdayBounds(now);
  return now >= start && now <= end;
}

function getNextWorkdayStart(now = new Date()) {
  const { start, end } = getWorkdayBounds(now);
  if (now < start) return start;
  if (now <= end) return now;
  const nextDay = new Date(now);
  nextDay.setDate(now.getDate() + 1);
  nextDay.setHours(WORKDAY_START_HOUR, WORKDAY_START_MINUTE, 0, 0);
  return nextDay;
}

function getDueReviewCards(now = new Date()) {
  const { end } = getWorkdayBounds(now);
  const endMs = end.getTime();
  return reviewWords.filter((entry) => {
    const dueMs = Date.parse(entry?.dueAt || '');
    return Number.isFinite(dueMs) && dueMs <= endMs;
  });
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function buildDailyReviewSchedule(now = new Date()) {
  const dueCards = getDueReviewCards(now);
  if (dueCards.length === 0) return null;
  const { start, end } = getWorkdayBounds(now);
  const totalWindowMs = Math.max(60_000, end.getTime() - start.getTime());
  const slotMs = Math.max(MIN_REVIEW_GAP_MS, Math.floor(totalWindowMs / dueCards.length));
  const ids = shuffleInPlace(dueCards.map((entry) => entry.id));
  const slots = ids.map((id, index) => {
    const base = start.getTime() + (index * slotMs);
    const jitter = Math.floor((Math.random() - 0.5) * Math.min(slotMs * 0.8, 25 * 60 * 1000));
    const clamped = Math.max(start.getTime(), Math.min(end.getTime(), base + jitter));
    return { id, atMs: clamped };
  }).sort((a, b) => a.atMs - b.atMs);
  // Keep at least 3 minutes between review popups.
  for (let i = 1; i < slots.length; i += 1) {
    const minAllowed = slots[i - 1].atMs + MIN_REVIEW_GAP_MS;
    if (slots[i].atMs < minAllowed) slots[i].atMs = minAllowed;
  }
  for (let i = slots.length - 2; i >= 0; i -= 1) {
    const maxAllowed = slots[i + 1].atMs - MIN_REVIEW_GAP_MS;
    if (slots[i].atMs > maxAllowed) slots[i].atMs = maxAllowed;
  }
  for (const slot of slots) {
    slot.atMs = Math.max(start.getTime(), Math.min(end.getTime(), slot.atMs));
  }
  const key = `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
  return { key, slots, consumed: new Set() };
}

function getNextDueSlot(now = new Date()) {
  const { start } = getWorkdayBounds(now);
  const key = `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
  if (!reviewScheduleState || reviewScheduleState.key !== key) {
    reviewScheduleState = buildDailyReviewSchedule(now);
  }
  if (!reviewScheduleState) return null;
  let earliestFuture = null;
  for (const slot of reviewScheduleState.slots) {
    if (reviewScheduleState.consumed.has(slot.id)) continue;
    const entry = reviewWords.find((word) => word.id === slot.id);
    if (!entry) {
      reviewScheduleState.consumed.add(slot.id);
      continue;
    }
    const dueMs = Date.parse(entry.dueAt || '');
    if (!Number.isFinite(dueMs) || dueMs > now.getTime()) {
      if (Number.isFinite(dueMs)) {
        const candidateAtMs = Math.max(slot.atMs, dueMs);
        if (!earliestFuture || candidateAtMs < earliestFuture.atMs) {
          earliestFuture = { id: slot.id, atMs: candidateAtMs };
        }
      } else {
        reviewScheduleState.consumed.add(slot.id);
      }
      continue;
    }
    return slot;
  }
  return earliestFuture;
}

function getReviewMeta(now = new Date(), options = {}) {
  const { start } = getWorkdayBounds(now);
  const key = `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
  if (!reviewScheduleState || reviewScheduleState.key !== key) {
    reviewScheduleState = buildDailyReviewSchedule(now);
  }
  if (!reviewScheduleState) return { leftToday: 0, totalToday: 0, nextReviewAt: '' };
  const totalToday = reviewScheduleState.slots.length;
  const pendingSlots = reviewScheduleState.slots.filter((slot) => !reviewScheduleState.consumed.has(slot.id));
  let nextAtMs = null;
  for (const slot of pendingSlots) {
    const entry = reviewWords.find((word) => word.id === slot.id);
    if (!entry) continue;
    const dueMs = Date.parse(entry.dueAt || '');
    if (!Number.isFinite(dueMs)) continue;
    const candidateAtMs = Math.max(slot.atMs, dueMs);
    if (!Number.isFinite(nextAtMs) || candidateAtMs < nextAtMs) nextAtMs = candidateAtMs;
  }
  const includeCardId = (options?.includeCardId || '').toString().trim();
  const includesCurrent = includeCardId ? pendingSlots.some((slot) => slot.id === includeCardId) : false;
  const leftToday = pendingSlots.length + (includeCardId && !includesCurrent ? 1 : 0);
  return {
    leftToday,
    totalToday,
    nextReviewAt: Number.isFinite(nextAtMs) ? new Date(nextAtMs).toISOString() : ''
  };
}

function getTodayReviewStats(now = new Date()) {
  const meta = getReviewMeta(now);
  const left = Math.max(0, Number(meta.leftToday) || 0);
  const total = Math.max(0, Number(meta.totalToday) || 0);
  return { left, total, done: Math.max(0, total - left) };
}

function getNextPendingReviewSlot(now = new Date()) {
  const { start } = getWorkdayBounds(now);
  const key = `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
  if (!reviewScheduleState || reviewScheduleState.key !== key) {
    reviewScheduleState = buildDailyReviewSchedule(now);
  }
  if (!reviewScheduleState) return null;
  let next = null;
  for (const slot of reviewScheduleState.slots) {
    if (reviewScheduleState.consumed.has(slot.id)) continue;
    const entry = reviewWords.find((word) => word.id === slot.id);
    if (!entry) continue;
    const dueMs = Date.parse(entry.dueAt || '');
    if (!Number.isFinite(dueMs)) continue;
    const candidate = { id: slot.id, atMs: Math.max(slot.atMs, dueMs) };
    if (!next || candidate.atMs < next.atMs) next = candidate;
  }
  return next;
}

function showReviewCardNow(card, now = new Date()) {
  if (!card) return false;
  reviewPopupVisible = true;
  lastReviewPopupAtMs = now.getTime();
  if (reviewScheduleState) reviewScheduleState.consumed.add(card.id);
  const sentenceTokens = buildSentenceTokensForReview(card.sentenceOriginal || '');
  showOverlayPayload({
    statusType: 'review-card',
    reviewCard: {
      ...card,
      sentenceTokens
    },
    reviewMeta: getReviewMeta(now, { includeCardId: card.id })
  }, { noFocus: true, reviewBottomRight: true, useReviewWindow: true });
  return true;
}

function showNextReviewFromTray() {
  const now = new Date();
  const slot = getNextPendingReviewSlot(now);
  if (!slot) {
    showOverlayPayload({
      statusType: 'translation-progress',
      statusMessage: 'No reviews left for today.',
      statusSubtext: 'You are caught up. Add words from captures to review later.',
      statusPercent: 100
    }, { noFocus: true, reviewBottomRight: true, useReviewWindow: true });
    refreshTrayMenu();
    return;
  }
  const card = reviewWords.find((entry) => entry.id === slot.id) || null;
  if (!card) return;
  showReviewCardNow(card, now);
  refreshTrayMenu();
  scheduleNextReviewPopup();
}

function buildTrayMenu() {
  const stats = getTodayReviewStats();
  return Menu.buildFromTemplate([
    {
      label: `Reviews Today: ${stats.left} left / ${stats.done} done`,
      click: () => showNextReviewFromTray()
    },
    { type: 'separator' },
    {
      label: 'Debug Mode',
      type: 'checkbox',
      checked: debugMode,
      click: (item) => {
        debugMode = item.checked;
        refreshTrayMenu();
      }
    },
    { type: 'separator' },
    { label: 'Preferences', click: () => openPreferencesWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function pickBottomRightReviewPosition(win) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const size = win.getSize();
  const margin = 20;
  const x = Math.max(area.x + margin, area.x + area.width - size[0] - margin);
  const y = Math.max(area.y + margin, area.y + area.height - size[1] - margin);
  return { x, y };
}

function buildSentenceTokensForReview(sentence) {
  const text = (sentence || '').toString().trim();
  if (!text || !tokenizer) return [];
  try {
    const parsed = tokenizer.tokenize(text).filter((token) => token?.surface_form && token.surface_form !== ' ');
    const tokens = [];
    const seen = new Set();
    for (const token of parsed) {
      const surface = (token.surface_form || '').toString();
      const readingKatakana = (token.reading || token.pronunciation || '').toString();
      const reading = readingKatakana && readingKatakana !== '*' ? katakanaToHiragana(readingKatakana) : '';
      if (!surface || !reading) continue;
      const key = `${surface}::${reading}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push({ surface, reading });
    }
    return tokens;
  } catch {
    return [];
  }
}

function showOverlayPayload(payload, options = {}) {
  const win = options.useReviewWindow ? createReviewWindow() : createOverlayWindow();
  const withSettings = { ...payload, fontScale: settings.fontScale };
  const sendAndShow = () => {
    if (!win || win.isDestroyed()) return;
    if (options.reviewBottomRight) {
      const pos = pickBottomRightReviewPosition(win);
      win.setPosition(pos.x, pos.y);
    }
    win.webContents.send('show-result', withSettings);
    if (options.noFocus) {
      win.showInactive();
      win.moveTop();
      return;
    }
    win.show();
    win.moveTop();
    win.focus();
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', sendAndShow);
    return;
  }
  sendAndShow();
}

function scheduleNextReviewPopup() {
  clearReviewPopupTimer();
  if (!settings.reviewEnabled) return;
  const now = new Date();
  const cooldownUntil = lastReviewPopupAtMs + MIN_REVIEW_GAP_MS;
  if (cooldownUntil > now.getTime()) {
    const cooldownDelay = Math.max(1_000, cooldownUntil - now.getTime());
    reviewPopupTimer = setTimeout(scheduleNextReviewPopup, cooldownDelay);
    return;
  }
  if (!inWorkdayWindow(now)) {
    const nextStart = getNextWorkdayStart(now);
    const delayMs = Math.max(5000, nextStart.getTime() - now.getTime());
    reviewPopupTimer = setTimeout(scheduleNextReviewPopup, delayMs);
    return;
  }
  const nextSlot = getNextDueSlot(now);
  if (!nextSlot) {
    const nextStart = getNextWorkdayStart(new Date(now.getTime() + 60 * 1000));
    const delayMs = Math.max(60_000, nextStart.getTime() - now.getTime());
    reviewPopupTimer = setTimeout(scheduleNextReviewPopup, delayMs);
    return;
  }
  const earliestAllowedAt = Math.max(nextSlot.atMs, lastReviewPopupAtMs + MIN_REVIEW_GAP_MS);
  const delayMs = Math.max(1_000, earliestAllowedAt - now.getTime());
  reviewPopupTimer = setTimeout(() => {
    if (settings.reviewEnabled) {
      const card = reviewWords.find((entry) => entry.id === nextSlot.id) || null;
      if (card) {
        showReviewCardNow(card, new Date());
      }
    }
    refreshTrayMenu();
    scheduleNextReviewPopup();
  }, delayMs);
}

function startReviewScheduler() {
  if (!settings.reviewEnabled) {
    stopReviewPopups();
    return;
  }
  reviewScheduleState = null;
  refreshTrayMenu();
  scheduleNextReviewPopup();
}

function getPythonCandidates() {
  return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
}

async function resolvePythonBin(scriptPath) {
  if (translationPythonBin) return translationPythonBin;
  for (const pythonBin of getPythonCandidates()) {
    try {
      await execFileAsync(pythonBin, [scriptPath, '--check-model'], { maxBuffer: 1024 * 1024 });
      translationPythonBin = pythonBin;
      return translationPythonBin;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        translationPythonBin = pythonBin;
        return translationPythonBin;
      }
    }
  }
  return null;
}

async function checkArgosModel(scriptPath, pythonBin) {
  try {
    const { stdout } = await execFileAsync(pythonBin, [scriptPath, '--check-model'], { maxBuffer: 1024 * 1024 });
    return (stdout || '').trim() === 'ready';
  } catch (err) {
    debugLog('translation:check-model-failed', { message: err?.message, stderr: err?.stderr || '' });
    return false;
  }
}

async function checkArgosRuntime(pythonBin) {
  try {
    await execFileAsync(pythonBin, ['-c', 'import argostranslate'], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function installArgosModelWithProgress(scriptPath, pythonBin) {
  return new Promise((resolve) => {
    showTranslationProgress('Preparing offline translation model...', 60);
    const child = spawn(pythonBin, [scriptPath, '--install-model'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        const m = trimmed.match(/^PROGRESS:(\d{1,3}):(.*)$/);
        if (!m) continue;
        const stepPercent = Number(m[1]);
        const mapped = 60 + Math.round((Math.max(0, Math.min(100, stepPercent)) / 100) * 40);
        showTranslationProgress(m[2].trim() || 'Downloading model...', mapped);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ ok: code === 0, stderr: (stderr || '').trim() }));
  });
}

function debugCaptureFileName(sourceTag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${sourceTag}.png`;
}

async function saveDebugCaptureCopy(filePath, sourceTag) {
  if (!debugMode) return null;
  try {
    await fs.promises.mkdir(DEBUG_CAPTURE_DIR, { recursive: true });
    const outputPath = path.join(DEBUG_CAPTURE_DIR, debugCaptureFileName(sourceTag || 'capture'));
    await fs.promises.copyFile(filePath, outputPath);
    return outputPath;
  } catch (err) {
    debugLog('capture:debug-save-failed', {
      sourceTag,
      message: err?.message || String(err)
    });
    return null;
  }
}

function getNativeImageMeta(image) {
  const size = image?.getSize?.() || { width: 0, height: 0 };
  return {
    width: Number(size.width) || 0,
    height: Number(size.height) || 0,
    isEmpty: !!image?.isEmpty?.()
  };
}

async function ensureArgosModelInstalled(scriptPath) {
  if (!settings.translationEnabled) return false;
  if (argosModelReady === true) return true;
  if (argosInstallPromise) return argosInstallPromise;

  const pythonBin = await resolvePythonBin(scriptPath);
  if (!pythonBin) {
    showTranslationStatusError(
      'Python runtime not found for translation.',
      'Install python3, then run: pip install argostranslate sentencepiece'
    );
    return false;
  }

  let ready = await checkArgosModel(scriptPath, pythonBin);
  if (ready) {
    argosModelReady = true;
    return true;
  }

  argosInstallPromise = new Promise((resolve) => {
    (async () => {
      try {
        const runtimeReady = await checkArgosRuntime(pythonBin);
        if (!runtimeReady) {
          argosModelReady = false;
          showTranslationStatusError(
            'Translation dependencies are missing.',
            'For security, automatic dependency installation is disabled. Run: python3 -m pip install argostranslate sentencepiece'
          );
          return resolve(false);
        }

        ready = await checkArgosModel(scriptPath, pythonBin);
        if (ready) {
          argosModelReady = true;
          showTranslationProgress('Offline translation model is ready.', 100);
          return resolve(true);
        }

        const modelInstall = await installArgosModelWithProgress(scriptPath, pythonBin);
        if (modelInstall.ok) {
          argosModelReady = true;
          showTranslationProgress('Offline translation model is ready.', 100);
          return resolve(true);
        }
        argosModelReady = false;
        showTranslationStatusError(
          'Translation model setup failed.',
          'Check terminal logs, then retry screenshot translation.'
        );
        resolve(false);
      } catch (err) {
        debugLog('translation:bootstrap-exception', { message: err?.message || String(err) });
        argosModelReady = false;
        showTranslationStatusError(
          'Translation setup hit an unexpected error.',
          'Check terminal logs, then retry screenshot translation.'
        );
        resolve(false);
      } finally {
        argosInstallPromise = null;
      }
    })();
  });

  return argosInstallPromise;
}

async function translateSentence(originalText) {
  if (!settings.translationEnabled) return '';
  const text = (originalText || '').toString().trim();
  if (!text) return '';

  const cached = translationCache.get(text);
  if (cached) return cached;

  const scriptPath = resolveRuntimeAssetPath('python_translate.py');
  if (!fs.existsSync(scriptPath)) return '';

  const modelReady = await ensureArgosModelInstalled(scriptPath);
  if (!modelReady) return translationSetupMessage || '';

  const pythonBin = await resolvePythonBin(scriptPath);
  if (!pythonBin) return '';

  try {
    const { stdout } = await execFileAsync(pythonBin, [scriptPath, text], { maxBuffer: 1024 * 1024 });
    const translated = (stdout || '').trim();
    if (translated) translationCache.set(text, translated);
    translationSetupMessage = '';
    return translated;
  } catch (err) {
    debugLog('translation:error', { message: err?.message, stderr: err?.stderr || '' });
    return '';
  }
}

function katakanaToHiragana(str) {
  return (str || '').replace(/[\u30A1-\u30F6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

async function tokenizeAndLookup(recognizedText) {
  const text = (recognizedText || '').toString();
  const normalizedText = normalizeLookupKey(text);
  if (!tokenizer) {
    return { tokens: [], definition: 'Tokenizer is not ready yet.', debug: { normalizedText, tokens: [] } };
  }

  try {
    const tokens = tokenizer.tokenize(normalizedText).filter((t) => t.surface_form && t.surface_form !== ' ');
    const safeTokens = tokens.map((t) => {
      const surface = t.surface_form;
      const reading = t.reading || t.pronunciation || '';
      const hira = reading && reading !== '*' ? katakanaToHiragana(reading) : '';
      return {
        surface,
        reading: hira,
        showRuby: !!hira && surface !== hira
      };
    });

    const defs = [];
    const seenKeys = new Set();
    const seenSurface = new Set();
    const tokenDebug = [];
    for (const tk of tokens) {
      const candidates = [
        tk.basic_form && tk.basic_form !== '*' ? tk.basic_form : null,
        tk.surface_form || null,
        tk.reading && tk.reading !== '*' ? katakanaToHiragana(tk.reading) : null
      ].map(normalizeLookupKey).filter(Boolean);

      let matched = false;
      let matchedKey = null;
      let matchedDefinition = null;
      for (const key of candidates) {
        if (seenKeys.has(key)) continue;
        const dictValue = localDict[key] || localNameDict[key];
        const textDef = definitionFromDictValue(dictValue);
        if (!textDef) continue;
        defs.push(`${tk.surface_form}: ${textDef}`);
        seenKeys.add(key);
        seenSurface.add(tk.surface_form);
        matched = true;
        matchedKey = key;
        matchedDefinition = textDef;
        break;
      }
      if (!matched && !seenSurface.has(tk.surface_form) && ['名詞', '動詞', '形容詞', '副詞'].includes(tk.pos)) {
        defs.push(`${tk.surface_form}: (no local dictionary entry)`);
        seenSurface.add(tk.surface_form);
      }
      tokenDebug.push({
        surface: tk.surface_form,
        basic: tk.basic_form,
        pos: tk.pos,
        reading: tk.reading,
        candidates,
        matched,
        matchedKey,
        matchedDefinition
      });
    }

    const definition = defs.length > 0 ? defs.join('\n') : 'No dictionary matches found for this capture.';
    return { tokens: safeTokens, definition, debug: { normalizedText, tokens: tokenDebug } };
  } catch (e) {
    console.error('Tokenize/lookup failed', e);
    return { tokens: [], definition: 'Failed to tokenize recognized text.', debug: { normalizedText, tokens: [] } };
  }
}

function createTray() {
  const svgPath = path.join(__dirname, 'iconTemplate.svg');
  let icon = null;
  if (fs.existsSync(svgPath)) {
    const loaded = nativeImage.createFromPath(svgPath);
    if (!loaded.isEmpty()) {
      icon = loaded;
      icon.setTemplateImage(true);
    }
  }
  tray = new Tray(icon || nativeImage.createEmpty());
  if (!icon) tray.setTitle('日');
  else tray.setTitle('');
  tray.setToolTip('Screenshot Translate');
  refreshTrayMenu();
}

function createOverlayWindow() {
  if (overlayWindow) return overlayWindow;
  const width = 560;
  const height = 180;
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: secureWebPreferences()
  });
  lockDownWindow(overlayWindow);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  applyOverlayPosition(overlayWindow, width, height);
  overlayWindow.on('blur', () => {
    if (reviewPopupVisible) return;
    if (overlayWindow && !overlayWindow.isDestroyed() && !settings.overlayPinned) overlayWindow.close();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  return overlayWindow;
}

function createReviewWindow() {
  if (reviewWindow && !reviewWindow.isDestroyed()) return reviewWindow;
  const width = 560;
  const height = 180;
  reviewWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: secureWebPreferences()
  });
  lockDownWindow(reviewWindow);
  reviewWindow.loadFile(path.join(__dirname, 'overlay.html'));
  reviewWindow.on('closed', () => {
    reviewWindow = null;
    reviewPopupVisible = false;
  });
  return reviewWindow;
}

function openPreferencesWindow() {
  if (preferencesWindow && !preferencesWindow.isDestroyed()) {
    preferencesWindow.focus();
    return;
  }
  preferencesWindow = new BrowserWindow({
    width: 720,
    height: 620,
    title: 'Preferences',
    resizable: false,
    webPreferences: secureWebPreferences()
  });
  lockDownWindow(preferencesWindow);
  preferencesWindow.loadFile(path.join(__dirname, 'preferences.html'));
  preferencesWindow.on('closed', () => { preferencesWindow = null; });
}

function registerGlobalHotkey() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(settings.hotkey, () => {
    handleGlobalCaptureHotkey().catch((err) => {
      console.error('Global capture hotkey failed:', err);
    });
  });
  if (!ok) console.warn(`Global shortcut registration failed for "${settings.hotkey}"`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForImageFileReady(filePath, maxAttempts = 8, delayMs = 60) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 0) {
        const image = nativeImage.createFromPath(filePath);
        if (image && !image.isEmpty()) return;
      }
    } catch {
      // File may not be visible immediately; retry.
    }
    await sleep(delayMs);
  }
  throw new Error('Captured image file was not ready for OCR.');
}

async function runOcrWithRetry(imagePath) {
  const binPath = resolveRuntimeAssetPath('mac-ocr');
  if (!fs.existsSync(binPath)) throw new Error(`OCR binary not found at runtime path: ${binPath}`);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      debugLog('ocr:attempt', { attempt, imagePath });
      return await execFileAsync(binPath, [imagePath]);
    } catch (err) {
      const combined = `${err?.message || ''}\n${err?.stderr || ''}`;
      const failedToLoad = /Failed to load image/i.test(combined);
      debugLog('ocr:attempt-failed', {
        attempt,
        imagePath,
        failedToLoad,
        message: err?.message || String(err),
        stderr: err?.stderr || ''
      });
      if (!failedToLoad || attempt === maxAttempts) throw err;
      await sleep(80 * attempt);
    }
  }
  throw new Error('OCR failed unexpectedly.');
}

async function processCapturedImageFile(tempFilePath, sourceTag = 'unknown') {
  await waitForImageFileReady(tempFilePath);
  const stat = await fs.promises.stat(tempFilePath);
  const img = nativeImage.createFromPath(tempFilePath);
  const imgMeta = getNativeImageMeta(img);
  debugLog('capture:file-ready', {
    source: sourceTag,
    tempFilePath,
    bytes: stat.size,
    ...imgMeta
  });
  console.log(`[capture] source=${sourceTag} bytes=${stat.size} size=${imgMeta.width}x${imgMeta.height} path=${tempFilePath}`);

  pushOverlayResult({
    statusType: 'result-loading',
    originalLoading: true,
    definitionLoading: true,
    translationLoading: settings.translationEnabled
  });

  const { stdout } = await runOcrWithRetry(tempFilePath);
  const text = (stdout || '').trim();

  const tokenPromise = tokenizeAndLookup(text);
  const translationPromise = settings.translationEnabled ? translateSentence(text) : Promise.resolve('');

  pushOverlayResult({ statusType: 'result-partial', original: text, originalLoading: false });

  tokenPromise.then((tokenResult) => {
    pushOverlayResult({
      statusType: 'result-partial',
      tokens: tokenResult.tokens,
      definition: tokenResult.definition,
      original: text,
      originalLoading: false,
      definitionLoading: false
    });
  }).catch(() => {
    pushOverlayResult({ statusType: 'result-partial', definition: 'Failed to tokenize recognized text.', definitionLoading: false });
  });

  translationPromise.then((translation) => {
    pushOverlayResult({ statusType: 'result-partial', translation, translationLoading: false });
  }).catch(() => {
    pushOverlayResult({ statusType: 'result-partial', translation: 'Translation failed.', translationLoading: false });
  });

  const [tokenResult, translation] = await Promise.all([tokenPromise, translationPromise]);
  return {
    tokens: tokenResult.tokens,
    definition: tokenResult.definition,
    original: text,
    translation,
    debug: debugMode ? { ...(tokenResult.debug || {}) } : undefined
  };
}

async function tryCaptureFromClipboard() {
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) return null;
  debugLog('capture:clipboard-image-meta', getNativeImageMeta(image));

  const pngBuffer = image.toPNG();
  if (!pngBuffer || pngBuffer.length === 0) return null;
  debugLog('capture:clipboard-buffer', { bytes: pngBuffer.length });

  const tempFilePath = path.join(app.getPath('temp'), `screenshot-translate-clipboard-${Date.now()}.png`);
  await fs.promises.writeFile(tempFilePath, pngBuffer);
  try {
    await waitForImageFileReady(tempFilePath);
    const savedPath = await saveDebugCaptureCopy(tempFilePath, 'clipboard');
    if (savedPath) console.log(`[capture] clipboard image saved: ${savedPath}`);
    return await processCapturedImageFile(tempFilePath, 'clipboard');
  } finally {
    fs.promises.unlink(tempFilePath).catch(() => {});
  }
}

async function handleGlobalCaptureHotkey() {
  const clipboardResult = await tryCaptureFromClipboard();
  if (clipboardResult) return clipboardResult;
  pushOverlayResult({
    statusType: 'result-partial',
    original: 'No image found in clipboard.',
    definition: 'Take a screenshot to clipboard first, then press the hotkey again.',
    translation: '',
    originalLoading: false,
    definitionLoading: false,
    translationLoading: false
  });
  return null;
}

ipcMain.handle('is-debug-mode', async (event) => {
  requireTrustedSender(event, 'is-debug-mode');
  return debugMode;
});
ipcMain.handle('get-settings', async (event) => {
  requireTrustedSender(event, 'get-settings');
  return { ...settings };
});
ipcMain.handle('save-settings', async (event, payload) => {
  requireTrustedSender(event, 'save-settings');
  try {
    await saveSettings(payload);
    applyLaunchAtLoginSetting();
    registerGlobalHotkey();
    startReviewScheduler();
    return { ok: true, settings: { ...settings } };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('save-review-word', async (event, payload) => {
  requireTrustedSender(event, 'save-review-word');
  const candidate = normalizeReviewWordEntry({
    word: payload?.word,
    reading: payload?.reading,
    definition: payload?.definition,
    sentenceOriginal: payload?.sentenceOriginal,
    sentenceTranslation: payload?.sentenceTranslation,
    savedAt: new Date().toISOString()
  });
  if (!candidate) return { ok: false, error: 'Word and sentence are required.' };
  const existing = reviewWords.find((entry) => entry.word === candidate.word && entry.sentenceOriginal === candidate.sentenceOriginal);
  if (existing) return { ok: true, item: existing, duplicate: true };
  reviewWords.unshift(candidate);
  if (reviewWords.length > 5000) reviewWords = reviewWords.slice(0, 5000);
  await saveReviewWords();
  startReviewScheduler();
  return { ok: true, item: candidate, duplicate: false };
});
ipcMain.handle('list-review-words', async (event) => {
  requireTrustedSender(event, 'list-review-words');
  return { ok: true, items: [...reviewWords] };
});
ipcMain.handle('delete-review-word', async (event, payload) => {
  requireTrustedSender(event, 'delete-review-word');
  const id = (payload?.id || '').toString().trim();
  if (!id) return { ok: false, error: 'Review id is required.' };
  const prevCount = reviewWords.length;
  reviewWords = reviewWords.filter((entry) => entry.id !== id);
  if (reviewWords.length === prevCount) return { ok: false, error: 'Review card not found.' };
  await saveReviewWords();
  startReviewScheduler();
  return { ok: true };
});
ipcMain.handle('lookup-kanji', async (event, payload) => {
  requireTrustedSender(event, 'lookup-kanji');
  const ch = (payload?.kanji || '').toString().trim().slice(0, 2);
  if (!ch || !isKanjiChar(ch)) return { ok: false, error: 'Please select a single kanji.' };
  const result = lookupKanjiInfo(ch);
  if (!result) return { ok: false, error: `No local kanji entry for ${ch}. Run npm run setup-dict.` };
  return { ok: true, kanji: result };
});
ipcMain.handle('tokenize-review-sentence', async (event, payload) => {
  requireTrustedSender(event, 'tokenize-review-sentence');
  const sentence = (payload?.sentence || '').toString();
  return { ok: true, tokens: buildSentenceTokensForReview(sentence) };
});

ipcMain.on('debug-log', (event, payload) => {
  if (!isTrustedSender(event)) return;
  if (debugMode) debugLog('renderer', payload);
});
ipcMain.on('show-overlay', (event, payload) => {
  if (!isTrustedSender(event)) return;
  pushOverlayResult(normalizeOverlayPayload(payload));
});
ipcMain.on('close-overlay', (event) => {
  if (!isTrustedSender(event)) return;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) return;
  if (reviewWindow && senderWindow === reviewWindow) reviewPopupVisible = false;
  senderWindow.close();
});
ipcMain.handle('answer-review-card', async (event, payload) => {
  requireTrustedSender(event, 'answer-review-card');
  const id = (payload?.id || '').toString().trim();
  const rating = (payload?.rating || '').toString().trim();
  if (!id) return { ok: false, error: 'Review card id is required.' };
  if (!['again', 'good', 'easy'].includes(rating)) return { ok: false, error: 'Invalid review rating.' };
  const card = reviewWords.find((entry) => entry.id === id);
  if (!card) return { ok: false, error: 'Review card not found.' };

  const now = new Date();
  let ease = Number.isFinite(Number(card.ease)) ? Number(card.ease) : 2.5;
  let repetitions = Number.isFinite(Number(card.repetitions)) ? Number(card.repetitions) : 0;
  let intervalDays = Number.isFinite(Number(card.intervalDays)) ? Number(card.intervalDays) : 0;

  if (rating === 'again') {
    repetitions = 0;
    intervalDays = 0.15;
    ease = Math.max(1.3, ease - 0.2);
  } else if (rating === 'good') {
    if (repetitions <= 0) intervalDays = 1;
    else if (repetitions === 1) intervalDays = 3;
    else intervalDays = Math.max(1, intervalDays * ease);
    repetitions += 1;
  } else if (rating === 'easy') {
    if (repetitions <= 0) intervalDays = 2;
    else if (repetitions === 1) intervalDays = 5;
    else intervalDays = Math.max(2, intervalDays * ease * 1.3);
    repetitions += 1;
    ease = Math.min(3, ease + 0.15);
  }

  const nextDue = new Date(now.getTime() + Math.round(intervalDays * 24 * 60 * 60 * 1000));
  card.ease = Number(ease.toFixed(2));
  card.repetitions = repetitions;
  card.intervalDays = Number(intervalDays.toFixed(2));
  card.lastReviewedAt = now.toISOString();
  card.lastRating = rating;
  card.dueAt = nextDue.toISOString();
  await saveReviewWords();
  startReviewScheduler();
  return { ok: true, item: card, reviewMeta: getReviewMeta() };
});
ipcMain.handle('snooze-review-card', async (event, payload) => {
  requireTrustedSender(event, 'snooze-review-card');
  const id = (payload?.id || '').toString().trim();
  const minutes = Number(payload?.minutes);
  if (!id) return { ok: false, error: 'Review card id is required.' };
  const snoozeMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(120, Math.round(minutes))) : 10;
  const card = reviewWords.find((entry) => entry.id === id);
  if (!card) return { ok: false, error: 'Review card not found.' };
  const now = Date.now();
  card.dueAt = new Date(now + snoozeMinutes * 60 * 1000).toISOString();
  await saveReviewWords();
  startReviewScheduler();
  return { ok: true, item: card, reviewMeta: getReviewMeta() };
});
ipcMain.on('copy-to-clipboard', (event, payload) => {
  if (!isTrustedSender(event)) return;
  const text = (payload?.text || '').toString();
  if (text) clipboard.writeText(text);
});
ipcMain.on('resize-overlay', (event, payload) => {
  if (!isTrustedSender(event)) return;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) return;
  const primary = screen.getPrimaryDisplay();
  const maxWidth = Math.floor(primary.workAreaSize.width * 0.8);
  const maxHeight = Math.floor(primary.workAreaSize.height * 0.8);
  const nextWidth = Math.max(380, Math.min(maxWidth, Math.round(payload?.width || 560)));
  const nextHeight = Math.max(140, Math.min(maxHeight, Math.round(payload?.height || 180)));
  senderWindow.setContentSize(nextWidth, nextHeight);
  if (overlayWindow && senderWindow === overlayWindow) {
    applyOverlayPosition(overlayWindow, nextWidth, nextHeight);
  } else if (reviewWindow && senderWindow === reviewWindow) {
    const pos = pickBottomRightReviewPosition(reviewWindow);
    reviewWindow.setPosition(pos.x, pos.y);
  }
});
app.whenReady().then(() => {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (navEvent) => navEvent.preventDefault());
    contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  if (process.platform === 'darwin') app.dock.hide();
  loadSettings();
  loadReviewWords();
  applyLaunchAtLoginSetting();
  createTray();
  loadLocalDict();
  loadLocalNameDict();
  loadKanjiDict();

  if (settings.translationEnabled) {
    ensureArgosModelInstalled(resolveRuntimeAssetPath('python_translate.py')).catch((err) => {
      debugLog('translation:warmup-failed', { message: err?.message || String(err) });
    });
  }

  kuromoji.builder({ dicPath: path.join(__dirname, 'node_modules', 'kuromoji', 'dict') }).build((err, built) => {
    if (err) console.error('kuromoji build failed', err);
    else tokenizer = built;
  });

  registerGlobalHotkey();
  startReviewScheduler();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopReviewPopups();
});

app.on('window-all-closed', () => {});