export type ImageRegion = { left: number; top: number; width: number; height: number };

// Only long, regularly spaced runs of small isolated marks qualify. Ordinary
// ellipses, decimal points and the detached marks in Khmer text are retained.
export function findDotLeaders(pixels: Uint8ClampedArray, width: number, height: number): ImageRegion[] {
  const ink = new Uint8Array(width * height);
  let total = 0;
  for (let i = 0; i < ink.length; i++) {
    if (pixels[i * 4] < 160) { ink[i] = 1; total++; }
  }
  if (total > ink.length * 0.35) return [];
  const limit = Math.max(5, Math.round(Math.min(width, height) / 180));
  const dots: ImageRegion[] = [];
  const stack: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start]) continue;
    ink[start] = 0;
    stack.push(start);
    let x0 = width, x1 = 0, y0 = height, y1 = 0, area = 0;
    while (stack.length) {
      const index = stack.pop()!;
      const x = index % width, y = Math.floor(index / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      area++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = index + dy * width + dx;
        if (ink[next]) { ink[next] = 0; stack.push(next); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (area >= 2 && w <= limit && h <= limit && w / h >= 0.4 && w / h <= 2.5) dots.push({ left: x0, top: y0, width: w, height: h });
  }
  const tolerance = Math.max(2, Math.round(limit / 4));
  const rows = new Map<number, ImageRegion[]>();
  for (const dot of dots) {
    const center = dot.top + dot.height / 2;
    const key = Math.round(center / tolerance);
    const match = [key, key - 1, key + 1].find((candidate) => {
      const row = rows.get(candidate);
      return row && Math.abs(row[0].top + row[0].height / 2 - center) <= tolerance;
    });
    const bucket = match ?? key;
    if (!rows.has(bucket)) rows.set(bucket, []);
    rows.get(bucket)!.push(dot);
  }
  const leaders: ImageRegion[] = [];
  function accept(run: ImageRegion[]) {
    if (run.length < 16) return;
    const first = run[0], last = run[run.length - 1];
    if (last.left + last.width - first.left < width * 0.2) return;
    const top = Math.min(...run.map((dot) => dot.top));
    const bottom = Math.max(...run.map((dot) => dot.top + dot.height));
    leaders.push({ left: first.left, top, width: last.left + last.width - first.left, height: bottom - top });
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.left - b.left);
    let run: ImageRegion[] = [], gap = 0;
    for (const dot of row) {
      const previous = run.at(-1);
      const distance = previous ? dot.left - previous.left : 0;
      if (previous && (distance < 2 || distance > limit * 6 || (gap > 0 && (distance < gap * 0.6 || distance > gap * 1.5)))) {
        accept(run); run = []; gap = 0;
      }
      if (run.length) gap = gap ? (gap * (run.length - 1) + distance) / run.length : distance;
      run.push(dot);
    }
    accept(run);
  }
  return leaders;
}

export function eraseDotLeaders(pixels: Uint8ClampedArray, width: number, height: number, leaders: ImageRegion[]) {
  for (const region of leaders) {
    for (let y = Math.max(0, region.top - 1); y < Math.min(height, region.top + region.height + 1); y++) {
      for (let x = Math.max(0, region.left - 1); x < Math.min(width, region.left + region.width + 1); x++) {
        const index = (y * width + x) * 4;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
      }
    }
  }
}

