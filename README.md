# Screenshot Translate Electron

Minimal macOS menu bar Electron app prototype.

Features:
- Global hotkey: `Cmd+Shift+J` — processes the current clipboard image (take a screenshot to clipboard first).
- Uses `kuromoji` locally for tokenization/readings and a local dictionary for offline definitions; shows a small top-right overlay for ~3s.
- Click individual kanji in the overlay to see per-kanji readings/meanings (when local kanji dictionary is installed).
- Optional offline sentence translation (Japanese -> English) via Argos Translate.

Run:

```bash
cd /Users/Mitchell.Sotto/Documents/code/japanese/screenshot-translate-electron
npm install
npm start
```

Build distributable app (macOS):

```bash
cd /Users/Mitchell.Sotto/Documents/code/japanese/screenshot-translate-electron
npm run build
```

Build unpacked app directory only (faster local check):

```bash
cd /Users/Mitchell.Sotto/Documents/code/japanese/screenshot-translate-electron
npm run build:dir
```

Build outputs are written to `dist/`.

Notes:
- OCR uses the native macOS Vision framework via the bundled `mac-ocr` binary.
- Capture uses the current clipboard image only (recommended flow: macOS screenshot-to-clipboard, then press hotkey).
- The app is configured to launch automatically at login on macOS so the screenshot hotkey is ready after startup.

Offline dictionary:

- A local dictionary is loaded from `data/dict.json`.
- A local name dictionary is loaded from `data/name_dict.json` (from JMnedict).
- Kanji details are loaded from `data/kanji_dict.json`.
- To generate a full offline dictionary from JMdict:
  - `npm run setup-dict`
  - This downloads `JMdict_e.xml` + `JMnedict.xml` + `kanjidic2.xml`, and also downloads a local Argos `ja->en` model.
  - Generated files include `data/dict.json`, `data/name_dict.json`, `data/kanji_dict.json`, and `models/translate-ja_en.argosmodel`.

Offline sentence translation (optional):

- Translation is provided by `python_translate.py` using [Argos Translate](https://github.com/argosopentech/argos-translate).
- In packaged builds, the app first attempts to install a bundled `ja->en` Argos model from `models/translate-ja_en.argosmodel`.
- If Argos is not installed, the app still works and only skips sentence translation.
- On first use, the app will show an in-app progress popup while downloading/installing the `ja_en` model. This is a one-time setup.

Setup:

```bash
cd /Users/Mitchell.Sotto/Documents/code/japanese/screenshot-translate-electron
python3 -m venv .venv
source .venv/bin/activate
pip install argostranslate sentencepiece
argos-translate-cli --install ja_en
```
