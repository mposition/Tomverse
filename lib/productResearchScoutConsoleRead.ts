/**
 * What the Admin "Product research" workspace shows of the Scout
 * (docs/policy/product-research-agent.md §10, §13): whether it is on, the
 * model and daily cap an owner chose with today's use of it, its newest run,
 * and, for the open section only, the open suggestions or the last seven days.
 * Which controls this viewer may use travels with the payload, so a reader is
 * not offered actions that can only refuse.
 */
import "server-only";

import type { Session } from "next-auth";

import { getAdminRole } from "@/lib/adminAuth";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import {
  PRODUCT_RESEARCH_SCOUT_SWITCH_ENV,
  latestScoutRun,
  nextScoutRunAt,
  scoutDays,
  type ScoutDaySummary,
  type ScoutRunSummary,
} from "@/lib/productResearchScoutCore";
import { scoutModelOptions, type ScoutModelOption } from "@/lib/productResearchScoutLlm";
import {
  readScoutSettings,
  scoutRecentCalls,
  scoutUsageToday,
  type ScoutSettings,
  type ScoutUsageToday,
} from "@/lib/productResearchScoutSettings";
import {
  listSuggestions,
  suggestionCounts,
  type SuggestionCounts,
} from "@/lib/productResearchScoutStore";

export type ScoutConsoleSuggestion = {
  readonly id: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly subject: string;
  readonly title: string;
  readonly area: string;
  readonly severity: string;
  readonly evidence: string;
  readonly suggestion: string;
};

export type ScoutConsoleSection = "suggestions" | "runs";

export const SCOUT_CONSOLE_DAYS = 7;

export type ScoutConsoleView = {
  readonly enabled: boolean;
  readonly settings: ScoutSettings;
  readonly modelOptions: readonly ScoutModelOption[];
  readonly usageToday: ScoutUsageToday;
  readonly lastRun: ScoutRunSummary | null;
  readonly nextRunAt: string;
  readonly counts: SuggestionCounts;
  /** The open suggestions, newest first; only on the Suggestions section. */
  readonly open: readonly ScoutConsoleSuggestion[];
  /** One row per UTC day, newest first; only on the Runs section. */
  readonly days: readonly ScoutDaySummary[];
  readonly canDismiss: boolean;
  readonly canSend: boolean;
  /** Choosing the model and the cap is a spending decision: owner only. */
  readonly canConfigure: boolean;
};

export async function readScoutConsole(session: Session | null, section: ScoutConsoleSection): Promise<ScoutConsoleView> {
  const role = getAdminRole(session);
  const now = new Date();
  const [settings, modelOptions, usageToday, counts, calls, open] = await Promise.all([
    readScoutSettings(),
    scoutModelOptions(),
    scoutUsageToday(),
    suggestionCounts(),
    scoutRecentCalls(SCOUT_CONSOLE_DAYS),
    section === "suggestions" ? listSuggestions("open") : Promise.resolve([]),
  ]);
  return {
    enabled: isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV),
    settings,
    modelOptions,
    usageToday,
    lastRun: latestScoutRun(calls),
    nextRunAt: nextScoutRunAt(now).toISOString(),
    counts,
    open: open.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      kind: row.kind,
      subject: row.subject,
      title: row.title,
      area: row.area,
      severity: row.severity,
      evidence: row.evidence,
      suggestion: row.suggestion,
    })),
    days: section === "runs" ? scoutDays(calls, now, SCOUT_CONSOLE_DAYS) : [],
    canDismiss: role === "owner" || role === "ops",
    canSend: role === "owner",
    canConfigure: role === "owner",
  };
}
