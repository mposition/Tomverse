import type { AmuxAnalysisChunk } from "./ideaAnalysisChunkCore.ts";
import { AMUX_V20_REGISTRATION_REFUSAL_ATTEMPT_KINDS,
  isAmuxV20TaskRegistrationRefusal,
  type AmuxV20RegistrationRefusalView } from
  "./ideaRegistrationRefusalCore.ts";

export const AMUX_V4_ANALYSIS_RESULT_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ";
export const AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED = true;

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
  | { state: "pending" | "cancelled" | "provider_failed" | "needs_new_preview" }
  | { state: "partial"; ideaId: string; previewId: string;
      completedAt: string; outcome: "propose";
      coveredScope: string | null; remainingScope: string | null;
      nextChunkIndex: number; units: AmuxVisibleAnalysisUnit[];
      registrationRefusal: AmuxV20RegistrationRefusalView | null }
  | { state: "needs_owner_input"; ideaId: string; previewId: string;
      completedAt: string; outcome: "needs_information";
      coveredScope: string | null; remainingScope: string | null;
      ownerQuestion: string | null; units: AmuxVisibleAnalysisUnit[];
      registrationRefusal: AmuxV20RegistrationRefusalView | null }
  | { state: "ready"; ideaId: string; previewId: string;
      completedAt: string; outcome: "propose" | "reject";
      coveredScope: string | null; units: AmuxVisibleAnalysisUnit[];
      registrationRefusal: AmuxV20RegistrationRefusalView | null };

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
const refusalKinds = new Set<string>(AMUX_V20_REGISTRATION_REFUSAL_ATTEMPT_KINDS);
const grades = new Set(["routine", "advanced", "frontier"]);

const registrationRefusal = (value: unknown): value is AmuxV20RegistrationRefusalView => {
  if (!record(value) || !keys(value, ["state", "requestId", "attemptKind",
    "refusalCode", "draftUnitId", "analysisPreviewId", "sourcePlanRevisionId",
    "proposedExecutionGrade", "finalExecutionGrade", "attemptedAt"])) return false;
  return value.state === "awaiting_operator" &&
    typeof value.requestId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.requestId) &&
    typeof value.attemptKind === "string" && refusalKinds.has(value.attemptKind) &&
    isAmuxV20TaskRegistrationRefusal(value.refusalCode) &&
    typeof value.draftUnitId === "string" && ID.test(value.draftUnitId) &&
    typeof value.analysisPreviewId === "string" && ID.test(value.analysisPreviewId) &&
    typeof value.sourcePlanRevisionId === "string" &&
    ID.test(value.sourcePlanRevisionId) &&
    (value.proposedExecutionGrade === null ||
      (typeof value.proposedExecutionGrade === "string" &&
        grades.has(value.proposedExecutionGrade))) &&
    (value.finalExecutionGrade === null ||
      (typeof value.finalExecutionGrade === "string" &&
        grades.has(value.finalExecutionGrade))) &&
    typeof value.attemptedAt === "string" &&
    Number.isFinite(Date.parse(value.attemptedAt));
};

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
  if (body.state === "pending" || body.state === "cancelled" ||
      body.state === "provider_failed" || body.state === "needs_new_preview") {
    return keys(body, ["state"]) ? body as AmuxIdeaAnalysisResultView : null;
  }
  const partial = body.state === "partial";
  const ownerInput = body.state === "needs_owner_input";
  if ((!partial && !ownerInput && body.state !== "ready") || !keys(body, partial
    ? ["state", "ideaId", "previewId", "completedAt", "outcome",
      "coveredScope", "remainingScope", "nextChunkIndex", "units",
      "registrationRefusal"]
    : ownerInput ? ["state", "ideaId", "previewId", "completedAt", "outcome",
      "coveredScope", "remainingScope", "ownerQuestion", "units",
      "registrationRefusal"]
    : ["state", "ideaId", "previewId", "completedAt", "outcome",
      "coveredScope", "units", "registrationRefusal"]) ||
      body.ideaId !== expectedIdeaId || typeof body.previewId !== "string" ||
      !ID.test(body.previewId) || typeof body.completedAt !== "string" ||
      !Number.isFinite(Date.parse(body.completedAt)) ||
      (ownerInput ? body.outcome !== "needs_information" :
        partial ? body.outcome !== "propose" :
        body.outcome !== "propose" && body.outcome !== "reject") ||
      (body.coveredScope !== null && !text(body.coveredScope)) ||
      !Array.isArray(body.units) || body.units.length > 40 ||
      (body.outcome === "reject" ? body.units.length !== 0 :
        body.outcome === "propose" && body.units.length === 0) ||
      (body.registrationRefusal !== null &&
        !registrationRefusal(body.registrationRefusal))) {
    return null;
  }
  if (partial && ((body.remainingScope !== null && !text(body.remainingScope)) ||
      typeof body.nextChunkIndex !== "number" ||
      !Number.isSafeInteger(body.nextChunkIndex) || body.nextChunkIndex < 1 ||
      body.nextChunkIndex >= 2_147_483_647)) {
    return null;
  }
  if (ownerInput && ((body.remainingScope !== null && !text(body.remainingScope)) ||
      (body.ownerQuestion !== null && !text(body.ownerQuestion)))) return null;
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
      if (!text(proposal.title, 200) || !text(proposal.description)) return null;
    } else if (proposal.kind === "card") {
      if (!text(proposal.title, 200) || !text(proposal.problem) ||
          !textList(proposal.scopeIn) || !textList(proposal.scopeOut) ||
          !textList(proposal.completionCriteria)) return null;
    } else if (proposal.kind === "evidence") {
      if (!text(proposal.summary)) return null;
    } else return null;
  }
  return body as AmuxIdeaAnalysisResultView;
}
