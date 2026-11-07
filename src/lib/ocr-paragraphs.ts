type ParagraphReading = {
  text: string;
  blocks: readonly { paragraphs: readonly { lines: readonly { text: string }[] }[] }[] | null;
};

function joinWrappedLines(lines: string[]) {
  let paragraph = '';
  let boundarySpace = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const trailingSpace = /[^\S\r\n]$/u.test(raw);
    if (!paragraph) { paragraph = line; boundarySpace = trailingSpace; continue; }
    if (paragraph.endsWith('\u00ad')) {
      // A soft hyphen explicitly marks a discretionary line-wrap break.
      paragraph = paragraph.slice(0, -1) + line;
      boundarySpace = trailingSpace;
      continue;
    }
    // Khmer wraps can split a continuous word/phrase; adding a Latin-style
    // space there changes the text. Keep real spaces inside each source line.
    const khmerWrap = /[\u1780-\u17d3\u17dd\u200b]$/u.test(paragraph) && /^[\u1780-\u17d3\u17dd]/u.test(line);
    const hyphenWrap = /\p{L}[-\u2010]$/u.test(paragraph) && /^\p{L}/u.test(line);
    paragraph += (hyphenWrap || (khmerWrap && !boundarySpace) ? '' : ' ') + line;
    boundarySpace = trailingSpace;
  }
  return paragraph;
}

function fallbackParagraphs(text: string) {
  return text.split(/\n[^\S\n]*\n+/u).map((paragraph) => joinWrappedLines(paragraph.split('\n'))).filter(Boolean).join('\n\n');
}

// Re-reads/cleanup preserve line count but may change word lengths. Map layout
// paragraphs to source line numbers, then take the corrected lines by number.
// Never rebuild output from stale structured word text or lose unmatched text.
export function formatOcrParagraphs(reading: ParagraphReading, correctedText = reading.text): string {
  const source = reading.text.replace(/\r\n?/gu, '\n');
  const corrected = correctedText.replace(/\r\n?/gu, '\n');
  const lines = corrected.split('\n');
  if (!reading.blocks?.length || source.split('\n').length !== lines.length) return fallbackParagraphs(corrected);
  const paragraphs: { first: number; last: number }[] = [];
  let cursor = 0, lineNumber = 0, lastMappedLine = -1;
  for (const block of reading.blocks) for (const paragraph of block.paragraphs) {
    let first: number | undefined, last = 0;
    for (const line of paragraph.lines) {
      const text = line.text.trim();
      if (!text) continue;
      if (/[\r\n]/u.test(text)) return fallbackParagraphs(corrected);
      const start = source.indexOf(text, cursor);
      if (start < 0) return fallbackParagraphs(corrected);
      const gap = source.slice(cursor, start);
      if (gap.trim()) return fallbackParagraphs(corrected);
      lineNumber += gap.match(/\n/gu)?.length ?? 0;
      // Two layout lines on the same source text line cannot be mapped safely.
      if (lineNumber <= lastMappedLine) return fallbackParagraphs(corrected);
      lastMappedLine = lineNumber;
      first ??= lineNumber;
      last = lineNumber;
      cursor = start + text.length;
    }
    if (first !== undefined) paragraphs.push({ first, last });
  }
  if (!paragraphs.length || source.slice(cursor).trim()) return fallbackParagraphs(corrected);
  return paragraphs.map(({ first, last }) => joinWrappedLines(lines.slice(first, last + 1))).filter(Boolean).join('\n\n');
}
