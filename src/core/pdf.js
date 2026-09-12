/** Full, searchable, print-friendly PDFs. No DOM, network or bank mutations. */
const label = key => key.replaceAll('_', ' ');
const valueText = value => typeof value === 'object' ? JSON.stringify(value) : String(value);

function details(object, omitted) {
  return Object.entries(object ?? {})
    .filter(([key, value]) => !omitted.includes(key) && value != null)
    .map(([key, value]) => `${label(key)}: ${valueText(value)}`);
}

/** A complete record, formatted for reading; unknown fields are retained too. */
export function entryParagraphs(word) {
  const rows = [];
  if (word.phonetic) rows.push({ text: word.phonetic, size: 10 });
  for (const [i, sense] of (word.senses ?? []).entries()) {
    rows.push({ text: `${i + 1}. ${sense.pos ? `${sense.pos} · ` : ''}${sense.def ?? ''}`, size: 10.5 });
    if (sense.example) rows.push({ text: `“${sense.example}”`, size: 10, indent: 12 });
    for (const text of details(sense, ['pos', 'def', 'example'])) rows.push({ text, size: 9, indent: 12 });
  }
  if (word.synonyms?.length) {
    rows.push({ text: `Synonyms: ${word.synonyms.map(s => {
      if (typeof s === 'string') return s;
      const extra = details(s, ['word']);
      return `${s.word}${extra.length ? ` (${extra.join('; ')})` : ''}`;
    }).join(' · ')}`, size: 9 });
  }
  rows.push({ text: `Added: ${word.added ?? 'unknown'} · Practised: ${word.times_used ?? 0} · Essay uses: ${word.essay_uses ?? 0}`, size: 8.5 });
  if (word.srs) rows.push({ text: `Review schedule · ${details(word.srs, []).join(' · ')}${word.srs.last == null ? ' · last: never' : ''}`, size: 8.5 });
  if (word.source) rows.push({ text: `Source: ${word.source}`, size: 8.5 });
  if (word.source_url) rows.push({ text: word.source_url, size: 8 });
  if (word.clarification_url) rows.push({ text: `Clarification: ${word.clarification_url}`, size: 8 });
  const handled = ['word', 'phonetic', 'senses', 'synonyms', 'added', 'times_used', 'essay_uses', 'srs', 'source', 'source_url', 'clarification_url'];
  for (const [key, value] of Object.entries(word)) {
    if (handled.includes(key) || value == null) continue;
    if (typeof value === 'object' && !Object.keys(value).length) continue;
    if (['created', 'updated', 'definition_updated'].includes(key) && Number.isFinite(value)) {
      rows.push({ text: `${label(key)}: ${new Date(value).toISOString()}`, size: 8 });
    } else if (['review_events', 'essay_use_events'].includes(key)) {
      rows.push({ text: `${label(key)}: ${Object.entries(value).map(([id, item]) => `${id}: ${item}`).join(' · ')}`, size: 8 });
    } else rows.push({ text: `${label(key)}: ${valueText(value)}`, size: 8.5 });
  }
  return rows;
}

