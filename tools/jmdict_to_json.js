const fs = require('fs');
const path = require('path');

const xmlPath = process.argv[2] || path.join(__dirname, '..', 'data', 'JMdict_e.xml');
const outPath = process.argv[3] || path.join(__dirname, '..', 'data', 'dict.json');

if (!fs.existsSync(xmlPath)) {
  console.error('JMdict XML not found at', xmlPath);
  console.error('Download JMdict_e.xml (JMdict English) and place it at this path.');
  process.exit(1);
}

function decodeXmlEntities(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    // Drop JMdict-specific named entities from DTD (e.g. &v5k;)
    .replace(/&[a-zA-Z0-9_+-]+;/g, '');
}

function extractAll(regex, text) {
  const out = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    out.push(decodeXmlEntities(match[1].trim()));
  }
  return out;
}

const xml = fs.readFileSync(xmlPath, 'utf8');
const map = {};
const addDefinitions = (key, definitions) => {
  if (!key || definitions.length === 0) return;
  if (!map[key]) map[key] = [];
  const seen = new Set(map[key]);
  for (const def of definitions) {
    if (!def || seen.has(def)) continue;
    map[key].push(def);
    seen.add(def);
  }
};

const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
let entryMatch;
let entryCount = 0;
while ((entryMatch = entryRegex.exec(xml)) !== null) {
  entryCount += 1;
  const block = entryMatch[1];
  const kebs = extractAll(/<keb>([^<]+)<\/keb>/g, block);
  const rebs = extractAll(/<reb>([^<]+)<\/reb>/g, block);
  const glosses = extractAll(/<gloss(?:\s+[^>]*)?>([\s\S]*?)<\/gloss>/g, block)
    .map((g) => g.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const defs = Array.from(new Set(glosses)).slice(0, 8);

  for (const keb of kebs) addDefinitions(keb, defs);
  for (const reb of rebs) addDefinitions(reb, defs);
}

fs.writeFileSync(outPath, JSON.stringify(map), 'utf8');
console.log('Parsed entries:', entryCount);
console.log('Written', Object.keys(map).length, 'entries to', outPath);
try {
  fs.unlinkSync(xmlPath);
  console.log('Removed source XML:', xmlPath);
} catch (err) {
  console.warn('Failed to remove source XML:', xmlPath, err?.message || err);
}
