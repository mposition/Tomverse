import { adminPixelRects, ADMIN_PIXEL_TEAMS, type AdminPixelTeam } from "@/lib/adminPixelAvatarPalette";

// Static strings so Tailwind sees every class; a palette family per team.
const TINT_CLASS: Record<string, string> = {
  amber: "bg-amber-500/15",
  emerald: "bg-emerald-500/15",
  blue: "bg-blue-500/15",
  red: "bg-red-500/15",
  violet: "bg-violet-500/15",
  teal: "bg-teal-500/15",
  pink: "bg-pink-500/15",
  zinc: "bg-zinc-800",
  indigo: "bg-indigo-500/15",
  cyan: "bg-cyan-500/15",
};

/**
 * An AI team's pixel figure, the same character the Agent office draws.
 *
 * `unit` is the pixel size; `tile` puts it on its team-coloured rounded square
 * (head only), which is how lists and the sidebar show who is asking.
 */
export function AdminPixelAvatar({
  team,
  unit = 3,
  body = true,
  tile,
  label,
  className = "",
}: {
  team: AdminPixelTeam;
  unit?: number;
  body?: boolean;
  /** Tile size in pixels; omit for the bare figure. */
  tile?: number;
  /** Accessible name; omit when the team's name is already next to it. */
  label?: string;
  className?: string;
}) {
  const rows = body ? 18 : 14;
  const figure = (
    <svg
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      width={16 * unit}
      height={rows * unit}
      viewBox={`0 0 16 ${rows}`}
      shapeRendering="crispEdges"
      className={tile ? "block" : `block shrink-0 ${className}`}
    >
      {adminPixelRects(team, body).map((rect, index) => (
        <rect key={index} x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill={rect.fill} />
      ))}
    </svg>
  );
  if (!tile) return figure;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl ${
        TINT_CLASS[ADMIN_PIXEL_TEAMS[team].tint]
      } ${className}`}
      style={{ width: tile, height: tile }}
    >
      {figure}
    </span>
  );
}
