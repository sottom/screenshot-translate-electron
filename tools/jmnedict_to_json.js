const fs = require('fs');
const path = require('path');

const xmlPath = process.argv[2] || path.join(__dirname, '..', 'data', 'JMnedict.xml');
const outPath = process.argv[3] || path.join(__dirname, '..', 'data', 'name_dict.json');

if (!fs.existsSync(xmlPath)) {
  console.error('JMnedict XML not found at', xmlPath);
  console.error('Download JMnedict.xml and place it at this path.');
  process.exit(1);
}

function decodeXmlEntities(input) {
  return (input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z0-9_+-]+;/g, '');
}

function extractAll(regex, text) {
  const out = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    out.push(decodeXmlEntities((match[1] || '').trim()));
  }
  return out;
}

const xml = fs.readFileSync(xmlPath, 'utf8');
const map = {};

function addDefinitions(key, definitions) {
  if (!key || definitions.length === 0) return;
  if (!map[key]) map[key] = [];
  const seen = new Set(map[key]);
  for (const def of definitions) {
    if (!def || seen.has(def)) continue;
    map[key].push(def);
    seen.add(def);
  }
}

const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
let entryMatch;
let entryCount = 0;

while ((entryMatch = entryRegex.exec(xml)) !== null) {
  entryCount += 1;
  const block = entryMatch[1];
  const kebs = extractAll(/<keb>([^<]+)<\/keb>/g, block);
  const rebs = extractAll(/<reb>([^<]+)<\/reb>/g, block);
  const transDets = extractAll(/<trans_det(?:\s+[^>]*)?>([\s\S]*?)<\/trans_det>/g, block)
    .map((g) => g.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const nameTypes = extractAll(/<name_type(?:\s+[^>]*)?>([\s\S]*?)<\/name_type>/g, block)
    .map((g) => g.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const defs = Array.from(new Set(transDets)).slice(0, 8);
  if (defs.length === 0) continue;

  const taggedDefs = nameTypes.length > 0
    ? defs.map((def) => `[name:${nameTypes.join(',')}] ${def}`)
    : defs.map((def) => `[name] ${def}`);

  for (const keb of kebs) addDefinitions(keb, taggedDefs);
  for (const reb of rebs) addDefinitions(reb, taggedDefs);
}

fs.writeFileSync(outPath, JSON.stringify(map), 'utf8');
console.log('Parsed JMnedict entries:', entryCount);
console.log('Written', Object.keys(map).length, 'name entries to', outPath);
try {
  fs.unlinkSync(xmlPath);
  console.log('Removed source XML:', xmlPath);
} catch (err) {
  console.warn('Failed to remove source XML:', xmlPath, err?.message || err);
}
