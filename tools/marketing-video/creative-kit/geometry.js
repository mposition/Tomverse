// The creative kit's geometry: plain functions, shared by the kit (bundled into
// the film) and the job's tests. A capture's "ink grid" says, per 8x8 source
// pixel cell, whether the picture changes there across a row (a horizontal
// edge: the top or bottom of a glyph or a rule) or across a column (a vertical
// edge: the side of a glyph or a border). A crop edge may sit only where its
// line of cells is blank, so no word is ever cut in half.

/** Source pixels per grid cell, both ways. */
export const CELL = 8;
/** The film's frame and the part of it every word must stay in (the apps' buttons sit outside it). */
export const FRAME = Object.freeze({ width: 1080, height: 1920 });
export const SAFE = Object.freeze({ left: 90, right: 90, top: 220, bottom: 300 });
/**
 * A real screen is drawn at 80% of its pixels or more: captures are 2x, so
 * 16 px body text stays 26 px or more in the film and reads on a phone. A crop
 * is then at most 1125 px wide at the safe width: one answer column, one card,
 * or a narrow capture (fresh-review.mjs records the analysis narrow too).
 */
export const MIN_SCALE = 0.8;
/** How far (source px) an edge may move to find a gap. */
const REACH = 96;

/** Decodes the grid written by creative-layout.mjs: two bits per cell, row-major. */
export function readGrid(entry) {
  const bytes = typeof atob === "function" ? Uint8Array.from(atob(entry.bits), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(entry.bits, "base64"));
  const at = (col, row) => {
    const bit = (row * entry.cols + col) * 2;
    return (bytes[bit >> 3] >> (bit & 7)) & 3;
  };
  return {
    width: entry.width,
    height: entry.height,
    cols: entry.cols,
    rows: entry.rows,
    /** 1: a horizontal edge in the cell, 2: a vertical one, 3: both. */
    at,
  };
}

const clampCell = (value, count) => Math.max(0, Math.min(count - 1, value));

/** A row of cells is blank between two columns: nothing ends or starts there, borders aside. */
function rowBlank(grid, row, col0, col1) {
  let vertical = 0;
  for (let col = col0; col <= col1; col += 1) {
    const cell = grid.at(col, row);
    if (cell & 1) return false;
    if (cell & 2) vertical += 1;
  }
  // A card's side border crosses every row: a few lone vertical edges are allowed, a line of text is not.
  return vertical <= 3;
}

function colBlank(grid, col, row0, row1) {
  let horizontal = 0;
  for (let row = row0; row <= row1; row += 1) {
    const cell = grid.at(col, row);
    if (cell & 2) return false;
    if (cell & 1) horizontal += 1;
  }
  return horizontal <= 3;
}

