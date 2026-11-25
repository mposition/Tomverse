export type StickerRect = { left: number; top: number; width: number; height: number };

function alphaCounts(data: Uint8ClampedArray, width: number, height: number) {
  const columns = new Uint32Array(width);
  const rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= 128) {
        columns[x]++;
        rows[y]++;
      }
    }
  }
  return { columns, rows };
}

function transparentSeams(occupancy: Uint32Array, divisions: number) {
  const pitch = occupancy.length / divisions;
  const seams = [0];
  for (let i = 1; i < divisions; i++) {
    const center = Math.round(i * pitch);
    const radius = Math.floor(pitch * .24);
    let best = center;
    for (let position = center - radius; position <= center + radius; position++) {
      const inkAtSeam = occupancy[position - 1] + occupancy[position];
      const bestInk = occupancy[best - 1] + occupancy[best];
      if (inkAtSeam < bestInk || (inkAtSeam === bestInk && Math.abs(position - center) < Math.abs(best - center))) {
        best = position;
      }
    }
    seams.push(best);
  }
  return [...seams, occupancy.length];
}

export function studioStickerCells(
  data: Uint8ClampedArray, width: number, height: number, columns: number, rows: number,
): StickerRect[] {
  const counts = alphaCounts(data, width, height);
  const xs = transparentSeams(counts.columns, columns);
  const ys = transparentSeams(counts.rows, rows);
  return Array.from({ length: columns * rows }, (_, index) => {
    const x = index % columns;
    const y = Math.floor(index / columns);
    return { left: xs[x], top: ys[y], width: xs[x + 1] - xs[x], height: ys[y + 1] - ys[y] };
  });
}

export function studioStickerCrossesSeam(
  data: Uint8ClampedArray, width: number, height: number, cell: StickerRect,
): boolean {
  const opaque = (x: number, y: number) => data[(y * width + x) * 4 + 3] >= 128;
  const crosses = (length: number, touches: (offset: number) => boolean) => {
    let solid = 0;
    for (let offset = 0; offset < length; offset++) if (touches(offset)) solid++;
    return solid > length * .15;
  };
  const right = cell.left + cell.width;
  const bottom = cell.top + cell.height;
  return (cell.left > 0 && crosses(cell.height, i => opaque(cell.left - 1, cell.top + i) && opaque(cell.left, cell.top + i)))
    || (right < width && crosses(cell.height, i => opaque(right - 1, cell.top + i) && opaque(right, cell.top + i)))
    || (cell.top > 0 && crosses(cell.width, i => opaque(cell.left + i, cell.top - 1) && opaque(cell.left + i, cell.top)))
    || (bottom < height && crosses(cell.width, i => opaque(cell.left + i, bottom - 1) && opaque(cell.left + i, bottom)));
}

export function studioStickerBounds(data: Uint8ClampedArray, width: number, height: number): StickerRect | null {
  const { columns, rows } = alphaCounts(data, width, height);
  const isOccupied = (oppositeLength: number) => (count: number) => count >= Math.max(2, Math.round(oppositeLength * .025));
  const left = columns.findIndex(isOccupied(height));
  const right = columns.findLastIndex(isOccupied(height));
  const top = rows.findIndex(isOccupied(width));
  const bottom = rows.findLastIndex(isOccupied(width));
  if (left === -1 || top === -1) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

export function studioStickerCaptionSlot(
  data: Uint8ClampedArray, stride: number, art: StickerRect, bandHeight: number,
): StickerRect | null {
  const start = art.top + Math.ceil(art.height * .58);
  const end = art.top + art.height - bandHeight;
  const step = Math.max(1, Math.floor(art.height * .035));
  const center = art.left + art.width / 2;
  const preferredY = art.top + art.height * .76;
  const minWidth = art.width * .27;
  let best: StickerRect | null = null;
  let bestScore = -Infinity;
  for (let top = start; top <= end; top += step) {
    let runStart = art.left;
    const right = art.left + art.width;
    for (let x = art.left; x <= right; x++) {
      let opaque = x < right;
      for (let y = top; opaque && y < top + bandHeight; y++) {
        opaque = data[(y * stride + x) * 4 + 3] >= 192;
      }
      if (opaque) continue;
      const width = x - runStart;
      if (width >= minWidth) {
        const score = width - Math.abs(runStart + width / 2 - center) * .45
          - Math.abs(top + bandHeight / 2 - preferredY) * .3;
        if (score > bestScore) {
          best = { left: runStart, top, width, height: bandHeight };
          bestScore = score;
        }
      }
      runStart = x + 1;
    }
  }
  return best;
}

export function studioStickerCaptionOutside(
  data: Uint8ClampedArray, stride: number, art: StickerRect, width: number, height: number,
): StickerRect {
  const gap = Math.min(art.width, art.height) * .023;
  const artArea = art.width * art.height;
  let best = { left: art.left, top: art.top - height - gap, width, height };
  let bestScore = Infinity;

  for (const vertical of [true, false]) {
    const crossStart = vertical ? art.left : art.top;
    const crossSize = vertical ? art.width : art.height;
    const crossSpan = vertical ? width : height;
    const depthStart = vertical ? art.top : art.left;
    const depthSize = vertical ? art.height : art.width;
    const captionDepth = vertical ? height : width;
    for (const anchor of [.5, .27, .73]) {
      const center = crossStart + crossSize * anchor;
      const cross = Math.round(center - crossSpan / 2);
      const start = Math.max(crossStart, Math.floor(cross - gap));
      const end = Math.min(crossStart + crossSize, Math.ceil(cross + crossSpan + gap));
      for (const direction of [1, -1]) {
        const edge = direction === 1 ? depthStart : depthStart + depthSize - 1;
        let depth = edge;
        while (Math.abs(depth - edge) < depthSize) {
          let occupied = false;
          for (let i = start; i < end && !occupied; i++) {
            const pixel = vertical ? depth * stride + i : i * stride + depth;
            occupied = data[pixel * 4 + 3] >= 64;
          }
          if (occupied) break;
          depth += direction;
        }
        if (Math.abs(depth - edge) >= depthSize) continue;
        const beside = direction === 1 ? depth - captionDepth - gap : depth + 1 + gap;
        const left = vertical ? cross : beside;
        const top = vertical ? beside : cross;
        const combinedWidth = Math.max(art.left + art.width, left + width) - Math.min(art.left, left);
        const combinedHeight = Math.max(art.top + art.height, top + height) - Math.min(art.top, top);
        const score = combinedWidth * combinedHeight / artArea + Math.abs(anchor - .5) * .17;
        if (score < bestScore) {
          best = { left, top, width, height };
          bestScore = score;
        }
      }
    }
  }
  return best;
}
