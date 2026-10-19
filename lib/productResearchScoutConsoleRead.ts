/**
 * What the Admin "개선 제안 (Scout)" section shows (docs/policy/product-research-agent.md §10):
 * whether the scout is on, whether a model is set, the counts, and the open
 * suggestions. Which buttons this viewer may use travels with the payload, so
 * a reader is not offered actions that can only refuse.
 */
import "server-only";

import type { Session } from "next-auth";

import { getAdminRole } from "@/lib/adminAuth";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import { PRODUCT_RESEARCH_SCOUT_SWITCH_ENV } from "@/lib/productResearchScoutCore";
import { PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ENV } from "@/lib/productResearchScoutLlm";
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
  readonly modelConfigured: boolean;
  readonly counts: SuggestionCounts;
  readonly open: readonly ScoutConsoleSuggestion[];
  readonly canDismiss: boolean;
  readonly canSend: boolean;
};

export async function readScoutConsole(session: Session | null): Promise<ScoutConsoleView> {
  const role = getAdminRole(session);
  const [counts, open] = await Promise.all([suggestionCounts(), listSuggestions("open")]);
  return {
    enabled: isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV),
    modelConfigured: (process.env[PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ENV] ?? "").trim().length > 0,
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
  };
}
