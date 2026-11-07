// Keep preprocessing independent of OCR so the same pixels can be tested and
// re-read. Avoid erosion/thresholding here: thin Khmer marks are easy to erase.
export const MAX_OCR_PIXELS = 20_000_000;
const BORDER = 16;
type CanvasFactory = () => HTMLCanvasElement;

export function imageDimensions(width: number, height: number, enlarge = false) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('The image has invalid dimensions.');
  }
  const desired = enlarge ? Math.min(2, Math.max(1, 1600 / Math.min(width, height))) : 1;
  const scale = Math.min(desired, Math.sqrt(MAX_OCR_PIXELS / (width * height)), 12000 / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function percentile(histogram: Uint32Array, count: number, fraction: number) {
  let cumulative = 0;
  for (let value = 0; value < 256; value++) {
    cumulative += histogram[value];
    if (cumulative >= Math.max(1, count * fraction)) return value;
  }
  return 255;
}

export function normalizeScan(pixels: Uint8ClampedArray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    const gray = Math.round((pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) * alpha + 255 * (1 - alpha));
    histogram[gray]++;
  }
  const count = pixels.length / 4;
  const low = percentile(histogram, count, 0.005);
  const high = percentile(histogram, count, 0.995);
  const invert = percentile(histogram, count, 0.5) < 100 && high - low > 40;
  // Do not amplify a nearly blank page into noise or crush faint diacritics.
  const stretch = high - low >= 30 && high - low < 220;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    let gray = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) * alpha + 255 * (1 - alpha);
    if (stretch) gray = (gray - low) * 255 / (high - low);
    if (invert) gray = 255 - gray;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = gray;
    pixels[i + 3] = 255;
  }
}

// Projection profiles find the small angle at which text rows line up. Work on
// a thumbnail, ignore the outer border, and leave ambiguous/blank images alone.
export function estimateSkew(pixels: Uint8ClampedArray, width: number, height: number) {
  const points: [number, number][] = [];
  const step = Math.max(1, Math.ceil(Math.sqrt(width * height / 80_000)));
  let sampled = 0;
  for (let y = Math.ceil(height * 0.03); y < height * 0.97; y++) {
    for (let x = Math.ceil(width * 0.03); x < width * 0.97; x += step) {
      sampled++;
      const i = (y * width + x) * 4;
      if (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114 < 160) points.push([x - width / 2, y]);
    }
  }
  if (points.length < 200 || points.length / sampled > 0.4) return 0;
  const padding = Math.ceil(width * 0.1);
  const rows = new Uint32Array(height + padding * 2);
  function score(degrees: number) {
    rows.fill(0);
    const slope = Math.tan(degrees * Math.PI / 180);
    for (const [x, y] of points) rows[Math.round(y - x * slope) + padding]++;
    let total = 0;
    for (const count of rows) total += count * count;
    return total;
  }
  const straight = score(0);
  let best = straight, angle = 0;
  for (let degrees = -5; degrees <= 5; degrees += 0.5) {
    const candidate = score(degrees);
    if (candidate > best) { best = candidate; angle = degrees; }
  }
  const coarse = angle;
  for (let offset = -0.4; offset <= 0.4; offset += 0.1) {
    const degrees = Math.max(-5, Math.min(5, coarse + offset));
    const candidate = score(degrees);
    if (candidate > best) { best = candidate; angle = degrees; }
  }
  return Math.abs(angle) >= 0.3 && best > straight * 1.08 ? -angle : 0;
}

export function prepareOcrImage(source: HTMLCanvasElement, enhance: boolean, createCanvas: CanvasFactory = () => document.createElement('canvas')) {
  const size = imageDimensions(source.width, source.height, enhance);
  const working = createCanvas();
  working.width = size.width; working.height = size.height;
  const context = working.getContext('2d', { willReadFrequently: true })!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, working.width, working.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, working.width, working.height);
  let angle = 0;
  if (enhance) {
    const image = context.getImageData(0, 0, working.width, working.height);
    normalizeScan(image.data);
    context.putImageData(image, 0, 0);
    const sample = createCanvas();
    const scale = Math.min(1, 900 / Math.max(working.width, working.height));
    sample.width = Math.max(1, Math.round(working.width * scale));
    sample.height = Math.max(1, Math.round(working.height * scale));
    const sampleContext = sample.getContext('2d', { willReadFrequently: true })!;
    sampleContext.drawImage(working, 0, 0, sample.width, sample.height);
    angle = estimateSkew(sampleContext.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
    sample.width = sample.height = 0;
  }
  const radians = angle * Math.PI / 180;
  const width = Math.ceil(Math.abs(working.width * Math.cos(radians)) + Math.abs(working.height * Math.sin(radians))) + BORDER * 2;
  const height = Math.ceil(Math.abs(working.height * Math.cos(radians)) + Math.abs(working.width * Math.sin(radians))) + BORDER * 2;
  const bounded = imageDimensions(width, height);
  const result = createCanvas();
  result.width = bounded.width; result.height = bounded.height;
  const output = result.getContext('2d')!;
  output.fillStyle = '#fff'; output.fillRect(0, 0, result.width, result.height);
  output.translate(result.width / 2, result.height / 2);
  output.scale(result.width / width, result.height / height);
  output.rotate(radians);
  output.drawImage(working, -working.width / 2, -working.height / 2);
  working.width = working.height = 0;
  return result;
}
