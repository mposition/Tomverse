import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import { AMUX_V4_ANALYSIS_PROMPT_VERSION } from "./ideaAnalysisPromptCore.ts";
import type { AmuxIdeaModelSelection } from "./ideaFrontierSelectionCore.ts";
import type { IdeaInput } from "./ideaInputCore.ts";
import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";
import type { AmuxOperatingScopeAuthority } from "./ideaOperatingScopeStore.ts";
import { amuxSessionPageRefusalDetail } from "./ideaSessionReviewDetailCore.ts";

/** Refused before the intake transaction starts, so nothing was written. */
const SESSION_PREWRITE_STATUS: Readonly<Record<string, number>> = {
  audit_unavailable: 503,
  scope_unavailable: 409,
  outside_scope: 409,
  model_not_approved: 409,
  model_not_launchable: 409,
  reference_snapshot_unavailable: 503,
  // key_store_unavailable stays a read-back: the shared UI table treats it so
  // on the v4 path, where a key outcome can be uncertain.
};

export const amuxIdeaSessionPrewriteStatus = (code: string): number | undefined =>
  Object.hasOwn(SESSION_PREWRITE_STATUS, code) ? SESSION_PREWRITE_STATUS[code] : undefined;

export type AmuxIdeaSessionSource = {
  toolName: string;
  modelProvider: string;
  sessionDisplay: string;
};

/** A plan the coding session wrote itself, in the session analysis answer
 * format (owner decision 2026-11-21). `raw` is the exact JSON text the plan
 * writer parses; it already passed the same parser and content checks. */
export type AmuxIdeaSessionPlan = {
  raw: string;
  /** Every unit the plan holds, evidence included: one storage key each. */
  unitCount: number;
};

export type AmuxIdeaSessionSubmissionInspection =
  | { ok: true; requestId: string; input: IdeaInput; source: AmuxIdeaSessionSource;
      counts: { ideaBytes: number; repositoryCount: number; pullRequestCount: number };
      /** Absent: the box analysis queue makes the plan, as before. */
      plan?: AmuxIdeaSessionPlan }
  | { ok: false; code: "schema_rejected" | "content_refused" | "metadata_incomplete" |
      "plan_rejected" };

export type AmuxIdeaSessionInputInspection =
  | { ok: true; input: IdeaInput;
      counts: { ideaBytes: number; repositoryCount: number; pullRequestCount: number } }
  | { ok: false; code: "schema_rejected" | "content_refused" | "metadata_incomplete" };

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const validRepository = (value: string) => REPOSITORY.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");
const controlCharacter = (value: string) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const secret = (value: string) =>
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{1,}/.test(value) ||
  /sk_(?:test|live)_[A-Za-z0-9]{12,}/i.test(value) ||
  /rk_(?:test|live)_[A-Za-z0-9]{12,}/i.test(value) ||
  /whsec_[A-Za-z0-9]{12,}/i.test(value) ||
  /ghp_/.test(value) || /github_pat_/.test(value) || /AKIA[0-9A-Z]{16}/.test(value) ||
  /xox[baprs]-/.test(value) || /-----BEGIN /.test(value) || /DATABASE_URL\s*=/.test(value) ||
  /(?:api[\s_-]*key|secret|password|token)\s*[:=]\s*\S{8,}/i.test(value);
// Tomverse's published support mailbox is product copy, as in the owner intake
// (lib/amux/localIntakeCore.ts): only that exact address is set aside.
const PUBLIC_SUPPORT_EMAIL = /(?<![A-Za-z0-9._%+-])support@tomverse\.app(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi;
const personalData = (value: string) =>
  /(?<=[A-Za-z0-9._%+-])@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value.replace(PUBLIC_SUPPORT_EMAIL, " ")) ||
  /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/.test(value);
