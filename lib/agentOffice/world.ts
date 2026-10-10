// The Agent office's map, in tiles. Ported from the original AI OFFICE layout
// and its four-by-three grid: the operator's office, digest desk and Decision
// Maker room on top, and the eight teams below. Under them, the AMUX execution
// room spans three columns and the independent review room takes the fourth,
// with the entrance below it. Geometry only: room names come from the console
// catalog. Nobody walks, so there is no path grid: everyone sits at a desk.

import {
  AGENT_OFFICE_TEAM_IDS,
  agentOfficeDept,
  type AgentOfficeDeptId,
} from "@/lib/agentOffice/roster";

export const TILE = 18;
export const COLS = 74;
export const ROWS = 59;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

export type Pt = { x: number; y: number };
export type RoomKind = "dept" | "operator" | "decision" | "amux" | "review";
export type RoomId = AgentOfficeDeptId | "operator" | "decision" | "amux" | "review";

export type Desk = {
  /** Left tile of the desk top. */
  deskX: number;
  deskY: number;
  /** Where its person sits. */
  seat: Pt;
};

export type Room = {
  id: RoomId;
  /** File-name-like room code, the same in both console languages. */
  short: string;
  icon: string;
  kind: RoomKind;
  x: number;
  y: number;
  w: number;
  h: number;
  doors: Pt[];
  desks: Desk[];
};

/**
 * Four columns. The top row is the operator's office, the digest desk and the
 * Decision Maker room, with the fourth column left open; the two rows below are
 * the eight teams.
 */
const COL_X = [2, 20, 38, 56];
const ROW_Y = [17, 31];
const TOP_Y = 2;
const TOP_H = 12;
const ROOM_W = 15;
const DEPT_H = 11;

const DEPT_SHORT: Record<AgentOfficeDeptId, string> = {
  engineering: "eng.patch",
  qa: "qa.release",
  sre: "sre.watch",
  support: "support.triage",
  marketing: "mkt.studio",
  finance: "fin.ledger",
  trust: "trust.safety",
  research: "research.obs",
  digest: "digest.desk",
};

/**
 * A room with three desks. A top-row room opens onto the corridor below it,
 * a team room onto the corridor above it.
 */
function deskRoom(id: AgentOfficeDeptId, x: number, y: number, h: number, door: "top" | "bottom"): Room {
  const desks: Desk[] = [3, 7, 11].map((dx) => ({
    deskX: x + dx - 1,
    deskY: y + 5,
    seat: { x: x + dx, y: y + 6 },
  }));
  const doorY = door === "top" ? y : y + h - 1;
  return {
    id,
    short: DEPT_SHORT[id],
    icon: agentOfficeDept(id)?.icon ?? "",
    kind: "dept",
    x,
    y,
    w: ROOM_W,
    h,
    doors: [
      { x: x + 7, y: doorY },
      { x: x + 8, y: doorY },
    ],
    desks,
  };
}

/** A top-row room's two door tiles, in its bottom wall. */
const bottomDoors = (x: number): Pt[] => [
  { x: x + 7, y: TOP_Y + TOP_H - 1 },
  { x: x + 8, y: TOP_Y + TOP_H - 1 },
];

export const OPERATOR_ROOM: Room = {
  id: "operator",
  short: "operator.office",
  icon: "🎛️",
  kind: "operator",
  x: COL_X[0],
  y: TOP_Y,
  w: ROOM_W,
  h: TOP_H,
  doors: bottomDoors(COL_X[0]),
  desks: [{ deskX: 7, deskY: 6, seat: { x: 9, y: 5 } }],
};

export const DIGEST_ROOM: Room = deskRoom("digest", COL_X[1], TOP_Y, TOP_H, "bottom");

/**
 * The AMUX Decision Maker room: one desk for each instance, laid out like a
 * team room's. The instances are drawn seated with their real switch state.
 */
export const DECISION_ROOM: Room = {
  id: "decision",
  short: "dm.propose",
  icon: "⚖️",
  kind: "decision",
  x: COL_X[2],
  y: TOP_Y,
  w: ROOM_W,
  h: TOP_H,
  doors: bottomDoors(COL_X[2]),
  desks: [4, 10].map((dx) => ({
    deskX: COL_X[2] + dx - 1,
    deskY: TOP_Y + 5,
    seat: { x: COL_X[2] + dx, y: TOP_Y + 6 },
  })),
};

/**
 * The AMUX execution room: one desk for each AMUX worker, in a row. Workers
 * are drawn seated at their desks with their real state; nobody walks in or
 * out of this room, because nothing in it is the demo's.
 */
const AMUX_Y = 45;
const AMUX_H = 11;
const AMUX_W = COL_X[2] + ROOM_W - COL_X[0];

export const AMUX_ROOM: Room = {
  id: "amux",
  short: "amux.workers",
  icon: "🧩",
  kind: "amux",
  x: COL_X[0],
  y: AMUX_Y,
  w: AMUX_W,
  h: AMUX_H,
  doors: [
    { x: COL_X[0] + 25, y: AMUX_Y },
    { x: COL_X[0] + 26, y: AMUX_Y },
  ],
  desks: Array.from({ length: 12 }, (_, i) => {
    const dx = 3 + i * 4;
    return { deskX: COL_X[0] + dx - 1, deskY: AMUX_Y + 5, seat: { x: COL_X[0] + dx, y: AMUX_Y + 6 } };
  }),
};

