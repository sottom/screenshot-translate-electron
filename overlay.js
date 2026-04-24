function resizeToContent() {
  const MAX_OVERLAY_WIDTH = 760;
  const MAX_OVERLAY_HEIGHT = 860;
  const measuredWidth = Math.ceil(Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth
  ));
  const measuredHeight = Math.ceil(Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  ));
  const width = Math.min(MAX_OVERLAY_WIDTH, Math.max(380, measuredWidth));
  const height = Math.min(MAX_OVERLAY_HEIGHT, Math.max(140, measuredHeight));
  if (Math.abs(width - window.innerWidth) < 2 && Math.abs(height - window.innerHeight) < 2) return;
  window.electronAPI.resizeOverlay({ width, height });
}

const state = {
  original: '',
  tokens: [],
  definition: '',
  translation: '',
  reviewCard: null,
  hoveredSurface: '',
  selectedKanji: '',
  selectedKanjiAnchorRect: null,
  kanjiInfo: null,
  kanjiInfoError: '',
  kanjiLoading: false,
  originalLoading: false,
  definitionLoading: false,
  translationLoading: false,
  fontScale: 1,
  saveFeedbackTimer: null,
  reviewMeta: null
};

function isKanjiChar(ch) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch || '');
}

function hardWrapLine(line, maxChars = 24) {
  const value = (line || '').toString();
  if (!value || value.length <= maxChars) return value;
  const breakChars = '、，,）)]」』】〉》';
  const chunks = [];
  let cursor = 0;
  while (cursor < value.length) {
    const remaining = value.length - cursor;
    if (remaining <= maxChars) {
      chunks.push(value.slice(cursor));
      break;
    }
    const windowEnd = cursor + maxChars;
    const candidate = value.slice(cursor, windowEnd);
    let breakAt = -1;
    for (let i = candidate.length - 1; i >= Math.max(0, candidate.length - 8); i -= 1) {
      if (breakChars.includes(candidate[i])) {
        breakAt = i + 1;
        break;
      }
    }
    if (breakAt <= 0) breakAt = candidate.length;
    chunks.push(value.slice(cursor, cursor + breakAt));
    cursor += breakAt;
  }
  return chunks.join('\n');
}

function formatTextForOverlay(rawText) {
  const value = (rawText || '').toString().trim();
  if (!value) return '';
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\t+/g, ' ')
    .replace(/[ \u3000]{2,}/g, ' ');
  const hasJapanese = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/.test(normalized);
  const withSentenceBreaks = hasJapanese
    ? normalized.replace(/([。！？!?])\s*/g, '$1\n')
    : normalized.replace(/([.!?])\s+/g, '$1\n');
  const lines = withSentenceBreaks
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!hasJapanese) return lines.join('\n');
  const containsNativeBreaks = normalized.includes('\n') || /[。！？]/.test(normalized);
  if (containsNativeBreaks) return lines.join('\n');
  return lines.map((line) => hardWrapLine(line, 24)).join('\n');
}

function appendInteractiveText(targetEl, text) {
  const value = (text || '').toString();
  if (!value) return;
  let plainBuffer = '';
  for (const ch of value) {
    if (isKanjiChar(ch)) {
      if (plainBuffer) {
        targetEl.append(document.createTextNode(plainBuffer));
        plainBuffer = '';
      }
      const charEl = document.createElement('span');
      charEl.className = 'kanji-char';
      charEl.dataset.kanji = ch;
      charEl.textContent = ch;
      targetEl.appendChild(charEl);
    } else {
      plainBuffer += ch;
    }
  }
  if (plainBuffer) targetEl.append(document.createTextNode(plainBuffer));
}

