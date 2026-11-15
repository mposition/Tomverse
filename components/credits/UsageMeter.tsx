"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import { USAGE_METER_LEVELS, approximateUses, remainingUses, usageMeterLevel } from "@/lib/usageMeter";

/**
 * The credits the viewer can spend now, for the "about N uses" line. Null --
 * the default, and what a guest gets -- shows the meter alone.
 */
const AvailableCreditsContext = createContext<number | null>(null);

export function AvailableCreditsProvider({ value, children }: { value: number | null; children: ReactNode }) {
  return <AvailableCreditsContext.Provider value={value}>{children}</AvailableCreditsContext.Provider>;
}

export const useAvailableCredits = () => useContext(AvailableCreditsContext);

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

type UsageMeterProps = {
  /** What one use of the model costs. Never rendered as a number. */
  credits: number;
  /** A chat answer or an image: only the counting word differs. */
  kind: "chat" | "image";
  testId?: string;
  className?: string;
  /**
   * Draw the "about N uses" line under the bars. A dense list whose right
   * column is narrow (the model catalogue at 320px) turns it off and renders
   * `UsageMeterCount` in its text column instead; the meter's accessible name
   * still carries the count either way.
   */
  showCount?: boolean;
};

/** "about 180 answers", or null when the viewer's balance is unknown. */
function useUsesLabel(credits: number, kind: "chat" | "image") {
  const { t, lang } = useLanguage();
  const available = useAvailableCredits();
  const uses = remainingUses(available, credits);
  const usesLabel =
    uses === null
      ? null
      : uses === 0
        ? t("chat.usageMeterNotEnough")
        : fill(t(kind === "image" ? "chat.usageMeterImages" : "chat.usageMeterAnswers"), {
            count: approximateUses(uses).toLocaleString(lang),
          });
  return { uses, usesLabel };
}

/** The meter's "about N uses" line on its own, for a layout that places it apart from the bars. */
export function UsageMeterCount({ credits, kind, className = "" }: { credits: number; kind: "chat" | "image"; className?: string }) {
  const { usesLabel } = useUsesLabel(credits, kind);
  if (!usesLabel) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="usage-meter-count"
      className={`text-[11px] leading-4 text-zinc-500 dark:text-zinc-400 ${className}`}
    >
      {usesLabel}
    </span>
  );
}

/**
 * How heavy a model is on the user's credits, without the credit number: five
 * bars on one scale for chat and image models, and how many uses the credits
 * they have left cover. The exact cost stays where it is spent -- the image
 * generate button and the chat's estimated-usage summary.
 */
export function UsageMeter({ credits, kind, testId = "usage-meter", className = "", showCount = true }: UsageMeterProps) {
  const { t } = useLanguage();
  const level = usageMeterLevel(credits);
  const { uses, usesLabel } = useUsesLabel(credits, kind);
  const levelLabel = fill(t("chat.usageMeterLevel"), { level, levels: USAGE_METER_LEVELS });
  const remainingLabel =
    usesLabel === null ? null : uses === 0 ? usesLabel : fill(t("chat.usageMeterRemaining"), { uses: usesLabel });
  const label = [levelLabel, remainingLabel].filter(Boolean).join(" · ");

  return (
    <span
      role="img"
      aria-label={label}
      title={usesLabel && kind === "chat" ? `${label} · ${t("chat.usageMeterShortRequests")}` : label}
      data-testid={testId}
      data-usage-level={level}
      data-usage-count={uses ?? undefined}
      className={`inline-flex flex-col items-end gap-0.5 ${className}`}
    >
      <span className="flex items-end gap-0.5" aria-hidden="true">
        {Array.from({ length: USAGE_METER_LEVELS }, (_, index) => (
          <span
            key={index}
            className={`w-1 rounded-sm ${index < level ? "bg-amber-500 dark:bg-amber-400" : "bg-zinc-200 dark:bg-zinc-700"}`}
            style={{ height: `${6 + index * 2}px` }}
          />
        ))}
      </span>
      {showCount && <UsageMeterCount credits={credits} kind={kind} className="whitespace-nowrap" />}
    </span>
  );
}
