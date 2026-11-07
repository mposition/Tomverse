/**
 * The live office floor (version 2, operator approval 2026-11-07): an open
 * AMUX office with one desk island per CLI channel, a lounge, sleep pods and a
 * bench, beside the team rooms, the review room, the Decision Maker room and
 * the operator's office. Pure geometry and placement, in world pixels, so the
 * floor component and the tests share it.
 *
 * Where a worker is drawn is a function of its record only (`workerPlace`):
 * nothing walks unless a fresh reading moves a worker to another place.
 */

import type { AgentOfficeAmuxWorkerState } from "@/lib/agentOffice/live";

export const FLOOR_W = 1100;
export const FLOOR_H = 860;

/** A sprite is 32 x 44 world pixels; its desk sits 30 below its top. */
export const SPRITE_W = 32;
export const SPRITE_H = 44;

export type FloorPt = { x: number; y: number };
export type FloorRect = { x: number; y: number; w: number; h: number };

/** The CLI channels the AMUX office has an island for. */
export const AGENT_OFFICE_CHANNELS = ["claude", "codex", "copilot", "cursor"] as const;
export type AgentOfficeChannel = (typeof AGENT_OFFICE_CHANNELS)[number];

/**
 * A worker's channel from its provider label (lib/agentOfficeAmuxState.ts
 * labels provider classes as the display roster does). A provider with no
 * island is null: it is listed in the roster and counted on the floor.
 */
export function agentOfficeChannel(provider: string): AgentOfficeChannel | null {
  switch (provider) {
    case "anthropic":
    case "claude":
      return "claude";
    case "openai":
    case "codex":
      return "codex";
    case "github-copilot":
    case "copilot":
      return "copilot";
    case "cursor":
      return "cursor";
    default:
      return null;
  }
}

// ── Rooms ────────────────────────────────────────────────────
export const TEAM_ROOM_W = 140;
export const TEAM_ROOM_H = 124;

/** The ten team rooms: two rows of five, in the given order. */
export function teamRoomRect(index: number): FloorRect {
  return {
    x: 12 + (index % 5) * (TEAM_ROOM_W + 8),
    y: 36 + Math.floor(index / 5) * (TEAM_ROOM_H + 8),
    w: TEAM_ROOM_W,
    h: TEAM_ROOM_H,
  };
}
/** Where a team room's people sit (sprite top-left): three desks. */
export const TEAM_ROOM_DESKS = 3;
export function teamRoomSeats(index: number): FloorPt[] {
  const r = teamRoomRect(index);
  return [0, 1, 2].map((i) => ({ x: r.x + 14 + i * 40, y: r.y + 58 }));
}

export const REVIEW_ROOM_RECT: FloorRect = { x: 756, y: 36, w: 332, h: TEAM_ROOM_H };
export const REVIEW_DESKS = 6;
export const reviewSeat = (i: number): FloorPt => ({ x: 768 + i * 52, y: 66 });

export const DECISION_ROOM_RECT: FloorRect = { x: 756, y: 168, w: 164, h: TEAM_ROOM_H };
export const DECISION_DESKS = 2;
export const decisionSeat = (i: number): FloorPt => ({ x: 772 + i * 74, y: 208 });

export const OPERATOR_ROOM_RECT: FloorRect = { x: 928, y: 168, w: 160, h: TEAM_ROOM_H };
export const OPERATOR_SEAT: FloorPt = { x: 992, y: 208 };

export const AMUX_ROOM_RECT: FloorRect = { x: 12, y: 300, w: 1076, h: 548 };

// ── Channel islands ─────────────────────────────────────────
export const ISLAND_W = 352;
export const ISLAND_H = 246;
export const ISLAND_ROWS = 3;
export const ISLAND_COLS = 8;
/** At most this many desks on an island; more workers are counted, not drawn. */
export const ISLAND_CAPACITY = ISLAND_ROWS * ISLAND_COLS;

