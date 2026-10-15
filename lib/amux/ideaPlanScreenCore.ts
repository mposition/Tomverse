import type { AmuxVisibleAnalysisUnit } from "./ideaAnalysisResultReadCore.ts";

/** Pure assembly of the plan approval request from the analysis result the
 * screen shows (amux-intake.md v18 item 3). No I/O. */

const METRIC_KEYS = {
  initiative: ["value"], epic: ["value"], feature: ["value"], story: ["impact"],
  task: ["contribution", "urgency", "dependencyUnlock", "workerCoverage", "effort", "deliveryRisk"],
} as const;
type SubjectKind = keyof typeof METRIC_KEYS;

export type AmuxV4PlanScreenUnit = {
  unitId: string; localRef: string; kind: SubjectKind; title: string;
  taskRole: string | null; metrics: Record<string, number> | null;
  uncertainty: "low" | "medium" | "high" | null; bodyDigest: string;
  featureRef: string | null; parentRef: string | null; parentStoryRef: string | null;
};

const kindOf = (unit: AmuxVisibleAnalysisUnit): SubjectKind | null => {
  const proposal = unit.proposal;
  if (proposal?.kind === "node") return proposal.level;
  if (proposal?.kind === "card") return proposal.cardType;
  return null;
};

/** A signal's metrics, only if they are exactly the subject kind's keys and 0..5 integers. */
export function amuxV4PlanMetrics(kind: SubjectKind, metrics: unknown): Record<string, number> | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const keys = METRIC_KEYS[kind] as readonly string[];
  const value = metrics as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length) return null;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 5) return null;
    out[key] = n;
  }
  return out;
}

/** The plan's proposed node and card units, as the screen lists them. */
export function amuxV4PlanScreenUnits(units: readonly AmuxVisibleAnalysisUnit[]): AmuxV4PlanScreenUnit[] {
  return units.flatMap((unit) => {
    const kind = kindOf(unit);
    const proposal = unit.proposal;
    if (unit.decisionState !== "proposed" || !kind || !proposal ||
        (proposal.kind !== "node" && proposal.kind !== "card")) return [];
    const signal = proposal.portfolioSignal;
    return [{
      unitId: unit.id, localRef: unit.localRef, kind, title: proposal.title,
      taskRole: proposal.kind === "card" ? proposal.taskRole : null,
      metrics: signal ? amuxV4PlanMetrics(kind, signal.metrics) : null,
      uncertainty: signal?.uncertainty ?? null, bodyDigest: unit.bodyDigest,
      featureRef: proposal.kind === "card" ? proposal.featureRef : null,
      parentRef: proposal.kind === "node" ? proposal.parentRef : null,
      parentStoryRef: proposal.kind === "card" ? proposal.parentStoryRef : null,
    }];
  });
}

/**
 * The request body. Each unit with metrics (the owner's edit, else the
 * model's signal) is assessed once, bound to its proposal's body digest. A
 * Task is scored only when every subject on its path -- Feature, Epic,
 * Initiative and its Story if any -- is a unit of this plan with metrics; a
 * path through an earlier approval is left for the single score screen,
 * because this screen cannot see whether that subject is assessed.
 */
export function buildAmuxV4PlanRequest(input: {
  ideaId: string; planRequestId: string; units: readonly AmuxV4PlanScreenUnit[];
  edits: ReadonlyMap<string, Record<string, number>>; consentOff: ReadonlySet<string>;
}) {
  const assessed = new Map<string, AmuxV4PlanScreenUnit>();
  const assessments = input.units.flatMap((unit) => {
    const metrics = input.edits.has(unit.unitId)
      ? amuxV4PlanMetrics(unit.kind, input.edits.get(unit.unitId)) : unit.metrics;
    if (!metrics) return [];
    assessed.set(unit.localRef, unit);
    return [{ unitId: unit.unitId, metrics, uncertainty: unit.uncertainty ?? "high",
      evidenceRefs: [`unit:${unit.unitId}`], modelProposalDigest: unit.bodyDigest }];
  });
  const node = (ref: string | null, kind: SubjectKind) => {
    const found = ref === null ? undefined : assessed.get(ref);
    return found?.kind === kind ? found : undefined;
  };
  const scoreTaskUnitIds = input.units.filter((unit) => {
    if (unit.kind !== "task" || !assessed.has(unit.localRef)) return false;
    const feature = node(unit.featureRef, "feature");
    const epic = feature && node(feature.parentRef, "epic");
    const initiative = epic && node(epic.parentRef, "initiative");
    const storyOk = unit.parentStoryRef === null || node(unit.parentStoryRef, "story") !== undefined;
    return Boolean(initiative) && storyOk;
  }).map((unit) => unit.unitId);
  return {
    ideaId: input.ideaId, planRequestId: input.planRequestId, reasons: {},
    publicPrConsentOff: input.units.filter((unit) => unit.kind === "task" &&
      unit.taskRole === "implement" && input.consentOff.has(unit.unitId)).map((unit) => unit.unitId),
    assessments, scoreTaskUnitIds,
  };
}
