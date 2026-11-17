import { imageDimensions } from './ocr-image';
import { findTextRows, type ImageRegion } from './ocr-layout';
import type { Page } from 'tesseract.js';

// segmentOf: this region is one piece of a row that was split at wide gaps;
// pieces of the same row share the value and belong on one output line.
export type TextRegion = ImageRegion & { listStart?: boolean; label?: ImageRegion; bodyLeft?: number; segmentOf?: number };

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

// Text lines inside one detected row: tall rows are usually a large heading
// (one line) but can be lines the row finder could not separate.
export function countTextLines(source: HTMLCanvasElement, region: ImageRegion) {
  const { data } = source.getContext('2d', { willReadFrequently: true })!.getImageData(region.left, region.top, region.width, region.height);
  return findTextRows(data, region.width, region.height).length;
}

// Pieces of one row separated by a blank gap much wider than a word space:
// a chapter label and its title, the two ends of a running header. Read as one
// line they mislead the recognizer (the gap is filled with invented Latin
// words) and the vote (readings no longer line up). Each piece is returned as
// its own region. Isolated specks far from the text are left out.
export function splitWideGaps(source: HTMLCanvasElement, region: TextRegion, id: number): TextRegion[] {
  if (region.label || region.bodyLeft !== undefined || region.width < 8 || region.height < 8) return [region];
  const { data } = source.getContext('2d', { willReadFrequently: true })!.getImageData(region.left, region.top, region.width, region.height);
  const tops = new Int32Array(region.width).fill(-1), bottoms = new Int32Array(region.width).fill(-1), inks = new Int32Array(region.width);
  let top = region.height, bottom = 0;
  for (let x = 0; x < region.width; x++) for (let y = 0; y < region.height; y++) if (data[(y * region.width + x) * 4] < 160) {
    if (tops[x] < 0) tops[x] = y;
    bottoms[x] = y + 1; inks[x]++; top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
  }
  const height = bottom - top;
  if (height < 8) return [region];
  type Piece = { left: number; right: number; top: number; bottom: number; ink: number };
  const group = (gap: number, columns: Piece[]) => {
    const pieces: Piece[] = [];
    for (const column of columns) {
      const piece = pieces.at(-1);
      if (piece && column.left - piece.right <= gap) {
        piece.right = column.right; piece.top = Math.min(piece.top, column.top); piece.bottom = Math.max(piece.bottom, column.bottom); piece.ink += column.ink;
      } else pieces.push({ ...column });
    }
    return pieces;
  };
  const columns: Piece[] = [];
  for (let x = 0; x < region.width; x++) if (tops[x] >= 0) columns.push({ left: x, right: x + 1, top: tops[x], bottom: bottoms[x], ink: inks[x] });
  // Specks and leftovers of ruled lines are much lower than the text, or a few
  // scattered dots. Marks closer than a word space stay with their text.
  const clusters = group(height * 0.6, columns);
  const solid = clusters.filter((piece) => piece.bottom - piece.top >= height * 0.3 &&
    piece.ink >= (piece.right - piece.left) * (piece.bottom - piece.top) * 0.1);
  if (!solid.length) return [region];
  const text = group(height * 2.5, solid);
  if (text.length === 1 && solid.length === clusters.length) return [region];
  const padding = Math.max(10, Math.round(height * 0.35));
  return text.map((piece, index) => {
    const left = Math.max(region.left, region.left + piece.left - padding);
    const right = Math.min(region.left + region.width, region.left + piece.right + padding);
    return { ...region, left, width: right - left, ...(text.length > 1 ? { segmentOf: id } : {}), ...(index ? { listStart: undefined } : {}) };
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
    // A real column gutter is wide. Page OCR can also split one text line
    // into side-by-side blocks at an ordinary word space.
    Math.max(b.x0 - a.x1, a.x0 - b.x1) >= canvas.width * 0.02));
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

// thresholding: Tesseract's thresholding_method for this reading ('1' adaptive Otsu, '2' Sauvola).
export type RegionVariant = { target?: number; levels?: readonly [number, number]; thresholding?: '0' | '1' | '2' };

export function prepareTextRegion(source: HTMLCanvasElement, region: ImageRegion, language: string,
  createCanvas: () => HTMLCanvasElement, shear = 0, variant: RegionVariant = {}) {
  // Use ink height, not padded crop height, to normalize complete glyphs,
  // including Khmer subscripts and accents. Ignore isolated specks per row.
  const height = inkHeight(source, region);
  const target = variant.target ?? (language === 'eng' ? 32 : 48);
  const desired = Math.max(0.25, Math.min(2, target / height));
  const bounded = imageDimensions(Math.ceil((region.width + Math.abs(shear) * region.height) * desired) + 32, Math.ceil(region.height * desired) + 32);
  const scale = Math.min(desired, (bounded.width - 32) / (region.width + Math.abs(shear) * region.height), (bounded.height - 32) / region.height);
  const canvas = createCanvas();
  canvas.width = Math.min(bounded.width, Math.ceil((region.width + Math.abs(shear) * region.height) * scale) + 32);
  canvas.height = Math.min(bounded.height, Math.ceil(region.height * scale) + 32);
  const output = canvas.getContext('2d', { willReadFrequently: Boolean(variant.levels) })!;
  output.fillStyle = '#fff'; output.fillRect(0, 0, canvas.width, canvas.height);
  output.imageSmoothingEnabled = true; output.imageSmoothingQuality = 'high';
  output.transform(scale, 0, shear * scale, scale, 16, 16);
  output.drawImage(source, region.left, region.top, region.width, region.height, 0, 0, region.width, region.height);
  if (variant.levels) {
    // A gentle levels change alters stroke weight without hard thresholding.
    const [low, high] = variant.levels;
    output.resetTransform();
    const image = output.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const gray = (image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114 - low) * 255 / (high - low);
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.max(0, Math.min(255, gray));
    }
    output.putImageData(image, 0, 0);
  }
  return { canvas, scale };
}
