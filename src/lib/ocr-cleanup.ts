// Remove ruled lines from a page before its rows are read: rules under page
// headers, underlined headings and boxes around headings. Otherwise each line
// is read as letters or punctuation, or joins its row to the text above. Text strokes must survive, so a pixel
// is only erased where the mark is thin and nothing else crosses it.
import type { ImageRegion } from './ocr-layout';

const INK = 160;

function inkMask(pixels: Uint8ClampedArray, width: number, height: number) {
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) if (pixels[i * 4] < INK) ink[i] = 1;
  return ink;
}

function whiten(pixels: Uint8ClampedArray, index: number) {
  pixels[index * 4] = pixels[index * 4 + 1] = pixels[index * 4 + 2] = 255;
}

// Long thin horizontal lines, with the vertical sides of boxes they close.
// Lines in a grid are handled by eraseTableRulings; this covers ruled page
// headers, underlined headings and boxed headings, which have no grid.
export function eraseRules(pixels: Uint8ClampedArray, width: number, height: number): ImageRegion[] {
  const ink = inkMask(pixels, width, height);
  const minLength = Math.max(80, Math.round(width * 0.08));
  const thickness = Math.max(4, Math.round(width / 150));
  // Long horizontal runs, chained row to row into (possibly tilted) lines.
  type Run = { y: number; left: number; right: number };
  const lines: { runs: Run[]; last: Run[] }[] = [];
  let open: typeof lines = [];
  for (let y = 0; y < height; y++) {
    const rowRuns: Run[] = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && ink[y * width + x]) { if (start < 0) start = x; }
      else if (start >= 0) { if (x - start >= minLength) rowRuns.push({ y, left: start, right: x }); start = -1; }
    }
    const next: typeof lines = [];
    for (const run of rowRuns) {
      const line = open.find((candidate) => candidate.last.some((other) =>
        Math.min(run.right, other.right) - Math.max(run.left, other.left) >= Math.min(run.right - run.left, other.right - other.left) * 0.5));
      if (line) { line.runs.push(run); if (!next.includes(line)) { line.last = []; next.push(line); } line.last.push(run); }
      else { const created = { runs: [run], last: [run] }; lines.push(created); next.push(created); }
    }
    open = next;
  }
  // Clear one column of a line. rows are the line's own rows there.
  function eraseColumn(x: number, lineTop: number, lineBottom: number) {
    let up = -1, down = -1;
    for (let y = lineTop; y <= lineBottom; y++) if (ink[y * width + x]) { if (up < 0) up = y; down = y; }
    if (up < 0) return;
    // The full vertical ink run through the line at this column.
    while (up > 0 && ink[(up - 1) * width + x]) up--;
    while (down < height - 1 && ink[(down + 1) * width + x]) down++;
    const extendsUp = up < lineTop - 1, extendsDown = down > lineBottom + 1;
    const tall = down - up + 1 > thickness * 2;
    // A stroke crossing the line keeps its pixels. A letter resting on the
    // line keeps its own part; only the line's rows are cleared there.
    if (extendsUp && extendsDown && tall) return;
    const from = extendsUp && tall ? lineTop : up;
    const to = extendsDown && tall ? lineBottom : down;
    for (let y = from; y <= to; y++) { whiten(pixels, y * width + x); ink[y * width + x] = 0; }
    // The scanned line's soft edge is lighter than the ink threshold but a
    // darker reading variant would restore it. Leave neighbouring ink alone.
    for (let step = 1; step <= 2; step++) for (const y of [from - step, to + step]) {
      if (y >= 0 && y < height && !ink[y * width + x]) whiten(pixels, y * width + x);
    }
  }
  const found: (ImageRegion & { bottomRow: number })[] = [];
  for (const { runs } of lines) {
    const left = Math.min(...runs.map((run) => run.left)), right = Math.max(...runs.map((run) => run.right));
    const top = Math.min(...runs.map((run) => run.y)), bottom = Math.max(...runs.map((run) => run.y)) + 1;
    const area = runs.reduce((sum, run) => sum + run.right - run.left, 0);
    if (area / (right - left) > thickness) continue; // A solid bar or block of text, not a rule.
    for (let x = left; x < right; x++) {
      const rows = runs.filter((run) => x >= run.left && x < run.right).map((run) => run.y);
      if (rows.length) eraseColumn(x, Math.min(...rows), Math.max(...rows));
    }
    found.push({ left, top, width: right - left, height: bottom - top, bottomRow: bottom - 1 });
  }
  // A scanned rule breaks into pieces where it fades or thickens. Clear the
  // short gaps between collinear pieces as well.
  found.sort((a, b) => a.left - b.left);
  for (const [i, a] of found.entries()) for (const b of found.slice(i + 1)) {
    const gap = b.left - (a.left + a.width);
    if (gap <= 0 || gap > minLength || Math.abs(a.top - b.top) > thickness || Math.abs(a.bottomRow - b.bottomRow) > thickness) continue;
    const lineTop = Math.min(a.top, b.top) - 1, lineBottom = Math.max(a.bottomRow, b.bottomRow) + 1;
    for (let x = a.left + a.width; x < b.left; x++) eraseColumn(x, Math.max(0, lineTop), Math.min(height - 1, lineBottom));
  }
  // Box sides: thin vertical runs joining two erased lines at their ends.
  const boxes: ImageRegion[] = [];
  for (const [i, upper] of found.entries()) for (const lower of found.slice(i + 1)) {
    const span = lower.top - (upper.top + upper.height);
    if (span < thickness * 3 || span > height * 0.2) continue;
    if (Math.abs(upper.left - lower.left) > thickness * 3 || Math.abs(upper.left + upper.width - lower.left - lower.width) > thickness * 3) continue;
    const left = Math.min(upper.left, lower.left), right = Math.max(upper.left + upper.width, lower.left + lower.width);
    let erased = false;
    for (const edge of [left, right - 1]) {
      for (let x = Math.max(0, edge - thickness * 2); x <= Math.min(width - 1, edge + thickness * 2); x++) {
        let covered = 0;
        for (let y = upper.top; y < lower.top + lower.height; y++) covered += ink[y * width + x];
        if (covered < span * 0.85) continue;
        erased = true;
        for (let y = Math.max(0, upper.top - thickness); y < Math.min(height, lower.top + lower.height + thickness); y++) {
          if (!ink[y * width + x]) continue;
          // Keep pixels that belong to a wider horizontal stroke (a glyph
          // touching the box side), not to the thin side itself.
          let runLeft = x, runRight = x;
          while (runLeft > 0 && ink[y * width + runLeft - 1]) runLeft--;
          while (runRight < width - 1 && ink[y * width + runRight + 1]) runRight++;
          if (runRight - runLeft + 1 > thickness * 2) continue;
          for (let xx = runLeft; xx <= runRight; xx++) { whiten(pixels, y * width + xx); ink[y * width + xx] = 0; }
          for (const xx of [runLeft - 1, runRight + 1]) if (xx >= 0 && xx < width && pixels[(y * width + xx) * 4] >= INK) whiten(pixels, y * width + xx);
        }
      }
    }
    if (erased) boxes.push({ left, top: upper.top, width: right - left, height: lower.top + lower.height - upper.top });
  }
  return [...found.map(({ left, top, width, height }) => ({ left, top, width, height })), ...boxes];
}
