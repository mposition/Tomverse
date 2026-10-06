// The Agent office's map: a tile grid, 0 = walkable and 1 = wall or furniture.
// Ported from the original AI OFFICE layout, with the department block cut
// from four columns by three rows to four by two (seven teams and the digest
// desk). Geometry only: room names come from the console catalog.

import { AGENT_OFFICE_DEPTS, type AgentOfficeDeptId } from "@/lib/agentOffice/roster";

export const TILE = 18;
export const COLS = 74;
export const ROWS = 46;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

export type Pt = { x: number; y: number };
export type RoomKind = "dept" | "operator" | "meeting" | "lounge";
export type RoomId = AgentOfficeDeptId | "operator" | "meeting" | "lounge";

export type Desk = {
  /** Left tile of the desk top. */
  deskX: number;
  deskY: number;
  /** Where the agent sits: the path's destination. */
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
  /** Spots an agent may wander to inside the room. */
  loiter: Pt[];
};

/** Department rooms -- four columns, two rows. */
const COL_X = [2, 20, 38, 56];
const ROW_Y = [17, 31];
const DEPT_W = 15;
const DEPT_H = 11;

const DEPT_SHORT: Record<AgentOfficeDeptId, string> = {
  engineering: "eng.patch",
  qa: "qa.release",
  sre: "sre.watch",
  support: "support.triage",
  marketing: "mkt.studio",
  finance: "fin.ledger",
  research: "research.obs",
  digest: "digest.desk",
};

function deptRoom(index: number): Room {
  const meta = AGENT_OFFICE_DEPTS[index];
  const x = COL_X[index % 4];
  const y = ROW_Y[Math.floor(index / 4)];
  const desks: Desk[] = [3, 7, 11].map((dx) => ({
    deskX: x + dx - 1,
    deskY: y + 5,
    seat: { x: x + dx, y: y + 6 },
  }));
  return {
    id: meta.id,
    short: DEPT_SHORT[meta.id],
    icon: meta.icon,
    kind: "dept",
    x,
    y,
    w: DEPT_W,
    h: DEPT_H,
    doors: [
      { x: x + 7, y },
      { x: x + 8, y },
    ],
    desks,
    loiter: [
      { x: x + 1, y: y + 8 },
      { x: x + 5, y: y + 8 },
      { x: x + 9, y: y + 8 },
      { x: x + 13, y: y + 3 },
    ],
  };
}

export const OPERATOR_ROOM: Room = {
  id: "operator",
  short: "operator.office",
  icon: "🎛️",
  kind: "operator",
  x: 2,
  y: 2,
  w: 18,
  h: 12,
  doors: [
    { x: 10, y: 13 },
    { x: 11, y: 13 },
  ],
  desks: [{ deskX: 9, deskY: 6, seat: { x: 11, y: 5 } }],
  loiter: [
    { x: 8, y: 10 },
    { x: 11, y: 10 },
    { x: 14, y: 10 },
    { x: 6, y: 8 },
  ],
};

export const MEETING_ROOM: Room = {
  id: "meeting",
  short: "approval.room",
  icon: "💬",
  kind: "meeting",
  x: 23,
  y: 2,
  w: 26,
  h: 12,
  doors: [
    { x: 35, y: 13 },
    { x: 36, y: 13 },
  ],
  desks: [],
  loiter: [
    { x: 26, y: 10 },
    { x: 45, y: 10 },
  ],
};

export const LOUNGE_ROOM: Room = {
  id: "lounge",
  short: "lounge.chill",
  icon: "☕",
  kind: "lounge",
  x: 52,
  y: 2,
  w: 20,
  h: 12,
  doors: [
    { x: 61, y: 13 },
    { x: 62, y: 13 },
  ],
  desks: [],
  loiter: [
    { x: 56, y: 7 },
    { x: 58, y: 7 },
    { x: 60, y: 7 },
    { x: 63, y: 10 },
    { x: 66, y: 6 },
    { x: 69, y: 8 },
  ],
};

/** Eight meeting seats, above and below the table. */
export const MEETING_SEATS: Pt[] = [
  { x: 31, y: 5 },
  { x: 34, y: 5 },
  { x: 37, y: 5 },
  { x: 40, y: 5 },
  { x: 31, y: 9 },
  { x: 34, y: 9 },
  { x: 37, y: 9 },
  { x: 40, y: 9 },
];

/** Where a report is delivered, in front of the operator's desk. */
export const OPERATOR_REPORT_SPOT: Pt = { x: 11, y: 9 };
export const OPERATOR_SEAT: Pt = { x: 11, y: 5 };
/** The way in and out. */
export const ENTRANCE: Pt = { x: 36, y: ROWS - 1 };
/** The doormat drawn in front of the entrance. */
export const ENTRANCE_MAT = { x: 34, y: ROWS - 3, w: 5, h: 2 };