const absolutePath = (value: string) => /[A-Za-z]:\\/.test(value) ||
  /\\\\[A-Za-z0-9_.$-]+\\/.test(value) ||
  /(?:^|[\s"'\`(])\/(?:Users|home|opt|var|etc|private|root)\//.test(value);
const privateUrl = (value: string) => /file:\/\//i.test(value) || /\blocalhost\b/i.test(value) ||
  /\b127\.0\.0\.1\b/.test(value) || /\b0\.0\.0\.0\b/.test(value) || /\[::1\]/.test(value) ||
  /\.local\b/i.test(value) || /\b169\.254\.169\.254\b/.test(value) ||
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(value) ||
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(value) ||
  /\b172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}\b/.test(value);
const contentAdmitted = (value: string) => value.length > 0 && !controlCharacter(value) &&
  !secret(value) && !personalData(value) && !absolutePath(value) && !privateUrl(value);

/**
 * Intake v19 names exactly three source labels. They remain encrypted with the
 * idea body; this check rejects a missing label, an extra field or refused
 * content. The policy deliberately sets no intake byte ceiling here.
 */
export function inspectAmuxIdeaSessionSource(value: unknown):
  | { ok: true; source: AmuxIdeaSessionSource }
  | { ok: false; code: "source_invalid" } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ["toolName", "modelProvider", "sessionDisplay"])) {
    return { ok: false, code: "source_invalid" };
  }
  const source = value as Record<string, unknown>;
  if (typeof source.toolName !== "string" || source.toolName.trim().length === 0 ||
      typeof source.modelProvider !== "string" || source.modelProvider.trim().length === 0 ||
      typeof source.sessionDisplay !== "string" || source.sessionDisplay.trim().length === 0 ||
      ![source.toolName, source.modelProvider, source.sessionDisplay].every(contentAdmitted)) {
    return { ok: false, code: "source_invalid" };
  }
  return { ok: true, source: {
    toolName: source.toolName,
    modelProvider: source.modelProvider,
    sessionDisplay: source.sessionDisplay,
  } };
}

/**
 * v19 session intake deliberately has no policy byte or item-count ceiling.
 * This admits the same exact idea shape and content refusals as owner intake,
 * without importing the digest-pinned owner parser or inheriting its limits.
 */
function inspectAmuxIdeaSessionInputV1(value: unknown,
  enforceCurrentContentRules: boolean): AmuxIdeaSessionInputInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "schema_rejected" };
  }
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["version", "idea", "repositories", "pullRequests"]) ||
      candidate.version !== 1 || typeof candidate.idea !== "string" ||
      !Array.isArray(candidate.repositories) || !Array.isArray(candidate.pullRequests)) {
    return { ok: false, code: "schema_rejected" };
  }
  const idea = candidate.idea.trim();
  if (idea.length === 0) return { ok: false, code: "metadata_incomplete" };
  if (enforceCurrentContentRules && !contentAdmitted(idea)) {
    return { ok: false, code: "content_refused" };
  }
  if (!candidate.repositories.every((entry): entry is string =>
    typeof entry === "string" && validRepository(entry)) ||
      new Set(candidate.repositories.map((entry) => entry.toLowerCase())).size !== candidate.repositories.length) {
    return { ok: false, code: "schema_rejected" };
  }
  const pullRequests: IdeaInput["pullRequests"] = [];
  for (const pull of candidate.pullRequests) {
    if (!pull || typeof pull !== "object" || Array.isArray(pull) ||
        !exactKeys(pull as Record<string, unknown>, ["repository", "number"])) {
      return { ok: false, code: "schema_rejected" };
    }
    const item = pull as Record<string, unknown>;
    if (typeof item.repository !== "string" || !validRepository(item.repository) ||
        !Number.isSafeInteger(item.number) || (item.number as number) <= 0) {
      return { ok: false, code: "schema_rejected" };
    }
    pullRequests.push({ repository: item.repository, number: item.number as number });
  }
  if (new Set(pullRequests.map((item) => `${item.repository.toLowerCase()}#${item.number}`)).size !==
      pullRequests.length) return { ok: false, code: "schema_rejected" };
  return { ok: true,
    input: { version: 1, idea, repositories: candidate.repositories, pullRequests },
    counts: { ideaBytes: Buffer.byteLength(idea, "utf8"),
      repositoryCount: candidate.repositories.length, pullRequestCount: pullRequests.length } };
}

export function inspectAmuxIdeaSessionInput(value: unknown): AmuxIdeaSessionInputInspection {
  return inspectAmuxIdeaSessionInputV1(value, true);
}

/** A sealed, digest-verified v19 body keeps its intake-time content decision.
 * New refusal patterns must not retroactively hide a previously accepted
 * checkout target. Only the immutable v1 structure is checked here. */
export function inspectSealedAmuxIdeaSessionInput(value: unknown): AmuxIdeaSessionInputInspection {
  return inspectAmuxIdeaSessionInputV1(value, false);
}

/** The page a session-written plan is checked as: the first page of a session
 * analysis, which is exactly the context the plan writer gives it (one
 * operator idea, no history, no inherited references). */
const SESSION_PLAN_PAGE = { chunkIndex: 0, permittedTargetRefs: [], history: [] } as const;

export type AmuxIdeaSessionPlanInspection =
  | { ok: true; plan: AmuxIdeaSessionPlan }
  | { ok: false; code: "content_refused" }
  | { ok: false; code: "plan_rejected";
      /** not_a_proposal: no card or node to approve; continues: the plan names
       * unfinished cards, which a session plan must include itself. */
      reason: "schema" | "not_a_proposal" | "continues";
      detail?: ReturnType<typeof amuxSessionPageRefusalDetail> };

