import type { IdeaInput } from "./ideaInputCore.ts";
import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";
import type { AmuxOperatingScopeAuthority } from "./ideaOperatingScopeStore.ts";

export const AMUX_SESSION_INTAKE_ENV = "TOMVERSE_AMUX_SESSION_INTAKE";
export const AMUX_SESSION_INTAKE_CODE_LATCH = true;

export const amuxSessionIntakeWritePermitted = (
  sessionSwitch: string | undefined,
  existingIntakeSwitch: string | undefined,
) =>
  AMUX_SESSION_INTAKE_CODE_LATCH &&
  sessionSwitch === "enabled" &&
  existingIntakeSwitch === "enabled";

export type AmuxIdeaSessionSource = {
  toolName: string;
  modelProvider: string;
  sessionDisplay: string;
};

export type AmuxIdeaSessionSubmissionInspection =
  | { ok: true; requestId: string; input: IdeaInput; source: AmuxIdeaSessionSource;
      counts: { ideaBytes: number; repositoryCount: number; pullRequestCount: number } }
  | { ok: false; code: "schema_rejected" | "content_refused" | "metadata_incomplete" };

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
const personalData = (value: string) =>
  /(?<=[A-Za-z0-9._%+-])@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value) ||
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

export function inspectAmuxIdeaSessionSubmission(value: unknown): AmuxIdeaSessionSubmissionInspection {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ["version", "requestId", "input", "source"])) {
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
  return { ...inspected, requestId: record.requestId, source: source.source };
}

export const sameAmuxOperatingScopeAuthority = (
  left: AmuxOperatingScopeAuthority,
  right: AmuxOperatingScopeAuthority,
) =>
  left.settingId === right.settingId &&
  left.version === right.version &&
  left.approvedByUserId === right.approvedByUserId &&
  JSON.stringify(left.scope) === JSON.stringify(right.scope);
