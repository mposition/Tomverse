/**
 * What the Admin "개선 제안 (Scout)" section shows (docs/policy/product-research-agent.md §10, §13):
 * whether the scout is on, the model and daily cap an owner chose with today's
 * use of it, the counts, and the open suggestions. Which controls this viewer
 * may use travels with the payload, so a reader is not offered actions that
 * can only refuse.
 */
import "server-only";

import type { Session } from "next-auth";

import { getAdminRole } from "@/lib/adminAuth";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import { PRODUCT_RESEARCH_SCOUT_SWITCH_ENV } from "@/lib/productResearchScoutCore";
import { scoutModelOptions, type ScoutModelOption } from "@/lib/productResearchScoutLlm";
import {
  readScoutSettings,
  scoutUsageToday,
  type ScoutSettings,
  type ScoutUsageToday,
} from "@/lib/productResearchScoutSettings";
import { listSuggestions, suggestionCounts, type SuggestionCounts } from "@/lib/productResearchScoutStore";

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

export type ScoutConsoleView = {
  readonly enabled: boolean;
  readonly settings: ScoutSettings;
  readonly modelOptions: readonly ScoutModelOption[];
  readonly usageToday: ScoutUsageToday;
  readonly counts: SuggestionCounts;
  readonly open: readonly ScoutConsoleSuggestion[];
  readonly canDismiss: boolean;
  readonly canSend: boolean;
  /** Choosing the model and the cap is a spending decision: owner only. */
  readonly canConfigure: boolean;
};

export async function readScoutConsole(session: Session | null): Promise<ScoutConsoleView> {
  const role = getAdminRole(session);
  const [settings, modelOptions, usageToday, counts, open] = await Promise.all([
    readScoutSettings(),
    scoutModelOptions(),
    scoutUsageToday(),
    suggestionCounts(),
    listSuggestions("open"),
  ]);
  return {
    enabled: isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV),
    settings,
    modelOptions,
    usageToday,
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
    canDismiss: role === "owner" || role === "ops",
    canSend: role === "owner",
    canConfigure: role === "owner",
  };
}