export function buildBankPdf(words, { jsPDF, fonts, orderLabel = 'date added — newest', date = new Date() } = {}) {
  if (!words.length) throw new Error('There are no words to export yet.');
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true, putOnlyUsedFonts: true });
  doc.addFileToVFS('body.ttf', fonts.body);
  doc.addFont('body.ttf', 'LexisBody', 'normal');
  doc.addFileToVFS('heading.ttf', fonts.heading);
  doc.addFont('heading.ttf', 'LexisHeading', 'normal');
  let fallbackAdded = false;
  function textStyle(text, heading = false) {
    let font = heading ? 'LexisHeading' : 'LexisBody';
    const normalized = String(text).normalize('NFC');
    const hasGlyph = (name, char) => char === '\n' || char === '\r' || char === '\t' ||
      (char.codePointAt(0) <= 0xffff && doc.getFont(name, 'normal').metadata.characterToGlyph(char.codePointAt(0)) !== 0);
    if ([...normalized].some(char => !hasGlyph(font, char))) {
      if (!fallbackAdded) {
        doc.addFileToVFS('fallback.ttf', fonts.fallback);
        doc.addFont('fallback.ttf', 'LexisFallback', 'normal');
        fallbackAdded = true;
      }
      font = 'LexisFallback';
    }
    // Unassigned/supplementary characters unsupported by the PDF engine are
    // preserved as explicit code points, never silently removed.
    const safe = [...normalized].map(char => hasGlyph(font, char) ? char : `[U+${char.codePointAt(0).toString(16).toUpperCase()}]`).join('');
    return { font, text: safe };
  }
  doc.setProperties({ title: 'lexis · word bank', subject: orderLabel, author: 'lexis' });
  doc.setCreationDate(date);
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = 42;
  const bottom = height - 49;
  let y = margin;
  let currentWord = '';

  function newPage() {
    doc.addPage();
    y = margin;
    if (currentWord) {
      const continued = textStyle(`${currentWord} · continued`);
      doc.setFont(continued.font, 'normal').setFontSize(8).setTextColor(85);
      doc.text(continued.text, margin, y);
      y += 20;
    }
  }

  function paragraph(text, { size = 10, indent = 0, heading = false, gap = 5 } = {}) {
    const styled = textStyle(text, heading);
    const font = styled.font;
    doc.setFont(font, 'normal').setFontSize(size);
    const lines = doc.splitTextToSize(styled.text, width - margin * 2 - indent);
    const lineHeight = size * 1.45;
    for (const line of lines) {
      if (y + lineHeight > bottom) newPage();
      doc.setFont(font, 'normal').setFontSize(size);
      if (heading) doc.setTextColor(46, 77, 102);
      else doc.setTextColor(30);
      doc.text(line, margin + indent, y);
      y += lineHeight;
    }
    y += gap;
  }

  paragraph('lexis. / word bank', { size: 23, heading: true, gap: 8 });
  paragraph(`${words.length} word${words.length === 1 ? '' : 's'} · exported ${date.toISOString().slice(0, 10)}`, { size: 9 });
  paragraph(`Order: ${orderLabel}`, { size: 9, gap: 16 });
  if (orderLabel.includes('AI')) paragraph('Related meanings are placed together by AI similarity; neighbours are not necessarily synonyms.', { size: 8.5, gap: 12 });

  for (const word of words) {
    currentWord = '';
    const rows = entryParagraphs(word);
    // Keep ordinary entries intact; long entries flow and repeat the headword.
    let estimated = 37;
    for (const row of rows) {
      const styled = textStyle(row.text);
      doc.setFont(styled.font, 'normal').setFontSize(row.size);
      estimated += doc.splitTextToSize(styled.text, width - margin * 2 - (row.indent ?? 0)).length * row.size * 1.45 + 5;
    }
    if (y + 70 > bottom || (estimated < bottom - margin && y + estimated > bottom)) newPage();
    paragraph(word.word, { size: 17, heading: true, gap: 7 });
    currentWord = word.word;
    for (const row of rows) paragraph(row.text, row);
    y += 8;
    if (y < bottom - 10) {
      doc.setDrawColor(205).setLineWidth(0.4).line(margin, y, width - margin, y);
      y += 23;
    }
  }
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont('LexisBody', 'normal').setFontSize(8).setTextColor(80);
    doc.text('lexis · word bank', margin, height - 28);
    doc.text(`${page} / ${pages}`, width - margin, height - 28, { align: 'right' });
  }
  return new Uint8Array(doc.output('arraybuffer'));
}

let assets;
export function preloadBankPdf() {
  if (!assets) {
    assets = Promise.all([
      import('../vendor/jspdf.umd.min.js'),
      ...['DejaVuSans.ttf', 'DejaVuSerif.ttf', 'Unifont.ttf'].map(async name => {
        const response = await fetch(new URL(`../fonts/${name}`, import.meta.url));
        if (!response.ok) throw new Error('Could not load the PDF fonts. Please try again.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(binary);
      }),
    ]).catch(error => { assets = null; throw error; });
  }
  return assets;
}

export async function createBankPdf(words, options = {}) {
  const [, body, heading, fallback] = await preloadBankPdf();
  return buildBankPdf(words, { ...options, jsPDF: globalThis.jspdf.jsPDF, fonts: { body, heading, fallback } });
}
