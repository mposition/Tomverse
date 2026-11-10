import type { AmuxWorkerChannel } from "@/lib/adminAmuxFlow";

// Static strings so Tailwind sees every class. The solid 600 steps keep white
// text in both console themes.
const CHANNEL: Record<AmuxWorkerChannel, { glyph: string; name: string; tone: string }> = {
  claude: { glyph: "C", name: "Claude", tone: "bg-amber-600" },
  codex: { glyph: "X", name: "Codex", tone: "bg-emerald-600" },
  copilot: { glyph: "Co", name: "Copilot", tone: "bg-blue-600" },
  cursor: { glyph: "Cu", name: "Cursor", tone: "bg-indigo-600" },
  antigravity: { glyph: "Ag", name: "Antigravity", tone: "bg-teal-600" },
};

/** The product name of an AMUX channel, as the operator says it. */
export const adminChannelName = (channel: AmuxWorkerChannel) => CHANNEL[channel].name;

/**
 * A worker's channel (the CLI it runs) as a small badge. A letter on a
 * channel-coloured square, not a logo: the badge tells channels apart at a
 * glance and the name beside it says which. Without `label` it is decorative.
 */
export function AdminChannelIcon({
  channel,
  size = 20,
  label,
  className = "",
}: {
  channel: AmuxWorkerChannel;
  size?: number;
  label?: string;
  className?: string;
}) {
  const spec = CHANNEL[channel];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-channel={channel}
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-[10px] font-bold leading-none text-white ${spec.tone} ${className}`}
      style={{ width: size, height: size }}
    >
      {spec.glyph}
    </span>
  );
}
