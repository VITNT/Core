import { imageDimensions } from './ocr-image';
import { findTextRows, type ImageRegion } from './ocr-layout';
import type { Page } from 'tesseract.js';

export type TextRegion = ImageRegion & { listStart?: boolean; label?: ImageRegion; bodyLeft?: number };

function inkHeight(source: HTMLCanvasElement, region: ImageRegion) {
  const { data } = source.getContext('2d', { willReadFrequently: true })!.getImageData(region.left, region.top, region.width, region.height);
  let top = -1, bottom = -1;
  for (let y = 0; y < region.height; y++) {
    let ink = 0;
    for (let x = 0; x < region.width; x++) if (data[(y * region.width + x) * 4] < 160) ink++;
    if (ink >= 3) { if (top < 0) top = y; bottom = y + 1; }
  }
  return top >= 0 ? bottom - top : region.height;
}

// Normalize the initial layout read too. Otherwise large PDF glyphs can turn
// the number gutter and detached marks into spurious blocks before row OCR.
export function preparePageLayout(source: HTMLCanvasElement, language: string, createCanvas: () => HTMLCanvasElement) {
  const context = source.getContext('2d', { willReadFrequently: true })!;
  const rows = markListRegions(source, findTextRows(context.getImageData(0, 0, source.width, source.height).data, source.width, source.height));
  const heights = rows.map((row) => inkHeight(source, row)).filter((height) => height >= 8).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)];
  const target = language === 'eng' ? 32 : 48;
  const scale = heights.length >= 3 && typical > target * 1.2 ? Math.max(0.25, target / typical) : 1;
  if (scale === 1) return { canvas: source, scaleX: 1, scaleY: 1, rows };
  const canvas = createCanvas();
  canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
  const output = canvas.getContext('2d')!;
  output.fillStyle = '#fff'; output.fillRect(0, 0, canvas.width, canvas.height);
  output.imageSmoothingEnabled = true; output.imageSmoothingQuality = 'high';
  output.drawImage(source, 0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / source.width, scaleY = canvas.height / source.height;
  return { canvas, scaleX, scaleY, rows };
}

// A repeated narrow gutter followed by a large gap marks list labels. Detect
// this in the pixels: page OCR often misreads the labels as a separate column.
export function markListRegions(canvas: HTMLCanvasElement, regions: ImageRegion[]): TextRegion[] {
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const candidates: { index: number; left: number; right: number; body: number; height: number }[] = [];
  for (const [index, region] of regions.entries()) {
    const { data } = context.getImageData(region.left, region.top, region.width, region.height);
    const columns: number[] = [];
    let top = region.height, bottom = 0;
    for (let x = 0; x < region.width; x++) {
      let ink = 0;
      for (let y = 0; y < region.height; y++) if (data[(y * region.width + x) * 4] < 160) {
        ink++; top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      }
      if (ink >= 2) columns.push(x);
    }
    const height = bottom - top;
    if (height < 8) continue;
    for (let i = 1; i < columns.length; i++) {
      if (columns[i - 1] - columns[0] > height * 1.6) break;
      if (columns[i] - columns[i - 1] < height * 0.5 || columns.at(-1)! - columns[i] < height * 3) continue;
      candidates.push({ index, left: region.left + columns[0], right: region.left + columns[i - 1] + 1, body: region.left + columns[i], height });
      break;
    }
  }
  const starts = new Map(candidates.filter((candidate) => candidates.filter((other) =>
    Math.abs(candidate.left - other.left) <= Math.min(candidate.height, other.height) * 0.4 &&
    Math.abs(candidate.body - other.body) <= Math.min(candidate.height, other.height) * 0.4).length >= 3).map((candidate) => [candidate.index, candidate]));
  return regions.map((region, index) => {
    const start = starts.get(index);
    return { ...region, ...(start ? { listStart: true, bodyLeft: start.body - 4,
      label: { left: Math.max(region.left, start.left - 4), top: region.top,
        width: start.right - Math.max(region.left, start.left - 4) + 4, height: region.height } } : {}) };
  });
}

// Projection rows retain detached marks. For columns, detect rows inside each
// layout block instead of joining unrelated text across the page.
export function recognitionRegions(canvas: HTMLCanvasElement, page: Page): TextRegion[] {
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const boxes = (page.blocks ?? []).filter((block) => block.paragraphs.some((p) => p.lines.some((line) => line.text.trim())))
    .map((block) => block.bbox);
  const columns = boxes.some((a, i) => boxes.slice(i + 1).some((b) =>
    Math.min(a.x1 - a.x0, b.x1 - b.x0) > canvas.width * 0.18 &&
    Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5 &&
    (a.x1 < b.x0 || b.x1 < a.x0)));
  if (!columns) return markListRegions(canvas, findTextRows(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height));
  // Keep the engine's block order for columns; their rows remain top-to-bottom.
  return markListRegions(canvas, boxes.flatMap((box) => {
    const left = Math.max(0, Math.floor(box.x0 - 8)), top = Math.max(0, Math.floor(box.y0 - 8));
    const width = Math.min(canvas.width, Math.ceil(box.x1 + 8)) - left;
    const height = Math.min(canvas.height, Math.ceil(box.y1 + 8)) - top;
    if (width <= 0 || height <= 0) return [];
    return findTextRows(context.getImageData(left, top, width, height).data, width, height)
      .map((row) => ({ ...row, left: row.left + left, top: row.top + top }));
  }));
}

export function prepareTextRegion(source: HTMLCanvasElement, region: ImageRegion, language: string,
  createCanvas: () => HTMLCanvasElement, shear = 0) {
  // Use ink height, not padded crop height, to normalize complete glyphs,
  // including Khmer subscripts and accents. Ignore isolated specks per row.
  const height = inkHeight(source, region);
  const target = language === 'eng' ? 32 : 48;
  const desired = Math.max(0.25, Math.min(2, target / height));
  const bounded = imageDimensions(Math.ceil((region.width + Math.abs(shear) * region.height) * desired) + 32, Math.ceil(region.height * desired) + 32);
  const scale = Math.min(desired, (bounded.width - 32) / (region.width + Math.abs(shear) * region.height), (bounded.height - 32) / region.height);
  const canvas = createCanvas();
  canvas.width = Math.min(bounded.width, Math.ceil((region.width + Math.abs(shear) * region.height) * scale) + 32);
  canvas.height = Math.min(bounded.height, Math.ceil(region.height * scale) + 32);
  const output = canvas.getContext('2d')!;
  output.fillStyle = '#fff'; output.fillRect(0, 0, canvas.width, canvas.height);
  output.imageSmoothingEnabled = true; output.imageSmoothingQuality = 'high';
  output.transform(scale, 0, shear * scale, scale, 16, 16);
  output.drawImage(source, region.left, region.top, region.width, region.height, 0, 0, region.width, region.height);
  return { canvas, scale };
}
