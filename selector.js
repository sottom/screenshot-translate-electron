const rectEl = document.getElementById('rect');
const VISUAL_CURSOR_OFFSET_X = -1;
const VISUAL_CURSOR_OFFSET_Y = -1;
let startX = 0, startY = 0, curX = 0, curY = 0, selecting = false;
let debugMode = false;

window.electronAPI.isDebugMode().then((enabled) => {
  debugMode = !!enabled;
});

function debugLog(step, payload = {}) {
  if (!debugMode) return;
  const msg = { step, ...payload };
  console.log('[selector debug]', msg);
  window.electronAPI.debugLog(msg);
}

function setRect(x, y, w, h) {
  // Keep OCR bounds exact, but nudge the visual rectangle to feel anchored to cursor tip.
  rectEl.style.left = (x + VISUAL_CURSOR_OFFSET_X) + 'px';
  rectEl.style.top = (y + VISUAL_CURSOR_OFFSET_Y) + 'px';
  rectEl.style.width = Math.max(0, w) + 'px';
  rectEl.style.height = Math.max(0, h) + 'px';
  rectEl.style.display = (w > 0 && h > 0) ? 'block' : 'none';
}

window.addEventListener('mousedown', (e) => {
  selecting = true;
  startX = e.clientX;
  startY = e.clientY;
});

window.addEventListener('mousemove', (e) => {
  if (!selecting) return;
  curX = e.clientX; curY = e.clientY;
  const x = Math.min(startX, curX);
  const y = Math.min(startY, curY);
  const w = Math.abs(curX - startX);
  const h = Math.abs(curY - startY);
  setRect(x, y, w, h);
});

window.addEventListener('mouseup', async (e) => {
  if (!selecting) return;
  selecting = false;

  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);

  // Convert to absolute desktop coordinates from the selector window origin.
  const absX = Math.round(window.screenX + x);
  const absY = Math.round(window.screenY + y);
  
  if (w < 5 || h < 5) { 
    window.electronAPI.closeSelector(); 
    return; 
  }

  try {
    window.electronAPI.showOverlay({
      statusType: 'result-loading',
      originalLoading: true,
      definitionLoading: true,
      translationLoading: true
    });

    debugLog('selection:absolute-bounds', {
      x,
      y,
      absX,
      absY,
      w,
      h,
      screenX: window.screenX,
      screenY: window.screenY,
      dpr: window.devicePixelRatio || 1
    });
    
    const result = await window.electronAPI.recognizeImage({
      rect: { x: absX, y: absY, w, h },
      absolute: true
    });
    
    debugLog('ocr:result', {
      original: result.original,
      html: result.html,
      definition: result.definition,
      translation: result.translation,
    });

    window.electronAPI.showOverlay({
      statusType: 'result-partial',
      tokens: result.tokens || [],
      definition: result.definition,
      original: result.original,
      translation: result.translation,
      originalLoading: false,
      definitionLoading: false,
      translationLoading: false
    });

  } catch (err) {
    console.error('OCR failed', err);
    window.electronAPI.showOverlay({
      statusType: 'result-partial',
      original: `OCR failed: ${err?.message || 'Unknown error'}`,
      definition: 'Could not extract text from this capture.',
      translation: '',
      originalLoading: false,
      definitionLoading: false,
      translationLoading: false
    });
  }

  window.electronAPI.closeSelector();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.electronAPI.closeSelector();
});