/** The blank line of cells nearest to `cell` within reach, or null. */
function nearest(isBlank, cell, count) {
  const reach = Math.ceil(REACH / CELL);
  for (let step = 0; step <= reach; step += 1) {
    for (const candidate of step === 0 ? [cell] : [cell - step, cell + step]) {
      if (candidate >= 0 && candidate < count && isBlank(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The crop moved to the nearest gaps, so it cuts no word: top and bottom in a
 * blank row across its width, left and right in a blank column down its
 * height. Throws, naming the edge, when no gap is within reach.
 * @param crop {{x: number, y: number, w: number, h: number}} source pixels
 */
export function snapCrop(grid, crop, name = "the screen") {
  const within = crop.x >= 0 && crop.y >= 0 && crop.w > 0 && crop.h > 0 && crop.x + crop.w <= grid.width && crop.y + crop.h <= grid.height;
  if (!within) throw new Error(`Screen "${name}": crop ${JSON.stringify(crop)} is not inside the ${grid.width}x${grid.height} capture`);
  const col0 = clampCell(Math.floor(crop.x / CELL), grid.cols);
  const col1 = clampCell(Math.floor((crop.x + crop.w - 1) / CELL), grid.cols);
  const top = nearest((row) => rowBlank(grid, row, col0, col1), clampCell(Math.round(crop.y / CELL), grid.rows), grid.rows);
  const bottom = nearest((row) => rowBlank(grid, row, col0, col1), clampCell(Math.round((crop.y + crop.h) / CELL) - 1, grid.rows), grid.rows);
  if (top === null) throw new Error(`Screen "${name}": the top edge (y ${crop.y}) cuts through words and there is no gap between lines within ${REACH} px; move it`);
  if (bottom === null) throw new Error(`Screen "${name}": the bottom edge (y ${crop.y + crop.h}) cuts through words and there is no gap between lines within ${REACH} px; move it`);
  const y = top * CELL;
  const y1 = (bottom + 1) * CELL;
  if (y1 - y < 4 * CELL) throw new Error(`Screen "${name}": after moving its edges to the gaps between lines, the crop is empty; make it taller`);
  const row0 = Math.floor(y / CELL);
  const row1 = bottom;
  const left = nearest((col) => colBlank(grid, col, row0, row1), clampCell(Math.round(crop.x / CELL), grid.cols), grid.cols);
  const right = nearest((col) => colBlank(grid, col, row0, row1), clampCell(Math.round((crop.x + crop.w) / CELL) - 1, grid.cols), grid.cols);
  if (left === null) throw new Error(`Screen "${name}": the left edge (x ${crop.x}) cuts through words and there is no clear column within ${REACH} px; move it`);
  if (right === null) throw new Error(`Screen "${name}": the right edge (x ${crop.x + crop.w}) cuts through words and there is no clear column within ${REACH} px; move it`);
  const x = left * CELL;
  const x1 = Math.min(grid.width, (right + 1) * CELL);
  return { x, y, w: x1 - x, h: Math.min(grid.height, y1) - y };
}

/**
 * The capture's blocks of words, for the film's builder to crop from: the
 * picture cut along blank gutters (rows at least 48 px, columns at least 32 px
 * clear), again and again, into the smallest pieces that hold words, each
 * trimmed to its words plus a margin. A block, or several neighbours together,
 * is a crop Screen takes as it is. Source pixels, top to bottom, left to right.
 */
export function blocksOf(grid, { rowGap = 6, colGap = 4, margin = 2 } = {}) {
  // The same blank lines Screen's crop edges may sit on: a panel's border may cross them.
  const blankRow = (row, c0, c1) => rowBlank(grid, row, c0, c1);
  const blankCol = (col, r0, r1) => colBlank(grid, col, r0, r1);
  const blocks = [];
  const cut = (c0, r0, c1, r1, depth) => {
    // Trim blank margins.
    while (r0 <= r1 && blankRow(r0, c0, c1)) r0 += 1;
    while (r1 >= r0 && blankRow(r1, c0, c1)) r1 -= 1;
    while (c0 <= c1 && blankCol(c0, r0, r1)) c0 += 1;
    while (c1 >= c0 && blankCol(c1, r0, r1)) c1 -= 1;
    if (r0 > r1 || c0 > c1) return;
    const split = (blank, from, to, gap) => {
      for (let start = from; start <= to; start += 1) {
        if (!blank(start)) continue;
        let end = start;
        while (end + 1 <= to && blank(end + 1)) end += 1;
        if (end - start + 1 >= gap) return [start, end];
        start = end;
      }
      return null;
    };
    if (depth < 12) {
      const rows = split((row) => blankRow(row, c0, c1), r0, r1, rowGap);
      if (rows) {
        cut(c0, r0, c1, rows[0] - 1, depth + 1);
        cut(c0, rows[1] + 1, c1, r1, depth + 1);
        return;
      }
      const cols = split((col) => blankCol(col, r0, r1), c0, c1, colGap);
      if (cols) {
        cut(c0, r0, cols[0] - 1, r1, depth + 1);
        cut(cols[1] + 1, r0, c1, r1, depth + 1);
        return;
      }
    }
    // Too small to hold a line of words: an icon, a dot, a rule.
    if (c1 - c0 + 1 < 6 || r1 - r0 + 1 < 3) return;
    const x = Math.max(0, (c0 - margin) * CELL);
    const y = Math.max(0, (r0 - margin) * CELL);
    blocks.push({ x, y, w: Math.min(grid.width, (c1 + 1 + margin) * CELL) - x, h: Math.min(grid.height, (r1 + 1 + margin) * CELL) - y });
  };
  cut(0, 0, grid.cols - 1, grid.rows - 1, 0);
  return blocks;
}

/** The scale a crop is drawn at to fill `width` film px; refused below MIN_SCALE. */
export function screenScale(crop, width, name = "the screen") {
  const scale = width / crop.w;
  if (scale < MIN_SCALE) {
    throw new Error(`Screen "${name}": its crop, with its edges moved into the gaps between words, is x ${crop.x}-${crop.x + crop.w} (${crop.w} px wide); drawn ${width} px wide its text shrinks to ${Math.round(scale * 100)}%. Draw it at least ${Math.ceil(crop.w * MIN_SCALE)} px wide, or crop a narrower part whose sides are clear of words`);
  }
  return scale;
}

/** The widest a stacked element may be. */
export const SAFE_WIDTH = FRAME.width - SAFE.left - SAFE.right;
export const SAFE_HEIGHT = FRAME.height - SAFE.top - SAFE.bottom;

/**
 * When each narration line plays, in frames: the first after a short lead-in,
 * each next one after the one before plus a breath.
 */
export function lineTimes(lines, fps, { lead = 0.2, breath = 0.25 } = {}) {
  let at = lead;
  return lines.map((line) => {
    const from = Math.round(at * fps);
    const frames = Math.max(1, Math.round(Number(line.seconds) * fps));
    at += Number(line.seconds) + breath;
    return { from, frames };
  });
}

/**
 * A caption's unbreakable pieces, in order: a line may break only between two
 * of them. Space-separated languages break at spaces only (never inside
 * "week-by-week"); Chinese between its words (Intl.Segmenter), never inside
 * 哪裡, with punctuation kept on the word before it. Spaces come back as " ".
 */
export function captionUnits(text, locale) {
  if (!locale.startsWith("zh")) return text.split(/( +)/u).filter((part) => part.length > 0).map((part) => (part.trim() ? part : " "));
  const units = [];
  for (const { segment, isWordLike } of new Intl.Segmenter(locale, { granularity: "word" }).segment(text)) {
    if (!segment.trim()) units.push(" ");
    else if (!isWordLike && units.length > 0 && units.at(-1) !== " ") units[units.length - 1] += segment;
    else units.push(segment);
  }
  return units;
}

/** The exact `screen` entry a caption shows, or throws: the film shows only the plan's words. */
export function screenWord(screen, text) {
  const wanted = String(text).trim();
  if (!screen.some((entry) => String(entry).trim() === wanted)) {
    throw new Error(`Caption "${wanted.slice(0, 60)}" is not one of the props' screen lines; show only those, exactly as written`);
  }
  return wanted;
}
