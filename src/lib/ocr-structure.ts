import type { Bbox, Line, Page, Paragraph } from 'tesseract.js';
import type { TextRegion } from './ocr-regions';

const compact = (text: string) => text.replace(/\s/gu, '');
const bounds = (lines: Line[]) => ({ x0: Math.min(...lines.map((l) => l.bbox.x0)), y0: Math.min(...lines.map((l) => l.bbox.y0)),
  x1: Math.max(...lines.map((l) => l.bbox.x1)), y1: Math.max(...lines.map((l) => l.bbox.y1)) });

export function mapLayoutCoordinates(page: Page, scaleX: number, scaleY: number): Page {
  if (scaleX === 1 && scaleY === 1) return page;
  const box = (b: Bbox): Bbox => ({ x0: b.x0 / scaleX, x1: b.x1 / scaleX, y0: b.y0 / scaleY, y1: b.y1 / scaleY });
  return { ...page, blocks: page.blocks?.map((block) => ({ ...block, bbox: box(block.bbox),
    paragraphs: block.paragraphs.map((p) => ({ ...p, bbox: box(p.bbox), lines: p.lines.map((line) => ({ ...line,
      bbox: box(line.bbox), baseline: line.baseline ? box(line.baseline) : line.baseline,
      rowAttributes: { ...line.rowAttributes, rowHeight: line.rowAttributes.rowHeight / scaleY,
        ascenders: line.rowAttributes.ascenders / scaleY, descenders: line.rowAttributes.descenders / scaleY },
      words: line.words.map((word) => ({ ...word, bbox: box(word.bbox),
        symbols: word.symbols?.map((symbol) => ({ ...symbol, bbox: box(symbol.bbox) })) })),
    })) })),
  })) ?? null };
}

export type ListLabel = { region: TextRegion; text: string; confidence: number };

// PDF layout OCR can emit a detached mark twice: inside a Khmer word's box,
// and again as a tiny independent line. Suppress only geometrically duplicated
// short fragments; small standalone text and marks outside word boxes survive.
export function suppressCoveredFragments(page: Page): Page {
  const lines = page.blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)) ?? [];
  if (compact(lines.map((line) => line.text).join('')) !== compact(page.text)) return page;
  const duplicated = new Set(lines.filter((line) => {
    const box = line.bbox, height = box.y1 - box.y0, area = (box.x1 - box.x0) * height;
    if (compact(line.text).length > 3 || area <= 0) return false;
    return lines.some((other) => other !== line && other.bbox.y1 - other.bbox.y0 >= height * 2.5 &&
      (other.text.match(/\p{Script=Khmer}/gu)?.length ?? 0) >= 6 && other.words.some((word) => {
        const b = word.bbox;
        const overlap = Math.max(0, Math.min(b.x1, box.x1) - Math.max(b.x0, box.x0)) *
          Math.max(0, Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0));
        return overlap >= area * 0.8;
      }));
  }));
  if (!duplicated.size) return page;
  const blocks = page.blocks!.map((b) => {
    const paragraphs = b.paragraphs.flatMap((p) => {
      const remaining = p.lines.filter((line) => !duplicated.has(line));
      return remaining.length ? [{ ...p, lines: remaining, bbox: bounds(remaining),
        text: remaining.map((line) => line.text.trimEnd()).join('\n') + '\n' }] : [];
    });
    return { ...b, paragraphs, text: paragraphs.map((p) => p.text.trimEnd()).join('\n\n') + '\n' };
  }).filter((b) => b.paragraphs.length);
  return { ...page, blocks, text: blocks.map((b) => b.text.trimEnd()).join('\n\n') + '\n' };
}

export function attachListLabels(page: Page, labels: ListLabel[]): Page {
  const lines = page.blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)) ?? [];
  const replacements = new Map<Line, Line>();
  for (const label of labels) {
    const { region } = label;
    const matching = lines.filter((line) => {
      const center = (line.bbox.y0 + line.bbox.y1) / 2;
      return center >= region.top && center < region.top + region.height &&
        line.bbox.x1 - line.bbox.x0 > region.width * 0.2 &&
        line.bbox.y1 - line.bbox.y0 > region.height * 0.35 && line.bbox.y1 - line.bbox.y0 <= region.height * 1.8;
    });
    if (matching.length !== 1 || /^\s*[0-9០-៩]+[.)]\s*/u.test(matching[0].text) || !region.label) continue;
    const line = matching[0], box = region.label;
    replacements.set(line, { ...line, text: `${label.text} ${line.text.trimEnd()}\n`,
      bbox: { ...line.bbox, x0: Math.min(box.left, line.bbox.x0) },
      words: [{ ...line.words[0], text: label.text, confidence: label.confidence, symbols: [],
        bbox: { x0: box.left, y0: box.top, x1: box.left + box.width, y1: box.top + box.height } }, ...line.words] });
  }
  if (!replacements.size) return page;
  const blocks = page.blocks!.map((block) => {
    const paragraphs = block.paragraphs.map((p) => {
      const updated = p.lines.map((line) => replacements.get(line) ?? line);
      return { ...p, lines: updated, bbox: bounds(updated), text: updated.map((line) => line.text.trimEnd()).join('\n') + '\n' };
    });
    return { ...block, paragraphs, bbox: bounds(paragraphs.flatMap((p) => p.lines)),
      text: paragraphs.map((p) => p.text.trimEnd()).join('\n\n') + '\n' };
  });
  return { ...page, blocks, text: blocks.map((b) => b.text.trimEnd()).join('\n\n') + '\n' };
}

