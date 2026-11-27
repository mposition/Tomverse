"use client";

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { SettingsEntryRow } from "@/components/settings/SettingsEntryRow";
import { scheduledTasksEntryVisible } from "@/lib/scheduledTaskCore";
import { settingsSectionElementId } from "@/lib/settingsNavigation";
import { formatScheduledTasksCopy, scheduledTasksCopy } from "@/locales/scheduledTasks";

type Summary = { enabled: boolean; planAllowed: boolean; tasks: Array<{ status: string }> };

/**
 * The scheduled-tasks group on the AI personalization tab.
 *
 * Renders nothing until it knows the feature is open to this account, and
 * nothing at all while the switch is off and the account has saved no task --
 * so with `feature.scheduledTasksEnabled` off the settings list is exactly
 * what it was. A person who saved tasks before the switch went off still
 * reaches them, to see and delete what they made.
 *
 * The row appears after a fetch, which is later than the panel's own
 * focus-restoration pass; `pendingFocus` lets that pass hand the job over.
 */
export function ScheduledTasksSettingsEntry({
  onNavigate,
  pendingFocus,
  onFocused,
}: {
  onNavigate?: () => void;
  pendingFocus?: boolean;
  onFocused?: () => void;
}) {
  const { lang } = useLanguage();
  const copy = scheduledTasksCopy[lang].entry;
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/scheduled-tasks", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        const data = (await response.json()) as Summary | null;
        if (!cancelled && data && Array.isArray(data.tasks)) setSummary(data);
      })
      .catch(() => {
        // Unreachable API: the group stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = scheduledTasksEntryVisible(summary);

  useEffect(() => {
    if (!visible || !pendingFocus) return;
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(settingsSectionElementId("scheduled-tasks"));
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
      onFocused?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, pendingFocus, onFocused]);

  if (!visible || !summary) return null;
  const active = summary.tasks.filter((task) => task.status === "active").length;

  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
      data-testid="settings-scheduled-tasks"
    >
      <h3 className="text-sm font-bold">{copy.groupTitle}</h3>
      <p className="mt-1 text-sm leading-6 text-zinc-500">{copy.groupDescription}</p>
      <div className="mt-3">
        <SettingsEntryRow
          section="scheduled-tasks"
          href="/settings/scheduled-tasks"
          icon={CalendarClock}
          title={copy.title}
          description={copy.description}
          status={active > 0 ? formatScheduledTasksCopy(copy.statusActive, { count: active }) : copy.statusNone}
          actionLabel={copy.open}
          onNavigate={onNavigate}
          testId="scheduled-tasks-entry"
          linkTestId="scheduled-tasks-entry-link"
        />
      </div>
    </section>
  );
}
