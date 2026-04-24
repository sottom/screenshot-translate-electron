const fs = require('fs');
const path = require('path');

const xmlPath = process.argv[2] || path.join(__dirname, '..', 'data', 'kanjidic2.xml');
const outPath = process.argv[3] || path.join(__dirname, '..', 'data', 'kanji_dict.json');

if (!fs.existsSync(xmlPath)) {
  console.error('KANJIDIC2 XML not found at', xmlPath);
  console.error('Download kanjidic2.xml and place it at this path.');
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
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function extractAll(regex, text) {
  const out = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    out.push(decodeXmlEntities((match[1] || '').trim()));
  }
  return out;
}

function extractOne(regex, text) {
  const m = regex.exec(text);
  if (!m || !m[1]) return null;
  return decodeXmlEntities(m[1].trim());
}

function parseIntOrNull(value) {
  const num = Number.parseInt((value || '').toString(), 10);
  return Number.isFinite(num) ? num : null;
}

const xml = fs.readFileSync(xmlPath, 'utf8');
const map = {};
const charRegex = /<character>([\s\S]*?)<\/character>/g;
let charMatch;
let entryCount = 0;

while ((charMatch = charRegex.exec(xml)) !== null) {
  const block = charMatch[1];
  const literal = extractOne(/<literal>([^<]+)<\/literal>/, block);
  if (!literal) continue;
  entryCount += 1;

  const on = Array.from(new Set(extractAll(/<reading[^>]*r_type="ja_on"[^>]*>([^<]+)<\/reading>/g, block)));
  const kun = Array.from(new Set(extractAll(/<reading[^>]*r_type="ja_kun"[^>]*>([^<]+)<\/reading>/g, block)));
  const nanori = Array.from(new Set(extractAll(/<nanori>([^<]+)<\/nanori>/g, block)));
  const meanings = Array.from(new Set(
    extractAll(/<meaning(?:\s+[^>]*)?>([^<]+)<\/meaning>/g, block)
  )).filter(Boolean);

  map[literal] = {
    on,
    kun,
    nanori,
    meanings,
    grade: parseIntOrNull(extractOne(/<grade>([^<]+)<\/grade>/, block)),
    jlpt: parseIntOrNull(extractOne(/<jlpt>([^<]+)<\/jlpt>/, block)),
    strokes: parseIntOrNull(extractOne(/<stroke_count>([^<]+)<\/stroke_count>/, block)),
    freq: parseIntOrNull(extractOne(/<freq>([^<]+)<\/freq>/, block))
  };
}

fs.writeFileSync(outPath, JSON.stringify(map), 'utf8');
console.log('Parsed kanji entries:', entryCount);
console.log('Written', Object.keys(map).length, 'kanji entries to', outPath);
try {
  fs.unlinkSync(xmlPath);
  console.log('Removed source XML:', xmlPath);
} catch (err) {
  console.warn('Failed to remove source XML:', xmlPath, err?.message || err);
}