const planStrings = (value: unknown, found: string[] = []): string[] => {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => planStrings(entry, found));
  else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) => planStrings(entry, found));
  }
  return found;
};

/**
 * A session-written plan passes the same checks a box analysis answer meets:
 * the intake's content refusals on every text it holds, then the session plan
 * writer's own parser on the first page (ideaAnalysisContinuationCore.ts, with
 * the session page bookkeeping derived the same way). It must close the plan:
 * a proposal with at least one unit and no remainder. `previewId` only fills
 * the derived header; the verdict does not depend on it.
 */
export function inspectAmuxIdeaSessionPlan(value: unknown,
  previewId: string): AmuxIdeaSessionPlanInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "plan_rejected", reason: "schema" };
  }
  if (!planStrings(value).every((text) => text.length === 0 || contentAdmitted(text))) {
    return { ok: false, code: "content_refused" };
  }
  const raw = JSON.stringify(value);
  const page = { ...SESSION_PLAN_PAGE, previewId };
  const inspected = inspectAmuxAnalysisContinuation({
    raw, expectedPreviewId: previewId, expectedChunkIndex: 0,
    expectedRevisionChunkIndex: 0, permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: [], sourceUnitCount: 1, coveredStartOrdinal: 0,
    coveredEndOrdinal: 0, history: [], templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
    sessionPage: true,
  });
  if (!inspected.ok) {
    return { ok: false, code: "plan_rejected", reason: "schema",
      detail: amuxSessionPageRefusalDetail(raw, page) };
  }
  const { chunk } = inspected.parsed;
  if (chunk.outcome !== "propose" ||
      !chunk.units.some((unit) => unit.kind !== "evidence")) {
    return { ok: false, code: "plan_rejected", reason: "not_a_proposal" };
  }
  if (inspected.cursor.nextCursor !== null) {
    return { ok: false, code: "plan_rejected", reason: "continues" };
  }
  return { ok: true, plan: { raw, unitCount: chunk.units.length } };
}

export function inspectAmuxIdeaSessionSubmission(value: unknown): AmuxIdeaSessionSubmissionInspection {
  const keys = ["version", "requestId", "input", "source"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>,
        Object.hasOwn(value, "plan") ? [...keys, "plan"] : keys)) {
    return { ok: false, code: "schema_rejected" };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.requestId !== "string" ||
      !isAmuxIdeaRequestId(record.requestId)) {
    return { ok: false, code: "schema_rejected" };
  }
  const source = inspectAmuxIdeaSessionSource(record.source);
  if (!source.ok) return { ok: false, code: "schema_rejected" };
  const inspected = inspectAmuxIdeaSessionInput(record.input);
  if (!inspected.ok) return inspected;
  if (!Object.hasOwn(record, "plan")) {
    return { ...inspected, requestId: record.requestId, source: source.source };
  }
  const plan = inspectAmuxIdeaSessionPlan(record.plan, record.requestId);
  if (!plan.ok) return { ok: false, code: plan.code };
  return { ...inspected, requestId: record.requestId, source: source.source, plan: plan.plan };
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * The owner's optional per-idea model choice (owner decision 2026-10-23). An
 * absent choice keeps the operating scope's model; a present one must be an
 * exact selection, and the service still checks it against the approved
 * Frontier catalog and an approved subscription price before anything is
 * written. Coding sessions never send one.
 */
export function inspectAmuxSessionModelChoice(value: unknown):
  | { ok: true; model: AmuxIdeaModelSelection | null }
  | { ok: false } {
  if (value === undefined || value === null) return { ok: true, model: null };
  if (typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ["provider", "modelId", "reasoningEffort"])) {
    return { ok: false };
  }
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || !isAmuxIdeaAnalysisProvider(model.provider) ||
      typeof model.modelId !== "string" || !MODEL_ID.test(model.modelId) ||
      typeof model.reasoningEffort !== "string" || !EFFORTS.includes(model.reasoningEffort)) {
    return { ok: false };
  }
  return { ok: true, model: { provider: model.provider, modelId: model.modelId,
    reasoningEffort: model.reasoningEffort } };
}

export const sameAmuxOperatingScopeAuthority = (
  left: AmuxOperatingScopeAuthority,
  right: AmuxOperatingScopeAuthority,
) =>
  left.settingId === right.settingId &&
  left.version === right.version &&
  left.approvedByUserId === right.approvedByUserId &&
  JSON.stringify(left.scope) === JSON.stringify(right.scope);