export function eraseTableRulings(pixels: Uint8ClampedArray, width: number, height: number): ImageRegion[] {
  const horizontal: ImageRegion[] = [], vertical: ImageRegion[] = [];
  const minWidth = Math.max(100, Math.round(width * 0.2));
  const minHeight = Math.max(70, Math.round(height * 0.03));
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && pixels[(y * width + x) * 4] < 160) { if (start < 0) start = x; }
      else if (start >= 0) {
        if (x - start >= minWidth) horizontal.push({ left: start, top: y, width: x - start, height: 1 });
        start = -1;
      }
    }
  }
  if (!horizontal.length) return [];
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      if (y < height && pixels[(y * width + x) * 4] < 160) { if (start < 0) start = y; }
      else if (start >= 0) {
        if (y - start >= minHeight) vertical.push({ left: x, top: start, width: 1, height: y - start });
        start = -1;
      }
    }
  }
  function merge(lines: ImageRegion[], upright: boolean) {
    const merged: ImageRegion[] = [];
    for (const line of lines) {
      const previous = merged.find((other) => upright
        ? line.left <= other.left + other.width + 1 && Math.abs(line.top - other.top) <= 2 && Math.abs(line.height - other.height) <= 4
        : line.top <= other.top + other.height + 1 && Math.abs(line.left - other.left) <= 2 && Math.abs(line.width - other.width) <= 4);
      if (previous) {
        previous.width = Math.max(previous.left + previous.width, line.left + line.width) - previous.left;
        previous.height = Math.max(previous.top + previous.height, line.top + line.height) - previous.top;
      } else merged.push({ ...line });
    }
    return merged.filter((line) => (upright ? line.width : line.height) <= Math.max(4, Math.min(width, height) / 150));
  }
  const hs = merge(horizontal, false), vs = merge(vertical, true);
  const crosses = (h: ImageRegion, v: ImageRegion) => v.left >= h.left - 2 && v.left <= h.left + h.width + 2 && h.top >= v.top - 2 && h.top <= v.top + v.height + 2;
  // Require an actual grid intersection; detached strokes and ordinary
  // underlining are not enough to identify a table border.
  const gridVerticals = vs.filter((v) => hs.filter((h) => crosses(h, v)).length >= 2);
  const gridHorizontals = hs.filter((h) => gridVerticals.filter((v) => crosses(h, v)).length >= 2);
  const lines = [...gridHorizontals, ...gridVerticals.filter((v) => gridHorizontals.filter((h) => crosses(h, v)).length >= 2)];
  for (const line of lines) for (let y = line.top; y < line.top + line.height; y++) {
    for (let x = line.left; x < line.left + line.width; x++) {
      const index = (y * width + x) * 4;
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
    }
  }
  return lines;
}

export function findTextRows(pixels: Uint8ClampedArray, width: number, height: number): ImageRegion[] {
  const bands: { top: number; bottom: number; left: number; right: number }[] = [];
  const mergeGap = Math.max(3, Math.round(height / 700));
  const projection: { count: number; left: number; right: number }[] = [];
  for (let y = 0; y < height; y++) {
    let count = 0, left = width, right = 0;
    for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4] < 160) {
      count++; left = Math.min(left, x); right = x + 1;
    }
    projection.push({ count, left, right });
  }
  const nonempty = projection.map((row) => row.count).filter(Boolean).sort((a, b) => a - b);
  const minimumInk = Math.max(3, Math.round((nonempty[Math.floor(nonempty.length * 0.85)] ?? 0) * 0.04));
  for (let y = 0; y < height; y++) {
    const { count, left, right } = projection[y];
    if (count < minimumInk) continue;
    const band = bands.at(-1);
    if (band && y - band.bottom <= mergeGap) {
      band.bottom = y + 1; band.left = Math.min(band.left, left); band.right = Math.max(band.right, right);
    } else bands.push({ top: y, bottom: y + 1, left, right });
  }
  const text = bands.filter((band) => band.bottom - band.top >= 4 && band.right - band.left >= 12 &&
    !(band.bottom - band.top < 8 && band.right - band.left > width * 0.6));
  const heights = text.map((band) => band.bottom - band.top).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  for (let index = 0; index < text.length; index++) {
    const band = text[index];
    if (band.bottom - band.top >= typicalHeight * 0.45) continue;
    const previous = text[index - 1], next = text[index + 1];
    const previousGap = previous ? band.top - previous.bottom : Infinity;
    const nextGap = next ? next.top - band.bottom : Infinity;
    const target = previousGap <= nextGap ? previous : next;
    if (!target || Math.min(previousGap, nextGap) > typicalHeight * 0.35 || band.right < target.left || band.left > target.right) continue;
    // Detached Khmer subscripts/accents belong to the nearest text row, not
    // their own OCR job. Keep the row core threshold high enough to split
    // dense lines while explicitly reattaching these small bands.
    target.top = Math.min(target.top, band.top); target.bottom = Math.max(target.bottom, band.bottom);
    target.left = Math.min(target.left, band.left); target.right = Math.max(target.right, band.right);
    text.splice(index, 1); index--;
  }
  return text.map((band, index) => {
    const padding = Math.max(10, Math.round((band.bottom - band.top) * 0.35));
    const previous = text[index - 1], next = text[index + 1];
    const top = Math.max(0, band.top - padding, previous ? Math.ceil((previous.bottom + band.top) / 2) : 0);
    const bottom = Math.min(height, band.bottom + padding, next ? Math.floor((band.bottom + next.top) / 2) : height);
    // Include faint marks outside the thresholded core without crossing into
    // neighboring text rows. The core threshold is only for finding row gaps.
    let left = band.left, right = band.right;
    for (let y = top; y < bottom; y++) {
      left = Math.min(left, projection[y].left); right = Math.max(right, projection[y].right);
    }
    left = Math.max(0, left - padding);
    return { left, top, width: Math.min(width, right + padding) - left, height: bottom - top };
  });
}
