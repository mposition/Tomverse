"use client";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminAgentHeader } from "@/components/admin/ui/AdminAgentHeader";
import { adminScoutAgentMessages } from "@/lib/adminMessages/scoutAgent";
import { localTime, type ScoutState } from "@/lib/adminScoutDisplay";

/**
 * The product-research agent's head. `state` is null when the switch is on but
 * the model and cap could not be read: the chip then says so rather than
 * claiming the agent works or is off. The switch lives in the environment and
 * the model and caps on the Runs tab, so the head links there.
 */
export function ScoutAgentHeader({
  state,
  nextRunAt,
  testAccountConfigured,
}: {
  state: ScoutState | null;
  nextRunAt: string | null;
  testAccountConfigured: boolean | null;
}) {
  const m = useAdminMessages(adminScoutAgentMessages);
  const { locale } = useAdminLocale();
  return (
    <AdminAgentHeader
      team="research"
      name={m.name}
      status={
        state === "on"
          ? { tone: "ok", label: m.status.on }
          : state === "judging_off"
            ? { tone: "warn", label: m.status.judgingOff }
            : state === "off"
              ? { tone: "idle", label: m.status.off }
              : { tone: "unknown", label: m.status.unknown }
      }
      description={m.description}
      meta={[
        { icon: "calendar", label: nextRunAt ? m.nextRun(localTime(nextRunAt, locale, null)) : m.nextRunUnknown },
        ...(testAccountConfigured === null
          ? []
          : [{ icon: "users" as const, label: m.testAccount(testAccountConfigured) }]),
      ]}
      autoRun={{
        state: state === null ? "unknown" : state === "off" ? "off" : "on",
        href: "/admin/product-research?tab=runs",
      }}
    />
  );
}