export const ISLAND_ORIGIN: Readonly<Record<AgentOfficeChannel, FloorPt>> = {
  claude: { x: 20, y: 340 },
  codex: { x: 386, y: 340 },
  copilot: { x: 20, y: 596 },
  cursor: { x: 386, y: 596 },
};

export const islandRect = (channel: AgentOfficeChannel): FloorRect => ({
  ...ISLAND_ORIGIN[channel],
  w: ISLAND_W,
  h: ISLAND_H,
});

/** Desks on an island grow in fours with its workers, from eight up to its capacity. */
export function islandDeskCount(workers: number): number {
  return Math.min(ISLAND_CAPACITY, Math.max(8, Math.ceil(workers / 4) * 4));
}

/** Where the person at an island's desk `index` sits (sprite top-left). */
export function islandSeat(channel: AgentOfficeChannel, index: number): FloorPt {
  const o = ISLAND_ORIGIN[channel];
  const row = Math.floor(index / ISLAND_COLS);
  const col = index % ISLAND_COLS;
  return { x: o.x + 12 + col * 40 + (col >= 4 ? 14 : 0), y: o.y + 64 + row * 60 };
}

// ── Shared zones ────────────────────────────────────────────
export type ZoneId = "lounge" | "pod" | "bench";
type Zone = { x: number; y: number; cols: number; dx: number; dy: number; cap: number };
export const ZONES: Readonly<Record<ZoneId, Zone>> = {
  lounge: { x: 770, y: 384, cols: 6, dx: 50, dy: 54, cap: 18 },
  pod: { x: 772, y: 572, cols: 6, dx: 50, dy: 62, cap: 12 },
  bench: { x: 772, y: 764, cols: 6, dx: 50, dy: 0, cap: 6 },
};
export const zoneSeat = (zone: ZoneId, i: number): FloorPt => {
  const z = ZONES[zone];
  return { x: z.x + (i % z.cols) * z.dx, y: z.y + Math.floor(i / z.cols) * z.dy };
};

// ── Placement ───────────────────────────────────────────────
export type WorkerPlace = "desk" | "lounge" | "pod" | "bench" | "none";

/**
 * Where a worker's record puts it. A worker at work, or one whose work went
 * wrong, is at its desk; a worker free for work rests in the lounge, or in a
 * sleep pod while its quota is used up; one the operator held back sits on the
 * bench; one that is not running leaves its desk covered.
 */
export function workerPlace(state: AgentOfficeAmuxWorkerState, quotaExhausted: boolean): WorkerPlace {
  switch (state) {
    case "busy":
    case "error":
    case "lost":
      return "desk";
    case "ready":
    case "idle":
    case "starting":
      return quotaExhausted ? "pod" : "lounge";
    case "paused":
    case "isolated":
    case "blocked":
      return "bench";
    default:
      return "none";
  }
}

/** A worker that needs the operator's look: its work went wrong or its quota ran out. */
export function workerNeedsLook(state: AgentOfficeAmuxWorkerState, quotaExhausted: boolean): boolean {
  return state === "error" || state === "lost" || (quotaExhausted && state !== "busy" && workerPlace(state, true) === "pod");
}

export type FloorWorkerInput = {
  name: string;
  channel: AgentOfficeChannel | null;
  state: AgentOfficeAmuxWorkerState;
  quotaExhausted: boolean;
};

export type FloorWorkerSpot = {
  name: string;
  place: WorkerPlace;
  /** The desk this worker owns on its island, or null when the island is full or it has none. */
  desk: number | null;
  /** Where it is drawn now, or null when it is not drawn (counted instead). */
  at: FloorPt | null;
};

export type FloorLayout = {
  spots: FloorWorkerSpot[];
  /** Desks drawn per island. */
  desks: Record<AgentOfficeChannel, number>;
  /** Who sits at each island desk (null: an empty or covered desk). */
  deskOwner: Record<AgentOfficeChannel, (string | null)[]>;
  /** Workers counted but not drawn, so nobody disappears silently. */
  overflow: { lounge: number; pod: number; bench: number; island: Record<AgentOfficeChannel, number>; noChannel: number };
};