// Choosing OCR text and choosing paragraph boundaries are separate decisions.
// Even a retained whole-page reading must respect visible list item starts.
export function preserveRegionParagraphs(page: Page, regions: TextRegion[]): Page {
  const allLines = page.blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)) ?? [];
  if (!allLines.length || compact(allLines.map((l) => l.text).join('')) !== compact(page.text)) return page;
  const rowFor = (line: Line) => {
    const center = (line.bbox.y0 + line.bbox.y1) / 2;
    const height = line.bbox.y1 - line.bbox.y0;
    return regions.findIndex((r) => center >= r.top && center < r.top + r.height && height <= r.height * 1.8 &&
      Math.min(line.bbox.x1, r.left + r.width) - Math.max(line.bbox.x0, r.left) > 0);
  };
  let changed = false;
  const blocks = page.blocks!.map((block) => {
    const paragraphs = block.paragraphs.flatMap((paragraph) => {
      const groups: Line[][] = [];
      for (const line of paragraph.lines) {
        const previous = groups.at(-1)?.at(-1);
        const row = rowFor(line), previousRow = previous ? rowFor(previous) : -1;
        const numbered = /^\s*[0-9០-៩]+[.)]\s*\S/u.test(line.text);
        const boundary = !previous || (row !== previousRow && (numbered || (row >= 0 && regions[row].listStart))) ||
          (row >= 0 && previousRow >= 0 && row !== previousRow &&
            Math.max(regions[row].height, regions[previousRow].height) > Math.min(regions[row].height, regions[previousRow].height) * 1.4);
        if (boundary) groups.push([]);
        groups.at(-1)!.push(line);
      }
      if (groups.length <= 1) return [paragraph];
      changed = true;
      return groups.map((lines): Paragraph => ({ ...paragraph, lines, bbox: bounds(lines),
        text: lines.map((line) => line.text.trimEnd()).join('\n') + '\n' }));
    });
    return { ...block, paragraphs, text: paragraphs.map((p) => p.text.trimEnd()).join('\n\n') + '\n' };
  });
  // The engine can also put a wrapped tail in a different paragraph/block.
  // Rejoin only adjacent indented rows belonging to an established list item.
  const merged: { paragraph: Paragraph; block: NonNullable<Page['blocks']>[number] }[] = [];
  let joined = false;
  for (const block of blocks) for (const paragraph of block.paragraphs) {
    const previous = merged.at(-1)?.paragraph;
    const row = paragraph.lines.length ? rowFor(paragraph.lines[0]) : -1;
    const previousRow = previous?.lines.length ? rowFor(previous.lines.at(-1)!) : -1;
    const listRow = previous?.lines.map(rowFor).reverse().find((index) => index >= 0 && regions[index].listStart);
    const bodyLeft = listRow === undefined ? undefined : regions[listRow].bodyLeft;
    if (previous && row >= 0 && previousRow >= 0 && row === previousRow + 1 && !regions[row].listStart && bodyLeft !== undefined &&
        Math.abs(regions[row].left - bodyLeft) < regions[previousRow].height * 1.5 &&
        regions[row].top - regions[previousRow].top - regions[previousRow].height < regions[previousRow].height * 0.8) {
      const lines = [...previous.lines, ...paragraph.lines];
      merged.at(-1)!.paragraph = { ...previous, lines, bbox: bounds(lines), text: lines.map((line) => line.text.trimEnd()).join('\n') + '\n' };
      joined = true;
    } else merged.push({ paragraph, block });
  }
  if (joined) {
    const rebuilt = merged.map(({ paragraph, block }) => ({ ...block, paragraphs: [paragraph], bbox: paragraph.bbox, text: paragraph.text }));
    return { ...page, blocks: rebuilt, text: rebuilt.map((b) => b.text.trimEnd()).join('\n\n') + '\n' };
  }
  return changed ? { ...page, blocks, text: blocks.map((b) => b.text.trimEnd()).join('\n\n') + '\n' } : page;
}
