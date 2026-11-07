/**
 * The clothes of each AI team's pixel figure outside the Agent office: the
 * sidebar, the decision inbox, the team board and an agent's page header.
 *
 * Same figure and the same palette family as the office
 * (`lib/agentOffice/roster.ts`), so an operator recognises a team by its face
 * everywhere. Character art keeps its own colours in both console themes, like
 * the office does; the tile behind the figure (`tint`) is a palette family so
 * Light can remap it.
 */
export type AdminPixelTeam =
  | "marketing"
  | "research"
  | "engineering"
  | "sre"
  | "finance"
  | "qa"
  | "support"
  | "trust"
  | "routing"
  | "amux";

export type AdminPixelClothes = {
  hair: string;
  shirt: string;
  /** The headset and the shirt's lower band. */
  accent: string;
  skin: string;
  /** Palette family of the tile behind the figure. */
  tint: "amber" | "emerald" | "blue" | "red" | "violet" | "teal" | "pink" | "zinc" | "indigo" | "cyan";
};

export const ADMIN_PIXEL_OUTLINE = "#27272a";
export const ADMIN_PIXEL_BLUSH = "#e8939b";

export const ADMIN_PIXEL_TEAMS: Record<AdminPixelTeam, AdminPixelClothes> = {
  marketing: { hair: "#463227", shirt: "#fde68a", accent: "#f59e0b", skin: "#ffdcc4", tint: "amber" },
  research: { hair: "#2d4b46", shirt: "#b8f0dd", accent: "#10b981", skin: "#f7cdae", tint: "emerald" },
  engineering: { hair: "#2c2638", shirt: "#bae6fd", accent: "#3b82f6", skin: "#ffe3cf", tint: "blue" },
  sre: { hair: "#313b56", shirt: "#e4e4e7", accent: "#ef4444", skin: "#eec39f", tint: "red" },
  finance: { hair: "#4a3a2a", shirt: "#ddd6fe", accent: "#8b5cf6", skin: "#ffdcc4", tint: "violet" },
  qa: { hair: "#2d4b46", shirt: "#b8f0dd", accent: "#14b8a6", skin: "#ffe3cf", tint: "teal" },
  support: { hair: "#563a32", shirt: "#fbcfe8", accent: "#ec4899", skin: "#f7cdae", tint: "pink" },
  trust: { hair: "#2d4b46", shirt: "#cbd5e1", accent: "#64748b", skin: "#eec39f", tint: "zinc" },
  routing: { hair: "#3c3a4f", shirt: "#c7d2fe", accent: "#6366f1", skin: "#ffdcc4", tint: "indigo" },
  amux: { hair: "#3b3b49", shirt: "#a5f3fc", accent: "#06b6d4", skin: "#f7cdae", tint: "cyan" },
};

/** One rectangle of the figure, in grid units (the figure is 16 wide). */
export type AdminPixelRect = { x: number; y: number; w: number; h: number; fill: string };

/**
 * The figure as rectangles: head and shoulders (`body`) or head only, on a
 * 16 x 18 (or 16 x 14) grid. Pure, so a test can check it without a browser.
 */
export function adminPixelRects(team: AdminPixelTeam, body = true): AdminPixelRect[] {
  const c = ADMIN_PIXEL_TEAMS[team];
  const o = ADMIN_PIXEL_OUTLINE;
  const rects: AdminPixelRect[] = [];
  const r = (x: number, y: number, w: number, h: number, fill: string) => rects.push({ x, y, w, h, fill });
  if (body) {
    r(2, 12, 12, 6, o);
    r(3, 13, 10, 5, c.shirt);
    r(3, 16, 10, 2, c.accent);
  }
  r(3, 3, 10, 10, o);
  r(4, 4, 8, 8, c.skin);
  r(6, 7, 1, 1, o);
  r(9, 7, 1, 1, o);
  r(5, 9, 1, 1, ADMIN_PIXEL_BLUSH);
  r(10, 9, 1, 1, ADMIN_PIXEL_BLUSH);
  r(2, 1, 12, 4, o);
  r(3, 2, 10, 2, c.hair);
  r(3, 4, 2, 3, c.hair);
  r(11, 4, 2, 2, c.hair);
  r(12, 5, 3, 6, o);
  r(13, 6, 1, 4, c.accent);
  r(11, 10, 2, 1, o);
  return rects;
}