/**
 * The independent review room: one desk for each reviewer the review server
 * reports, two rows of three. Its door is at the right of its top wall, so the
 * way in runs down the free column beside the desks.
 */
export const REVIEW_ROOM: Room = {
  id: "review",
  short: "review.orch",
  icon: "🔎",
  kind: "review",
  x: COL_X[3],
  y: AMUX_Y,
  w: ROOM_W,
  h: AMUX_H,
  doors: [
    { x: COL_X[3] + 12, y: AMUX_Y },
    { x: COL_X[3] + 13, y: AMUX_Y },
  ],
  desks: [0, 1].flatMap((row) =>
    [0, 1, 2].map((col) => {
      const deskX = COL_X[3] + 1 + col * 4;
      const deskY = AMUX_Y + 2 + row * 4;
      return { deskX, deskY, seat: { x: deskX + 1, y: deskY + 1 } };
    })
  ),
};

export const OPERATOR_SEAT: Pt = { x: 9, y: 5 };
/** The doormat drawn at the entrance, below the review room. */
export const ENTRANCE_MAT = { x: COL_X[3] + 5, y: ROWS - 3, w: 5, h: 2 };

const TEAM_ROOMS: Room[] = AGENT_OFFICE_TEAM_IDS.map((id, i) =>
  deskRoom(id, COL_X[i % 4], ROW_Y[Math.floor(i / 4)], DEPT_H, "top")
);

/** Every room with desks and staff: the eight teams, then the digest desk. */
export const DEPT_ROOMS: Room[] = [...TEAM_ROOMS, DIGEST_ROOM];
export const ROOMS: Room[] = [
  OPERATOR_ROOM,
  DIGEST_ROOM,
  DECISION_ROOM,
  ...TEAM_ROOMS,
  AMUX_ROOM,
  REVIEW_ROOM,
];

export type Prop = {
  kind:
    | "desk"
    | "plant"
    | "shelf"
    | "screen"
    | "operator-desk"
    | "rug"
    | "cabinet"
    | "whiteboard";
  x: number;
  y: number;
  w: number;
  h: number;
  /** A label the renderer looks up; not displayed as is. */
  label?: "screen";
};

/** Furniture, drawn on the floor. */
export const PROPS: Prop[] = [];

for (const room of DEPT_ROOMS) {
  for (const desk of room.desks) {
    PROPS.push({ kind: "desk", x: desk.deskX, y: desk.deskY, w: 3, h: 1 });
  }
  PROPS.push({ kind: "shelf", x: room.x + 1, y: room.y + 1, w: 3, h: 1 });
  PROPS.push({ kind: "plant", x: room.x + 13, y: room.y + 1, w: 1, h: 1 });
  PROPS.push({ kind: "cabinet", x: room.x + 12, y: room.y + 8, w: 2, h: 1 });
}

for (const desk of AMUX_ROOM.desks) {
  PROPS.push({ kind: "desk", x: desk.deskX, y: desk.deskY, w: 3, h: 1 });
}
PROPS.push({ kind: "shelf", x: AMUX_ROOM.x + 1, y: AMUX_ROOM.y + 1, w: 3, h: 1 });
PROPS.push({ kind: "plant", x: AMUX_ROOM.x + AMUX_ROOM.w - 2, y: AMUX_ROOM.y + 1, w: 1, h: 1 });
PROPS.push({ kind: "plant", x: AMUX_ROOM.x + 1, y: AMUX_ROOM.y + AMUX_ROOM.h - 2, w: 1, h: 1 });
for (const desk of REVIEW_ROOM.desks) {
  PROPS.push({ kind: "desk", x: desk.deskX, y: desk.deskY, w: 3, h: 1 });
}

PROPS.push({ kind: "operator-desk", x: 7, y: 6, w: 5, h: 2 });
PROPS.push({ kind: "rug", x: 6, y: 9, w: 7, h: 3 });
PROPS.push({ kind: "plant", x: 4, y: 4, w: 1, h: 1 });
PROPS.push({ kind: "plant", x: 14, y: 4, w: 1, h: 1 });

PROPS.push({ kind: "screen", x: DECISION_ROOM.x + 2, y: DECISION_ROOM.y + 1, w: 5, h: 1, label: "screen" });
PROPS.push({ kind: "whiteboard", x: DECISION_ROOM.x + 8, y: DECISION_ROOM.y + 1, w: 5, h: 1 });
PROPS.push({ kind: "plant", x: DECISION_ROOM.x + 1, y: DECISION_ROOM.y + DECISION_ROOM.h - 2, w: 1, h: 1 });
for (const desk of DECISION_ROOM.desks) {
  PROPS.push({ kind: "desk", x: desk.deskX, y: desk.deskY, w: 3, h: 1 });
}

export function roomOf(id: string): Room {
  const room = ROOMS.find((r) => r.id === id);
  if (!room) throw new Error(`unknown room: ${id}`);
  return room;
}