function renderOriginal(originalEl) {
  originalEl.replaceChildren();
  if (!state.tokens || state.tokens.length === 0) {
    appendInteractiveText(originalEl, formatTextForOverlay(state.original || ''));
    return;
  }
  for (const token of state.tokens) {
    const surface = (token.surface || '').toString();
    const canSaveToken = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/u.test(surface);
    const tokenEl = document.createElement('span');
    tokenEl.className = canSaveToken ? 'token save-token' : 'token';
    tokenEl.dataset.surface = surface;
    if (canSaveToken) tokenEl.dataset.saveWord = surface;
    if (token.showRuby && token.reading) {
      tokenEl.appendChild(createRubyNode(surface, token.reading));
    } else {
      appendInteractiveText(tokenEl, surface);
    }
    originalEl.appendChild(tokenEl);
  }
}

function createRubyNode(surface, reading) {
  const rubyEl = document.createElement('ruby');
  appendInteractiveText(rubyEl, surface || '');
  const rtEl = document.createElement('rt');
  rtEl.textContent = reading || '';
  rubyEl.appendChild(rtEl);
  return rubyEl;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReadingMap(tokens) {
  const map = new Map();
  for (const token of (Array.isArray(tokens) ? tokens : [])) {
    if (!token || !token.showRuby || !token.surface || !token.reading) continue;
    if (!map.has(token.surface)) map.set(token.surface, token.reading);
  }
  return map;
}

function normalizeComparableText(value) {
  return (value || '').toString().trim().replace(/\s+/g, '');
}

function definitionTermFromLine(line) {
  const splitAt = line.indexOf(':');
  if (splitAt <= 0) return '';
  return line.slice(0, splitAt).trim();
}

function appendTextWithRuby(targetEl, text, readingMap) {
  const value = (text || '').toString();
  if (!value) return;
  if (!readingMap || readingMap.size === 0) {
    appendInteractiveText(targetEl, value);
    return;
  }
  const keys = Array.from(readingMap.keys()).sort((a, b) => b.length - a.length);
  if (keys.length === 0) {
    appendInteractiveText(targetEl, value);
    return;
  }
  const matcher = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  let lastIndex = 0;
  let match;
  while ((match = matcher.exec(value)) !== null) {
    if (match.index > lastIndex) {
      appendInteractiveText(targetEl, value.slice(lastIndex, match.index));
    }
    const surface = match[0];
    const reading = readingMap.get(surface);
    if (reading) targetEl.appendChild(createRubyNode(surface, reading));
    else appendInteractiveText(targetEl, surface);
    lastIndex = matcher.lastIndex;
  }
  if (lastIndex < value.length) {
    appendInteractiveText(targetEl, value.slice(lastIndex));
  }
}

function renderDefinitions(defEl, definitionText, tokens) {
  defEl.replaceChildren();
  const readingMap = buildReadingMap(tokens);
  let lines = (definitionText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (state.hoveredSurface) {
    const hovered = normalizeComparableText(state.hoveredSurface);
    lines = [...lines].sort((a, b) => {
      const aMatch = normalizeComparableText(definitionTermFromLine(a)) === hovered ? 1 : 0;
      const bMatch = normalizeComparableText(definitionTermFromLine(b)) === hovered ? 1 : 0;
      return bMatch - aMatch;
    });
  }

  if (lines.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'def-empty';
    emptyEl.textContent = 'No dictionary matches found.';
    defEl.appendChild(emptyEl);
    return;
  }

  for (const line of lines) {
    const entryEl = document.createElement('div');
    entryEl.className = 'def-entry';
    const splitAt = line.indexOf(':');
    if (splitAt > 0) {
      const termEl = document.createElement('span');
      termEl.className = 'def-term';
      appendTextWithRuby(termEl, line.slice(0, splitAt).trim(), readingMap);
      termEl.append(document.createTextNode(':'));
      entryEl.appendChild(termEl);

      const rawMeaning = line.slice(splitAt + 1).trim();
      const senses = rawMeaning.split(';').map((sense) => sense.trim()).filter(Boolean);
      if (senses.length <= 1) {
        const meaningEl = document.createElement('span');
        meaningEl.className = 'def-meaning';
        appendTextWithRuby(meaningEl, rawMeaning, readingMap);
        entryEl.appendChild(meaningEl);
      } else {
        const sensesEl = document.createElement('ul');
        sensesEl.className = 'def-senses';
        for (const sense of senses) {
          const itemEl = document.createElement('li');
          itemEl.className = 'def-sense';
          appendTextWithRuby(itemEl, sense, readingMap);
          sensesEl.appendChild(itemEl);
        }
        entryEl.appendChild(sensesEl);
      }
    } else {
      const meaningEl = document.createElement('span');
      meaningEl.className = 'def-meaning';
      appendTextWithRuby(meaningEl, line, readingMap);
      entryEl.appendChild(meaningEl);
    }
    defEl.appendChild(entryEl);
  }
}

function renderTranslation(containerEl, textEl, translationText) {
  const text = (translationText || '').trim();
  if (!text) {
    containerEl.style.display = 'none';
    textEl.textContent = '';
    return;
  }
  textEl.textContent = formatTextForOverlay(text);
  containerEl.style.display = 'block';
}

function appendHighlightedSentence(targetEl, sentence, word, reading = '', sentenceTokens = []) {
  targetEl.replaceChildren();
  const text = (sentence || '').toString();
  const focusWord = (word || '').toString();
  const focusReading = (reading || '').toString().trim();
  const tokenReadings = new Map();
  for (const token of (Array.isArray(sentenceTokens) ? sentenceTokens : [])) {
    const surface = (token?.surface || '').toString();
    const tokenReading = (token?.reading || '').toString().trim();
    if (!surface || !tokenReading || tokenReadings.has(surface)) continue;
    tokenReadings.set(surface, tokenReading);
  }
  if (focusWord && focusReading && !tokenReadings.has(focusWord)) {
    tokenReadings.set(focusWord, focusReading);
  }
  const keys = Array.from(tokenReadings.keys()).sort((a, b) => b.length - a.length);
  if (keys.length === 0) {
    if (!focusWord) {
      targetEl.textContent = text;
      return;
    }
    const fallbackIndex = text.indexOf(focusWord);
    if (fallbackIndex < 0) {
      targetEl.textContent = text;
      return;
    }
    const before = text.slice(0, fallbackIndex);
    const after = text.slice(fallbackIndex + focusWord.length);
    if (before) targetEl.append(document.createTextNode(before));
    const highlightEl = document.createElement('span');
    highlightEl.className = 'review-highlight review-focus-word';
    highlightEl.textContent = focusWord;
    if (focusReading) highlightEl.dataset.reading = focusReading;
    targetEl.appendChild(highlightEl);
    if (after) targetEl.append(document.createTextNode(after));
    return;
  }
  const matcher = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  let lastIndex = 0;
  let match;
  while ((match = matcher.exec(text)) !== null) {
    if (match.index > lastIndex) {
      targetEl.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const surface = match[0];
    const tokenEl = document.createElement('span');
    const isFocus = surface === focusWord;
    tokenEl.className = isFocus ? 'review-highlight review-focus-word' : 'review-hover-word';
    appendInteractiveText(tokenEl, surface);
    const tokenReading = tokenReadings.get(surface);
    if (tokenReading) tokenEl.dataset.reading = tokenReading;
    targetEl.appendChild(tokenEl);
    lastIndex = matcher.lastIndex;
  }
  if (lastIndex < text.length) targetEl.append(document.createTextNode(text.slice(lastIndex)));
}

function renderReviewCard(reviewCardEl, sentenceEl, translationEl, card) {
  if (!card || !card.sentenceOriginal || !card.word) {
    reviewCardEl.style.display = 'none';
    sentenceEl.textContent = '';
    translationEl.textContent = '';
    translationEl.style.display = 'none';
    return;
  }
  appendHighlightedSentence(
    sentenceEl,
    card.sentenceOriginal,
    card.word,
    card.reading || '',
    Array.isArray(card.sentenceTokens) ? card.sentenceTokens : []
  );
  const translation = (card.sentenceTranslation || '').trim();
  translationEl.textContent = translation;
  translationEl.style.display = translation ? '' : 'none';
  reviewCardEl.style.display = 'block';
}

function formatNextReviewText(iso) {
  const ms = Date.parse((iso || '').toString());
  if (!Number.isFinite(ms)) return 'No more reviews scheduled today';
  const diff = ms - Date.now();
  if (diff <= 0) return 'Next review soon';
  const minutes = Math.max(1, Math.round(diff / 60000));
  return `Next in ~${minutes}m`;
}

function renderReviewMeta(metaEl, meta) {
  const left = Number.isFinite(Number(meta?.leftToday)) ? Math.max(0, Math.round(Number(meta.leftToday))) : 0;
  const total = Number.isFinite(Number(meta?.totalToday)) ? Math.max(0, Math.round(Number(meta.totalToday))) : 0;
  const nextText = formatNextReviewText(meta?.nextReviewAt || '');
  metaEl.textContent = `Left today: ${left}${total ? `/${total}` : ''} • ${nextText}`;
}

async function ensureReviewCardTokens(card) {
  if (!card || !card.sentenceOriginal) return card;
  if (Array.isArray(card.sentenceTokens) && card.sentenceTokens.length > 0) return card;
  try {
    const result = await window.electronAPI.tokenizeReviewSentence({ sentence: card.sentenceOriginal });
    const tokens = Array.isArray(result?.tokens) ? result.tokens : [];
    return { ...card, sentenceTokens: tokens };
  } catch {
    return card;
  }
}

async function answerCurrentReview(rating) {
  const id = state.reviewCard?.id;
  if (!id) return;
  try {
    await window.electronAPI.answerReviewCard({ id, rating });
  } catch {
    // Keep UX lightweight; silently ignore transient errors.
  }
  window.electronAPI.closeOverlay();
}

async function snoozeCurrentReview(minutes = 10) {
  const id = state.reviewCard?.id;
  if (!id) return;
  try {
    await window.electronAPI.snoozeReviewCard({ id, minutes });
  } catch {
    // Keep UX lightweight; silently ignore transient errors.
  }
  window.electronAPI.closeOverlay();
}

function showSaveFeedback(feedbackEl, message) {
  if (state.saveFeedbackTimer) {
    clearTimeout(state.saveFeedbackTimer);
    state.saveFeedbackTimer = null;
  }
  feedbackEl.textContent = message;
  feedbackEl.style.display = 'block';
  state.saveFeedbackTimer = setTimeout(() => {
    feedbackEl.style.display = 'none';
    feedbackEl.textContent = '';
    state.saveFeedbackTimer = null;
  }, 1800);
}

function getReadingForSurface(surface) {
  const needle = normalizeComparableText(surface);
  if (!needle) return '';
  for (const token of (Array.isArray(state.tokens) ? state.tokens : [])) {
    const tokenSurface = normalizeComparableText(token?.surface || '');
    if (tokenSurface === needle && token?.reading) return token.reading;
  }
  return '';
}

function getDefinitionForSurface(surface) {
  const needle = normalizeComparableText(surface);
  if (!needle) return '';
  const lines = (state.definition || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const splitAt = line.indexOf(':');
    if (splitAt <= 0) continue;
    const term = normalizeComparableText(line.slice(0, splitAt));
    if (term !== needle) continue;
    return line.slice(splitAt + 1).trim();
  }
  return '';
}

async function refreshSavedCount(savedCountEl, feedbackEl) {
  try {
    const result = await window.electronAPI.getReviewWords();
    const count = Array.isArray(result?.items) ? result.items.length : 0;
    savedCountEl.textContent = `Saved words: ${count}`;
  } catch (err) {
    savedCountEl.textContent = 'Saved words: ?';
    if (feedbackEl) showSaveFeedback(feedbackEl, `Failed to read saved words: ${err?.message || String(err)}`);
  }
}

function renderStatus(statusEl, titleEl, subtextEl, barEl, labelEl, data) {
  const percent = Math.max(0, Math.min(100, Math.round(data.statusPercent || 0)));
  statusEl.classList.remove('error');
  statusEl.style.display = 'block';
  titleEl.textContent = data.statusMessage || 'Preparing translation model...';
  subtextEl.textContent = data.statusSubtext || 'One-time setup';
  barEl.style.width = `${percent}%`;
  labelEl.textContent = `${percent}%`;
}

function renderStatusError(statusEl, titleEl, subtextEl, barEl, labelEl, data) {
  statusEl.classList.add('error');
  statusEl.style.display = 'block';
  titleEl.textContent = data.statusMessage || 'Translation setup failed';
  subtextEl.textContent = data.statusSubtext || '';
  barEl.style.width = '100%';
  labelEl.textContent = 'Action required';
}

function setSectionLoading(loadingEl, contentEl, loading) {
  loadingEl.style.display = loading ? 'flex' : 'none';
  contentEl.classList.toggle('dimmed', !!loading);
}

function applyFontScale() {
  document.body.style.fontSize = `${state.fontScale * 16}px`;
}

function renderKanjiPanel(panelEl) {
  panelEl.replaceChildren();
  if (!state.selectedKanji) {
    panelEl.style.display = 'none';
    return;
  }
  panelEl.style.display = 'block';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'kanji-panel-close';
  closeBtn.id = 'kanji-panel-close';
  closeBtn.type = 'button';
  closeBtn.textContent = 'X';
  closeBtn.addEventListener('click', () => closeKanjiPanel(panelEl));
  panelEl.appendChild(closeBtn);

  if (state.kanjiLoading) {
    const loadingEl = document.createElement('div');
    loadingEl.textContent = `Looking up kanji ${state.selectedKanji}...`;
    panelEl.appendChild(loadingEl);
    return;
  }
  if (state.kanjiInfoError) {
    const errEl = document.createElement('div');
    errEl.textContent = state.kanjiInfoError;
    panelEl.appendChild(errEl);
    return;
  }
  if (!state.kanjiInfo) {
    const emptyEl = document.createElement('div');
    emptyEl.textContent = 'No kanji information available.';
    panelEl.appendChild(emptyEl);
    return;
  }

  const info = state.kanjiInfo;
  const headerEl = document.createElement('div');
  headerEl.className = 'kanji-header';
  const literalEl = document.createElement('span');
  literalEl.className = 'kanji-literal';
  literalEl.textContent = info.literal || state.selectedKanji;
  const metaEl = document.createElement('span');
  metaEl.className = 'kanji-meta';
  const metaParts = [];
  if (Number.isFinite(info.strokes)) metaParts.push(`Strokes ${info.strokes}`);
  if (Number.isFinite(info.grade)) metaParts.push(`Grade ${info.grade}`);
  if (Number.isFinite(info.jlpt)) metaParts.push(`JLPT N${info.jlpt}`);
  if (Number.isFinite(info.freq)) metaParts.push(`Freq ${info.freq}`);
  metaEl.textContent = metaParts.join(' | ');
  headerEl.appendChild(literalEl);
  headerEl.appendChild(metaEl);
  panelEl.appendChild(headerEl);

  const rows = [
    ['On', info.on || []],
    ['Kun', info.kun || []],
    ['Nanori', info.nanori || []],
    ['Meanings', info.meanings || []]
  ];
  for (const [label, values] of rows) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const rowEl = document.createElement('div');
    rowEl.className = 'kanji-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'kanji-row-label';
    labelEl.textContent = `${label}:`;
    const valueEl = document.createElement('span');
    valueEl.textContent = values.join(', ');
    rowEl.appendChild(labelEl);
    rowEl.appendChild(valueEl);
    panelEl.appendChild(rowEl);
  }

  positionKanjiPanel(panelEl);
}

function positionKanjiPanel(panelEl) {
  if (!state.selectedKanjiAnchorRect) return;
  const rect = state.selectedKanjiAnchorRect;
  const margin = 10;
  const maxLeft = Math.max(8, window.innerWidth - panelEl.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - panelEl.offsetHeight - 8);
  let left = rect.left;
  let top = rect.bottom + margin;
  if (left > maxLeft) left = maxLeft;
  if (top > maxTop) top = Math.max(8, rect.top - panelEl.offsetHeight - margin);
  panelEl.style.left = `${Math.max(8, left)}px`;
  panelEl.style.top = `${Math.max(8, top)}px`;
}

function closeKanjiPanel(panelEl) {
  state.selectedKanji = '';
  state.selectedKanjiAnchorRect = null;
  state.kanjiInfo = null;
  state.kanjiInfoError = '';
  state.kanjiLoading = false;
  renderKanjiPanel(panelEl);
}

function updateDefinitionPriority(defEl, surface) {
  const next = surface || '';
  if (state.hoveredSurface === next) return;
  state.hoveredSurface = next;
  renderDefinitions(defEl, state.definition || '', state.tokens || []);
}

async function handleKanjiClick(ch, panelEl, targetEl) {
  state.selectedKanji = ch;
  state.selectedKanjiAnchorRect = targetEl?.getBoundingClientRect?.() || null;
  state.kanjiLoading = true;
  state.kanjiInfo = null;
  state.kanjiInfoError = '';
  renderKanjiPanel(panelEl);
  try {
    const result = await window.electronAPI.lookupKanji({ kanji: ch });
    if (result?.ok) {
      state.kanjiInfo = result.kanji || null;
      state.kanjiInfoError = '';
    } else {
      state.kanjiInfo = null;
      state.kanjiInfoError = result?.error || `No kanji info found for ${ch}.`;
    }
  } catch (err) {
    state.kanjiInfo = null;
    state.kanjiInfoError = `Lookup failed: ${err?.message || String(err)}`;
  } finally {
    state.kanjiLoading = false;
    renderKanjiPanel(panelEl);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const copyOriginal = document.getElementById('copy-original');
  const copyTranslation = document.getElementById('copy-translation');
  const closeOverlayBtn = document.getElementById('close-overlay');
  const reviewAgainBtn = document.getElementById('review-again');
  const reviewGoodBtn = document.getElementById('review-good');
  const reviewEasyBtn = document.getElementById('review-easy');
  const reviewSnoozeBtn = document.getElementById('review-snooze');
  const reviewSentenceEl = document.getElementById('review-sentence');
  const savedCountEl = document.getElementById('saved-count');
  const originalEl = document.getElementById('original');
  const defEl = document.getElementById('definition');
  const saveFeedbackEl = document.getElementById('save-feedback');
  const kanjiPanelEl = document.getElementById('kanji-panel');
  copyOriginal.addEventListener('click', () => {
    window.electronAPI.copyToClipboard({ text: state.original || '' });
  });
  copyTranslation.addEventListener('click', () => {
    window.electronAPI.copyToClipboard({ text: state.translation || '' });
  });
  closeOverlayBtn.addEventListener('click', () => {
    window.electronAPI.closeOverlay();
  });
  reviewAgainBtn.addEventListener('click', () => {
    answerCurrentReview('again');
  });
  reviewGoodBtn.addEventListener('click', () => {
    answerCurrentReview('good');
  });
  reviewEasyBtn.addEventListener('click', () => {
    answerCurrentReview('easy');
  });
  reviewSnoozeBtn.addEventListener('click', () => {
    snoozeCurrentReview(10);
  });
  const clickHandler = (event) => {
    const target = event.target?.closest?.('[data-kanji]');
    if (!target) return;
    const ch = target.dataset.kanji || '';
    if (!ch) return;
    handleKanjiClick(ch, kanjiPanelEl, target);
  };
  originalEl.addEventListener('click', async (event) => {
    const saveTarget = event.target?.closest?.('[data-save-word]');
    if (saveTarget) {
      const word = (saveTarget.dataset.saveWord || '').trim();
      if (!word) return;
      try {
        const result = await window.electronAPI.saveReviewWord({
          word,
          reading: getReadingForSurface(word),
          definition: getDefinitionForSurface(word),
          sentenceOriginal: state.original || '',
          sentenceTranslation: state.translation || ''
        });
        const reading = getReadingForSurface(word);
        const definition = getDefinitionForSurface(word);
        const details = [
          reading ? `Hiragana: ${reading}` : '',
          definition ? `Definition: ${definition}` : 'Definition: (not found)'
        ].filter(Boolean).join(' | ');
        if (result?.ok && result.duplicate) showSaveFeedback(saveFeedbackEl, `Already saved: ${word} | ${details}`);
        else if (result?.ok) showSaveFeedback(saveFeedbackEl, `Saved for review: ${word} | ${details}`);
        else showSaveFeedback(saveFeedbackEl, result?.error || 'Failed to save review word.');
        await refreshSavedCount(savedCountEl, saveFeedbackEl);
      } catch (err) {
        showSaveFeedback(saveFeedbackEl, `Failed to save review word: ${err?.message || String(err)}`);
      }
      return;
    }
    clickHandler(event);
  });
  defEl.addEventListener('click', clickHandler);
  reviewSentenceEl.addEventListener('click', clickHandler);
  originalEl.addEventListener('mouseover', (event) => {
    const tokenEl = event.target?.closest?.('.token');
    if (!tokenEl) return;
    const surface = tokenEl.dataset.surface || '';
    if (!surface) return;
    updateDefinitionPriority(defEl, surface);
  });
  originalEl.addEventListener('mouseout', (event) => {
    const tokenEl = event.target?.closest?.('.token');
    if (!tokenEl) return;
    if (event.relatedTarget && tokenEl.contains(event.relatedTarget)) return;
    updateDefinitionPriority(defEl, '');
  });

  document.addEventListener('click', (event) => {
    if (!state.selectedKanji) return;
    const clickedKanji = event.target?.closest?.('[data-kanji]');
    if (clickedKanji) return;
    const clickedPanel = event.target?.closest?.('#kanji-panel');
    if (clickedPanel) return;
    closeKanjiPanel(kanjiPanelEl);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectedKanji) {
      closeKanjiPanel(kanjiPanelEl);
      return;
    }
    if (state.reviewCard && !state.selectedKanji) {
      if (event.key === '1') { answerCurrentReview('again'); return; }
      if (event.key === '2') { answerCurrentReview('good'); return; }
      if (event.key === '3') { answerCurrentReview('easy'); return; }
      if (event.key.toLowerCase() === 's') { snoozeCurrentReview(10); return; }
    }
    if (event.key === 'Escape') window.electronAPI.closeOverlay();
  });
  window.addEventListener('resize', () => {
    if (!state.selectedKanji) return;
    positionKanjiPanel(kanjiPanelEl);
  });
  refreshSavedCount(savedCountEl, saveFeedbackEl).catch(() => {});
});

window.electronAPI.onShowResult((data) => {
  const statusEl = document.getElementById('status');
  const statusTitleEl = document.getElementById('status-title');
  const statusSubtextEl = document.getElementById('status-subtext');
  const statusProgressBarEl = document.getElementById('status-progress-bar');
  const statusProgressLabelEl = document.getElementById('status-progress-label');
  const reviewCardEl = document.getElementById('review-card');
  const reviewMetaEl = document.getElementById('review-meta');
  const reviewSentenceEl = document.getElementById('review-sentence');
  const reviewTranslationEl = document.getElementById('review-translation');
  const originalEl = document.getElementById('original');
  const originalLoadingEl = document.getElementById('loading-original');
  const translationEl = document.getElementById('translation');
  const translationLoadingEl = document.getElementById('loading-translation');
  const translationTextEl = document.getElementById('translation-text');
  const defEl = document.getElementById('definition');
  const defLoadingEl = document.getElementById('loading-definition');
  const kanjiPanelEl = document.getElementById('kanji-panel');

  if (Object.prototype.hasOwnProperty.call(data, 'fontScale')) {
    state.fontScale = Number(data.fontScale) || 1;
    applyFontScale();
  }

  if (data.statusType === 'translation-progress') {
    reviewCardEl.style.display = 'none';
    originalEl.style.display = 'none';
    translationEl.style.display = 'none';
    defEl.style.display = 'none';
    renderStatus(statusEl, statusTitleEl, statusSubtextEl, statusProgressBarEl, statusProgressLabelEl, data);
    requestAnimationFrame(resizeToContent);
    return;
  }
  if (data.statusType === 'translation-error') {
    reviewCardEl.style.display = 'none';
    originalEl.style.display = 'none';
    translationEl.style.display = 'none';
    defEl.style.display = 'none';
    renderStatusError(statusEl, statusTitleEl, statusSubtextEl, statusProgressBarEl, statusProgressLabelEl, data);
    requestAnimationFrame(resizeToContent);
    return;
  }

  if (data.statusType === 'review-card') {
    state.reviewCard = data.reviewCard || null;
    state.reviewMeta = data.reviewMeta || null;
    statusEl.style.display = 'none';
    statusEl.classList.remove('error');
    originalEl.style.display = 'none';
    translationEl.style.display = 'none';
    defEl.style.display = 'none';
    renderReviewCard(reviewCardEl, reviewSentenceEl, reviewTranslationEl, state.reviewCard);
    renderReviewMeta(reviewMetaEl, state.reviewMeta);
    const savedCountEl = document.getElementById('saved-count');
    if (savedCountEl && state.reviewMeta) {
      const left = Number.isFinite(Number(state.reviewMeta.leftToday)) ? Math.max(0, Math.round(Number(state.reviewMeta.leftToday))) : 0;
      savedCountEl.textContent = `Today left: ${left}`;
    }
    ensureReviewCardTokens(state.reviewCard).then((nextCard) => {
      if (!nextCard || !state.reviewCard || nextCard.id !== state.reviewCard.id) return;
      state.reviewCard = nextCard;
      renderReviewCard(reviewCardEl, reviewSentenceEl, reviewTranslationEl, state.reviewCard);
      requestAnimationFrame(resizeToContent);
    }).catch(() => {});
    requestAnimationFrame(resizeToContent);
    return;
  }

  reviewCardEl.style.display = 'none';
  statusEl.style.display = 'none';
  statusEl.classList.remove('error');
  originalEl.style.display = '';
  defEl.style.display = '';
  state.reviewCard = null;
  state.reviewMeta = null;
  const savedCountEl = document.getElementById('saved-count');
  const saveFeedbackEl = document.getElementById('save-feedback');
  if (savedCountEl && saveFeedbackEl) refreshSavedCount(savedCountEl, saveFeedbackEl).catch(() => {});

  if (data.statusType === 'result-loading') {
    state.originalLoading = true;
    state.definitionLoading = true;
    state.translationLoading = !!data.translationLoading;
  } else if (data.statusType === 'result-partial') {
    if (Object.prototype.hasOwnProperty.call(data, 'original')) state.original = data.original || '';
    if (Object.prototype.hasOwnProperty.call(data, 'tokens')) state.tokens = Array.isArray(data.tokens) ? data.tokens : [];
    if (Object.prototype.hasOwnProperty.call(data, 'definition')) state.definition = data.definition || '';
    if (Object.prototype.hasOwnProperty.call(data, 'translation')) state.translation = data.translation || '';
    if (Object.prototype.hasOwnProperty.call(data, 'originalLoading')) state.originalLoading = !!data.originalLoading;
    if (Object.prototype.hasOwnProperty.call(data, 'definitionLoading')) state.definitionLoading = !!data.definitionLoading;
    if (Object.prototype.hasOwnProperty.call(data, 'translationLoading')) state.translationLoading = !!data.translationLoading;
  }

  renderOriginal(originalEl);
  renderTranslation(translationEl, translationTextEl, state.translation || '');
  renderDefinitions(defEl, state.definition || '', state.tokens || []);
  setSectionLoading(originalLoadingEl, originalEl, state.originalLoading);
  setSectionLoading(translationLoadingEl, translationEl, state.translationLoading);
  setSectionLoading(defLoadingEl, defEl, state.definitionLoading);
  renderKanjiPanel(kanjiPanelEl);
  requestAnimationFrame(resizeToContent);
});
