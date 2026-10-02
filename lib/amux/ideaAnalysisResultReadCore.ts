import type { AmuxAnalysisChunk } from "./ideaAnalysisChunkCore.ts";

export const AMUX_V4_ANALYSIS_RESULT_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ";
export const AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED = false;

export const amuxV4AnalysisResultReadEnabled = (value: string | undefined): boolean =>
  AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED && value === "enabled";

export type AmuxVisibleAnalysisUnit = {
  id: string;
  localRef: string;
  bodyDigest: string;
  bodyDigestKeyId: string;
  decisionState: "proposed" | "approved" | "rejected" | "expired";
  proposal: AmuxAnalysisChunk["units"][number] | null;
};

export type AmuxIdeaAnalysisResultView =
  | { state: "pending" | "cancelled" }
  | { state: "ready"; ideaId: string; previewId: string;
      completedAt: string; outcome: "propose" | "reject";
      coveredScope: string | null; units: AmuxVisibleAnalysisUnit[] };

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2_000): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const textList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 12 && value.every((item) => text(item, 500));
const refList = (value: unknown, max: number, min = 0): value is string[] =>
  Array.isArray(value) && value.length >= min && value.length <= max &&
  value.every((item) => text(item, 128));
const optionalRef = (value: unknown): value is string | null =>
  value === null || text(value, 128);

/** The append-only analysis audit binds every stored proposal, including
 * units whose body has since been purged. No proposal text enters the audit. */
export function matchesAmuxIdeaAnalysisUnitCommitments(
  commitments: unknown,
  units: readonly { id: string; localRef: string | null; unitKind: string;
    bodyDigest: string; bodyDigestKeyId: string }[],
): boolean {
  return Array.isArray(commitments) && commitments.length === units.length &&
    units.length <= 40 && units.every((unit, index) => {
      const commitment: unknown = commitments[index];
      return record(commitment) && keys(commitment,
        ["id", "localRef", "kind", "digest", "digestKeyId"]) &&
        unit.localRef !== null && commitment.id === unit.id &&
        commitment.localRef === unit.localRef &&
        commitment.kind === unit.unitKind && commitment.digest === unit.bodyDigest &&
        commitment.digestKeyId === unit.bodyDigestKeyId;
    });
}

/** Strictly shape the same-origin response before rendering model-derived text.
 * This is a UI guard only; the app DB reader performs ownership and HMAC checks. */
export function parseAmuxIdeaAnalysisResultView(
  status: number, body: unknown, expectedIdeaId: string,
): AmuxIdeaAnalysisResultView | null {
  if (status !== 200 || !ID.test(expectedIdeaId) || !record(body)) return null;
  if (body.state === "pending" || body.state === "cancelled") {
    return keys(body, ["state"]) ? body as AmuxIdeaAnalysisResultView : null;
  }
  if (body.state !== "ready" || !keys(body, ["state", "ideaId", "previewId",
    "completedAt", "outcome", "coveredScope", "units"]) ||
      body.ideaId !== expectedIdeaId || typeof body.previewId !== "string" ||
      !ID.test(body.previewId) || typeof body.completedAt !== "string" ||
      !Number.isFinite(Date.parse(body.completedAt)) ||
      (body.outcome !== "propose" && body.outcome !== "reject") ||
      (body.coveredScope !== null && !text(body.coveredScope)) ||
      !Array.isArray(body.units) || body.units.length > 40 ||
      (body.outcome === "reject" ? body.units.length !== 0 : body.units.length === 0)) {
    return null;
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const value of body.units) {
    if (!record(value) || !keys(value, ["id", "localRef", "bodyDigest",
      "bodyDigestKeyId", "decisionState", "proposal"]) ||
        typeof value.id !== "string" || !ID.test(value.id) || ids.has(value.id) ||
        typeof value.localRef !== "string" || !ID.test(value.localRef) ||
        refs.has(value.localRef) || typeof value.bodyDigest !== "string" ||
        !DIGEST.test(value.bodyDigest) || !text(value.bodyDigestKeyId, 64) ||
        !["proposed", "approved", "rejected", "expired"].includes(
          String(value.decisionState))) return null;
    ids.add(value.id);
    refs.add(value.localRef);
    if (value.proposal === null) continue;
    if (!record(value.proposal) || value.proposal.localId !== value.localRef) return null;
    const proposal = value.proposal;
    if (proposal.kind === "node") {
      if (!["initiative", "epic", "feature"].includes(String(proposal.level)) ||
          !text(proposal.title, 200) || !text(proposal.description) ||
          !optionalRef(proposal.parentRef) ||
          !refList(proposal.sourceRefIds, 16, 1)) return null;
    } else if (proposal.kind === "card") {
      if (!["story", "task"].includes(String(proposal.cardType)) ||
          !text(proposal.title, 200) || !text(proposal.problem) ||
          !textList(proposal.scopeIn) || !textList(proposal.scopeOut) ||
          !textList(proposal.completionCriteria) || !text(proposal.featureRef, 128) ||
          !optionalRef(proposal.parentStoryRef) ||
          !refList(proposal.dependencyRefs, 16) ||
          !refList(proposal.duplicateCandidateRefs, 8) ||
          !refList(proposal.sourceRefIds, 16, 1) ||
          !optionalRef(proposal.taskRole) || !optionalRef(proposal.executionGrade) ||
          (proposal.executionBrief !== null && !text(proposal.executionBrief))) return null;
    } else if (proposal.kind === "evidence") {
      if (!["observed_error", "source_finding"].includes(String(proposal.evidenceType)) ||
          !text(proposal.summary) || !text(proposal.cardRef, 128) ||
          !refList(proposal.sourceRefIds, 16, 1)) return null;
    } else return null;
  }
  return body as AmuxIdeaAnalysisResultView;
}
