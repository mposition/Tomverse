"use client";

import Link from "next/link";
import {
  CalendarDays,
  Clock,
  CreditCard,
  GitBranch,
  Mail,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import type { AdminPixelTeam } from "@/lib/adminPixelAvatarPalette";
import type { AdminTone } from "@/lib/adminUiCore";

const META_ICON = {
  calendar: CalendarDays,
  clock: Clock,
  card: CreditCard,
  branch: GitBranch,
  mail: Mail,
  shield: ShieldCheck,
  users: Users,
} as const;

export type AdminAgentMeta = { icon: keyof typeof META_ICON; label: React.ReactNode };

/** The switch's state as the page read it; `unknown` is never drawn as off. */
export type AdminAgentSwitchState = "on" | "off" | "unknown";

/**
 * The head every AI agent page shares: the team's pixel face, its name, a
 * status chip, one line about what it does, when it runs, and whether its
 * automatic run is switched on.
 *
 * The switch is a reading here, not a control: it links to the settings tab
 * that holds the real switch, so changing it keeps its own role, step-up and
 * audit path, and a person-made "off" is never turned back on by this page.
 */
export function AdminAgentHeader({
  team,
  name,
  status,
  description,
  meta = [],
  autoRun,
}: {
  team: AdminPixelTeam;
  name: string;
  status: { tone: AdminTone; label: string };
  description: string;
  meta?: readonly AdminAgentMeta[];
  autoRun?: { state: AdminAgentSwitchState; href: string };
}) {
  const m = useAdminMessages(adminAgentPageMessages);
  const switchTone: AdminTone = autoRun?.state === "on" ? "ok" : autoRun?.state === "off" ? "idle" : "unknown";
  const switchLabel =
    autoRun?.state === "on" ? m.autoRunOn : autoRun?.state === "off" ? m.autoRunOff : m.autoRunUnknown;
  return (
    <header
      data-testid="agent-header"
      data-team={team}
      className="flex min-w-0 flex-col gap-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 items-center gap-4">
        <AdminPixelAvatar team={team} unit={4} tile={96} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold text-white">{name}</h2>
            <AdminStatusChip tone={status.tone}>{status.label}</AdminStatusChip>
          </div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-400">{description}</p>
          {meta.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
              {meta.map((item, index) => {
                const Icon = META_ICON[item.icon];
                return (
                  <li key={index} className="inline-flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {item.label}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
      {autoRun ? (
        <Link
          href={autoRun.href}
          data-testid="agent-auto-run"
          data-state={autoRun.state}
          title={m.autoRunManage}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-300 hover:bg-zinc-800 md:self-center"
        >
          {m.autoRun}
          <AdminStatusChip tone={switchTone}>{switchLabel}</AdminStatusChip>
        </Link>
      ) : null}
    </header>
  );
}
