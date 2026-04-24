function byId(id) {
  return document.getElementById(id);
}

function showMessage(text, isError) {
  const el = byId('message');
  el.textContent = text;
  el.style.color = isError ? '#ff9e9e' : '#9ae6b4';
}

async function loadSettings() {
  const settings = await window.electronAPI.getSettings();
  byId('hotkey').value = settings.hotkey;
  byId('launchAtLogin').checked = !!settings.launchAtLogin;
  byId('translationEnabled').checked = !!settings.translationEnabled;
  byId('overlayPinned').checked = !!settings.overlayPinned;
  byId('overlayPosition').value = settings.overlayPosition || 'top-right';
  byId('fontScale').value = String(settings.fontScale || 1);
  byId('reviewEnabled').checked = !!settings.reviewEnabled;
}

async function saveSettings() {
  const payload = {
    hotkey: byId('hotkey').value.trim(),
    launchAtLogin: byId('launchAtLogin').checked,
    translationEnabled: byId('translationEnabled').checked,
    overlayPinned: byId('overlayPinned').checked,
    overlayPosition: byId('overlayPosition').value,
    fontScale: Number(byId('fontScale').value || 1),
    reviewEnabled: byId('reviewEnabled').checked
  };
  const result = await window.electronAPI.saveSettings(payload);
  if (result.ok) {
    showMessage('Saved. Hotkey and launch settings were applied immediately.', false);
  } else {
    showMessage(result.error || 'Failed to save settings.', true);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSettings();
  } catch (err) {
    showMessage(`Failed to load settings: ${err?.message || err}`, true);
  }
  byId('saveBtn').addEventListener('click', () => {
    saveSettings().catch((err) => {
      showMessage(`Failed to save settings: ${err?.message || err}`, true);
    });
  });
});
