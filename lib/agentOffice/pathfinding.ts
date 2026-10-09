// A* path search (four directions) over the Agent office's tile grid.
// Ported unchanged from the original AI OFFICE engine.
import { COLS, ROWS, walkable, type Pt } from "@/lib/agentOffice/world";

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** A sorted-insert queue; on a map this small it is fast enough without a binary heap. */
class Queue {
  private items: { idx: number; f: number }[] = [];

  push(idx: number, f: number) {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].f > f) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, { idx, f });
  }

  pop(): number | undefined {
    return this.items.pop()?.idx;
  }

  get size() {
    return this.items.length;
  }
}

/**
 * The shortest path from `from` to `to`, excluding the start tile. When the
 * destination is blocked the nearest walkable tile next to it is used instead.
 */
export function findPath(from: Pt, to: Pt, blocked?: Set<number>): Pt[] {
  const start = idx(from.x, from.y);
  let goal = idx(to.x, to.y);

  if (!walkable(to.x, to.y)) {
    const alt = nearestWalkable(to);
    if (!alt) return [];
    goal = idx(alt.x, alt.y);
  }
  if (start === goal) return [];

  const came = new Int32Array(COLS * ROWS).fill(-1);
  const gScore = new Float32Array(COLS * ROWS).fill(Infinity);
  const closed = new Uint8Array(COLS * ROWS);
  const open = new Queue();

  gScore[start] = 0;
  open.push(start, heuristic(start, goal));

  while (open.size) {
    const current = open.pop()!;
    if (current === goal) return rebuild(came, current, start);
    if (closed[current]) continue;
    closed[current] = 1;

    const cx = current % COLS;
    const cy = (current / COLS) | 0;

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const next = idx(nx, ny);
      if (closed[next]) continue;
      // A tile someone is standing on costs more, so agents walk round each other.
      const cost = blocked?.has(next) && next !== goal ? 6 : 1;
      const tentative = gScore[current] + cost;
      if (tentative >= gScore[next]) continue;
      came[next] = current;
      gScore[next] = tentative;
      open.push(next, tentative + heuristic(next, goal));
    }
  }
  return [];
}

function idx(x: number, y: number) {
  return y * COLS + x;
}

function heuristic(a: number, b: number) {
  const ax = a % COLS;
  const ay = (a / COLS) | 0;
  const bx = b % COLS;
  const by = (b / COLS) | 0;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function rebuild(came: Int32Array, goal: number, start: number): Pt[] {
  const path: Pt[] = [];
  let cursor = goal;
  while (cursor !== start && cursor !== -1) {
    path.push({ x: cursor % COLS, y: (cursor / COLS) | 0 });
    cursor = came[cursor];
  }
  return path.reverse();
}

function nearestWalkable(target: Pt): Pt | null {
  for (let r = 1; r <= 4; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = target.x + dx;
        const y = target.y + dy;
        if (walkable(x, y)) return { x, y };
      }
    }
  }
  return null;
}