export const DEPT_ROOMS: Room[] = AGENT_OFFICE_DEPTS.map((_, i) => deptRoom(i));
export const ROOMS: Room[] = [OPERATOR_ROOM, MEETING_ROOM, LOUNGE_ROOM, ...DEPT_ROOMS];

export type Prop = {
  kind:
    | "desk"
    | "table"
    | "sofa"
    | "coffee"
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
  label?: "screen" | "coffee";
};

/** Furniture, drawn and used for collision alike. */
export const PROPS: Prop[] = [];

for (const room of DEPT_ROOMS) {
  for (const desk of room.desks) {
    PROPS.push({ kind: "desk", x: desk.deskX, y: desk.deskY, w: 3, h: 1 });
  }
  PROPS.push({ kind: "shelf", x: room.x + 1, y: room.y + 1, w: 3, h: 1 });
  PROPS.push({ kind: "plant", x: room.x + 13, y: room.y + 1, w: 1, h: 1 });
  PROPS.push({ kind: "cabinet", x: room.x + 12, y: room.y + 8, w: 2, h: 1 });
}

PROPS.push({ kind: "operator-desk", x: 9, y: 6, w: 5, h: 2 });
PROPS.push({ kind: "rug", x: 8, y: 9, w: 7, h: 3 });
PROPS.push({ kind: "plant", x: 4, y: 4, w: 1, h: 1 });
PROPS.push({ kind: "plant", x: 17, y: 4, w: 1, h: 1 });

PROPS.push({ kind: "table", x: 31, y: 6, w: 10, h: 3 });
PROPS.push({ kind: "screen", x: 28, y: 3, w: 5, h: 1, label: "screen" });
PROPS.push({ kind: "whiteboard", x: 42, y: 3, w: 5, h: 1 });
PROPS.push({ kind: "plant", x: 25, y: 11, w: 1, h: 1 });
PROPS.push({ kind: "plant", x: 46, y: 11, w: 1, h: 1 });

PROPS.push({ kind: "sofa", x: 56, y: 5, w: 5, h: 1 });
PROPS.push({ kind: "table", x: 62, y: 8, w: 3, h: 2 });
PROPS.push({ kind: "coffee", x: 66, y: 4, w: 3, h: 1, label: "coffee" });
PROPS.push({ kind: "plant", x: 70, y: 11, w: 1, h: 1 });
PROPS.push({ kind: "plant", x: 53, y: 11, w: 1, h: 1 });

/** The walkability grid. */
function buildGrid(): Uint8Array {
  const grid = new Uint8Array(COLS * ROWS); // 0 = walkable

  const block = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    grid[y * COLS + x] = 1;
  };

  // Outer walls.
  for (let x = 0; x < COLS; x += 1) {
    block(x, 0);
    block(x, ROWS - 1);
  }
  for (let y = 0; y < ROWS; y += 1) {
    block(0, y);
    block(COLS - 1, y);
  }

  // Room walls.
  for (const room of ROOMS) {
    for (let x = room.x; x < room.x + room.w; x += 1) {
      block(x, room.y);
      block(x, room.y + room.h - 1);
    }
    for (let y = room.y; y < room.y + room.h; y += 1) {
      block(room.x, y);
      block(room.x + room.w - 1, y);
    }
  }

  // Furniture.
  for (const prop of PROPS) {
    if (prop.kind === "rug") continue;
    for (let y = prop.y; y < prop.y + prop.h; y += 1) {
      for (let x = prop.x; x < prop.x + prop.w; x += 1) block(x, y);
    }
  }

  // Doors.
  for (const room of ROOMS) {
    for (const door of room.doors) grid[door.y * COLS + door.x] = 0;
  }
  // The entrance.
  grid[ENTRANCE.y * COLS + ENTRANCE.x] = 0;
  grid[ENTRANCE.y * COLS + ENTRANCE.x + 1] = 0;

  return grid;
}

export const GRID = buildGrid();

export function walkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  return GRID[y * COLS + x] === 0;
}

export function roomOf(id: string): Room {
  const room = ROOMS.find((r) => r.id === id);
  if (!room) throw new Error(`unknown room: ${id}`);
  return room;
}

/** The corridor tile just outside a room's first door, whichever wall it is in. */
export function doorApproach(room: Room): Pt {
  const door = room.doors[0];
  return door.y === room.y ? { x: door.x, y: door.y - 1 } : { x: door.x, y: door.y + 1 };
}
