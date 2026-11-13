/**
 * What the Admin "Product research" workspace shows of the Scout
 * (docs/policy/product-research-agent.md §10, §13): whether it is on, the
 * model and daily cap an owner chose with today's use of it, its newest run,
 * and, for the open section only, the open suggestions or the last seven days.
 * Which controls this viewer may use travels with the payload, so a reader is
 * not offered actions that can only refuse.
 */
import "server-only";

import { latestMemoryReadings, memoryScoutEnabled } from "./productResearchScoutMemory";
import { comparisonEnabled } from "./scoutMemoryExperimentRunner";
import { recentMemoryTrials } from "./scoutMemoryExperimentStore";
import { summarizeTrials } from "./scoutMemoryExperiment";
import measuredBenchmark from "./scoutMemoryBenchmark.json";
import { formatAestDate } from "./adminUiCore";
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
import { scoutTestAccountEmail } from "@/lib/productResearchScoutSignedIn";
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
  readonly agentWork?: { status: "claimed" | "needs_lookup" | "pr_opened" | "failed"; prUrl?: string; reason?: string };
};

export type ScoutConsoleSection = "suggestions" | "runs";

export const SCOUT_CONSOLE_DAYS = 7;

type ComparisonView = {model:string|null;day:string;rows:ReturnType<typeof summarizeTrials>};
export type ScoutConsoleView = {
  readonly memoryComparison?: {enabled:boolean;daily:ComparisonView;benchmark:ComparisonView};
  readonly enabled: boolean;
  readonly memoryQuality?: { readonly enabled:boolean;readonly day:string;readonly readings:Awaited<ReturnType<typeof latestMemoryReadings>> };
  /** Whether a test account is named. The address itself stays on the server. */
  readonly testAccountConfigured: boolean;
  readonly settings: ScoutSettings;
  readonly modelOptions: readonly ScoutModelOption[];
  readonly usageToday: ScoutUsageToday;
  readonly lastRun: ScoutRunSummary | null;
  readonly nextRunAt: string;
  readonly counts: SuggestionCounts;
  /** The open suggestions, newest first; only on the Suggestions section. */
  readonly open: readonly ScoutConsoleSuggestion[];
  /** Recently completed suggestions, retained separately from declined ones. */
  readonly completed: readonly { readonly id: string; readonly title: string; readonly subject: string; readonly completedAt: string | null }[];
  /** One row per UTC day, newest first; only on the Runs section. */
  readonly days: readonly ScoutDaySummary[];
  readonly canDismiss: boolean;
  readonly canComplete: boolean;
  readonly canSend: boolean;
  /** Choosing the model and the cap is a spending decision: owner only. */
  readonly canConfigure: boolean;
};

export async function readScoutConsole(session: Session | null, section: ScoutConsoleSection): Promise<ScoutConsoleView> {
  const role = getAdminRole(session);
  const now = new Date();
  const [settings, modelOptions, usageToday, counts, calls, open, completed, memoryReadings, trials] = await Promise.all([
    readScoutSettings(),
    scoutModelOptions(),
    scoutUsageToday(),
    suggestionCounts(),
    scoutRecentCalls(SCOUT_CONSOLE_DAYS),
    section === "suggestions" ? listSuggestions("open") : Promise.resolve([]),
    section === "suggestions" ? listSuggestions("completed") : Promise.resolve([]),
    section === "suggestions" ? latestMemoryReadings() : Promise.resolve([]),
    section === "suggestions" ? recentMemoryTrials(now) : Promise.resolve([]),
  ]);
  const displayModel=trials.some(r=>r.model===settings.modelId) ? settings.modelId : [...trials].sort((a,b)=>b.measuredAt.localeCompare(a.measuredAt))[0]?.model ?? settings.modelId;
  return {
    enabled: isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV),
    memoryComparison:{enabled:comparisonEnabled() && memoryScoutEnabled() && isProductResearchRouteEnabled(process.env,PRODUCT_RESEARCH_SCOUT_SWITCH_ENV), daily:{model:displayModel, day:formatAestDate(now)!, rows:summarizeTrials(trials,displayModel)},benchmark:measuredBenchmark as ComparisonView},
    memoryQuality:{enabled:memoryScoutEnabled() && isProductResearchRouteEnabled(process.env,PRODUCT_RESEARCH_SCOUT_SWITCH_ENV),day:formatAestDate(now)!,readings:memoryReadings},
    testAccountConfigured: scoutTestAccountEmail() !== null,
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
      ...(row.agentWork ? { agentWork: row.agentWork } : {}),
    })),
    completed: completed.map((row) => ({ id: row.id, title: row.title, subject: row.subject, completedAt: row.statusChangedAt?.toISOString() ?? null })),
    days: section === "runs" ? scoutDays(calls, now, SCOUT_CONSOLE_DAYS) : [],
    canDismiss: role === "owner" || role === "ops",
    canComplete: role === "owner" || role === "ops",
    canSend: role === "owner",
    canConfigure: role === "owner",
  };
}