/**
 * Lays every worker out. Each worker keeps a desk on its channel's island in
 * record order (so it does not swap desks between readings); one past the
 * island's capacity, or with no island, is counted rather than drawn, and the
 * shared zones count whoever does not fit. A worker that needs a look is
 * seated before the rest, so a full lounge never hides it.
 */
export function agentOfficeFloorLayout(workers: readonly FloorWorkerInput[]): FloorLayout {
  const deskOf = new Map<string, number | null>();
  const perChannel: Record<AgentOfficeChannel, string[]> = { claude: [], codex: [], copilot: [], cursor: [] };
  for (const w of workers) if (w.channel) perChannel[w.channel].push(w.name);
  const desks = {} as Record<AgentOfficeChannel, number>;
  const deskOwner = {} as Record<AgentOfficeChannel, (string | null)[]>;
  const islandOverflow = { claude: 0, codex: 0, copilot: 0, cursor: 0 };
  for (const ch of AGENT_OFFICE_CHANNELS) {
    const names = perChannel[ch];
    desks[ch] = islandDeskCount(names.length);
    deskOwner[ch] = Array.from({ length: desks[ch] }, () => null);
    names.forEach((name, i) => {
      if (i < desks[ch]) deskOf.set(name, i);
      else {
        deskOf.set(name, null);
        islandOverflow[ch]++;
      }
    });
  }
  const used: Record<ZoneId, number> = { lounge: 0, pod: 0, bench: 0 };
  const overflow = { lounge: 0, pod: 0, bench: 0, island: islandOverflow, noChannel: 0 };
  const byName = new Map<string, FloorWorkerSpot>();
  const ordered = [...workers].sort(
    (a, b) => Number(workerNeedsLook(b.state, b.quotaExhausted)) - Number(workerNeedsLook(a.state, a.quotaExhausted))
  );
  for (const w of ordered) {
    const place = workerPlace(w.state, w.quotaExhausted);
    const desk = deskOf.get(w.name) ?? null;
    let at: FloorPt | null = null;
    if (!w.channel) {
      overflow.noChannel++;
    } else if (place === "desk" || place === "none") {
      if (desk !== null) {
        if (place === "desk") at = islandSeat(w.channel, desk);
        deskOwner[w.channel][desk] = place === "desk" ? w.name : null;
      }
    } else {
      if (desk !== null) deskOwner[w.channel][desk] = null;
      if (used[place] < ZONES[place].cap) at = zoneSeat(place, used[place]++);
      else overflow[place]++;
    }
    byName.set(w.name, { name: w.name, place, desk, at });
  }
  return { spots: workers.map((w) => byName.get(w.name)!), desks, deskOwner, overflow };
}

/**
 * The path a worker walks from one spot to another: down to the aisle under
 * where it stands, along it, and up to the new spot. Corridors only, so
 * nobody walks through a desk row.
 */
export function walkPath(from: FloorPt, to: FloorPt): FloorPt[] {
  const aisle = Math.min(FLOOR_H - 60, Math.max(from.y, to.y) + SPRITE_H + 2);
  return [
    { x: from.x, y: aisle },
    { x: to.x, y: aisle },
    { x: to.x, y: to.y },
  ];
}

// ── Light ───────────────────────────────────────────────────
export type FloorLight = "day" | "dawn" | "dusk" | "night";

/** The office's light at an hour on Brisbane's clock (0 to 24, fractional). */
export function floorLightAt(hour: number): FloorLight {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h < 17) return "day";
  if (h >= 17 && h < 19.5) return "dusk";
  if (h >= 5.5 && h < 7) return "dawn";
  return "night";
}

/** Brisbane's hour now (AEST, no daylight saving), as a fraction. */
export function brisbaneHour(at: number = Date.now()): number {
  const d = new Date(at + 10 * 3_600_000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
