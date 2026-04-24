const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  recognizeImage: (payload) => ipcRenderer.invoke('recognize-image', payload),
  lookupKanji: (payload) => ipcRenderer.invoke('lookup-kanji', payload),
  tokenizeReviewSentence: (payload) => ipcRenderer.invoke('tokenize-review-sentence', payload),
  saveReviewWord: (payload) => ipcRenderer.invoke('save-review-word', payload),
  getReviewWords: () => ipcRenderer.invoke('list-review-words'),
  deleteReviewWord: (id) => ipcRenderer.invoke('delete-review-word', { id }),
  isDebugMode: () => ipcRenderer.invoke('is-debug-mode'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('save-settings', payload),
  answerReviewCard: (payload) => ipcRenderer.invoke('answer-review-card', payload),
  snoozeReviewCard: (payload) => ipcRenderer.invoke('snooze-review-card', payload),
  debugLog: (payload) => ipcRenderer.send('debug-log', payload),
  showOverlay: (payload) => ipcRenderer.send('show-overlay', payload),
  resizeOverlay: (payload) => ipcRenderer.send('resize-overlay', payload),
  closeOverlay: () => ipcRenderer.send('close-overlay'),
  closeSelector: () => ipcRenderer.send('close-selector'),
  copyToClipboard: (payload) => ipcRenderer.send('copy-to-clipboard', payload),
  onShowResult: (cb) => ipcRenderer.on('show-result', (e, data) => cb(data))
});