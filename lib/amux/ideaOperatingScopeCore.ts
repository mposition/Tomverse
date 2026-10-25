import { AMUX_IDEA_ANALYSIS_PROVIDERS } from "./ideaAnalysisChannelCore.ts";
import type { AmuxIdeaModelSelection } from "./ideaFrontierSelectionCore.ts";

// The idea input's owner/name grammar (lib/amux/ideaInputCore.ts). It is
// repeated rather than imported because that module sits inside a reviewed,
// digest-pinned route closure; tests/amuxIdeaOperatingScopeCore.test.mjs
// proves the two agree.
const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
export const isAmuxScopeRepositoryName = (value: string) =>
  REPOSITORY.test(value) && value.split("/").every((part) => part !== "." && part !== "..");

/**
 * The owner's operating scope (docs/policy/amux-intake.md v19 item 2): the one
 * human approval under which ideas are analysed and registered without a
 * per-idea decision. Pure checks only; the single writer and its same-
 * transaction audit live in the store. The model is stored as a selection and
 * re-checked against the approved catalog each time it is used, so a revoked
 * approval stops intake instead of being remembered.
 */
export const AMUX_OPERATING_SCOPE_ACTION = "amux.idea.operating_scope.updated";
export const AMUX_OPERATING_SCOPE_TARGET = "AmuxIdeaOperatingScopeSetting";
export const AMUX_OPERATING_SCOPE_POLICY_VERSION = 19;
/** A structural bound on one setting row, not a limit on intake. */
export const AMUX_OPERATING_SCOPE_REPOSITORY_MAX = 64;

const PROVIDERS = AMUX_IDEA_ANALYSIS_PROVIDERS;
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type AmuxOperatingScope = {
  repositories: string[];
  model: { provider: (typeof PROVIDERS)[number]; modelId: string; reasoningEffort: (typeof EFFORTS)[number] };
};

export type AmuxOperatingScopeRefusal =
  | "scope_shape_invalid" | "repositories_invalid" | "repository_duplicate" | "model_invalid";

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

/**
 * Admits one proposed scope. Repository names keep the owner's spelling but are
 * ordered and compared case-insensitively, as GitHub resolves them.
 */
export function normalizeAmuxOperatingScope(value: unknown):
  | { ok: true; scope: AmuxOperatingScope }
  | { ok: false; code: AmuxOperatingScopeRefusal } {
  if (!exactKeys(value, ["repositories", "model"])) return { ok: false, code: "scope_shape_invalid" };
  const { repositories, model } = value;
  if (!Array.isArray(repositories) || repositories.length === 0 ||
      repositories.length > AMUX_OPERATING_SCOPE_REPOSITORY_MAX ||
      !repositories.every((entry) => typeof entry === "string" && isAmuxScopeRepositoryName(entry))) {
    return { ok: false, code: "repositories_invalid" };
  }
  const keys = repositories.map((entry: string) => entry.toLowerCase());
  if (new Set(keys).size !== keys.length) return { ok: false, code: "repository_duplicate" };
  if (!exactKeys(model, ["provider", "modelId", "reasoningEffort"]) ||
      !(PROVIDERS as readonly unknown[]).includes(model.provider) ||
      typeof model.modelId !== "string" || !MODEL_ID.test(model.modelId) ||
      !(EFFORTS as readonly unknown[]).includes(model.reasoningEffort)) {
    return { ok: false, code: "model_invalid" };
  }
  const ordered = [...(repositories as string[])].sort((left, right) =>
    left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0);
  return { ok: true, scope: { repositories: ordered,
    model: { provider: model.provider as AmuxOperatingScope["model"]["provider"], modelId: model.modelId,
      reasoningEffort: model.reasoningEffort as AmuxOperatingScope["model"]["reasoningEffort"] } } };
}

/** v19 item 2: a reference outside the allowlist is refused at intake. */
export function amuxRepositoryAllowed(scope: AmuxOperatingScope, repository: string): boolean {
  if (typeof repository !== "string" || !isAmuxScopeRepositoryName(repository)) return false;
  const key = repository.toLowerCase();
  return scope.repositories.some((entry) => entry.toLowerCase() === key);
}

/** Every repository an idea names, through its repository list or its pull requests. */
export function amuxIdeaReferencesOutsideScope(scope: AmuxOperatingScope, input: {
  repositories: readonly string[]; pullRequests: readonly { repository: string }[];
}): string[] {
  const named = [...input.repositories, ...input.pullRequests.map((pull) => pull.repository)];
  return [...new Set(named.filter((repository) => !amuxRepositoryAllowed(scope, repository)))];
}

/** The model the scope names, in the shape the approved-catalog check takes. */
export const amuxOperatingScopeSelection = (scope: AmuxOperatingScope): AmuxIdeaModelSelection => ({
  provider: scope.model.provider, modelId: scope.model.modelId, reasoningEffort: scope.model.reasoningEffort,
});

export type PendingAmuxOperatingScope = { id: string; expectedPreviousVersion: number; scope: AmuxOperatingScope };

/** The browser keeps one pending save so a lost answer is read back by its ID, never re-sent. */
export function readPendingAmuxOperatingScope(value: unknown): PendingAmuxOperatingScope | null {
  if (!exactKeys(value, ["id", "expectedPreviousVersion", "scope"])) return null;
  const version = value.expectedPreviousVersion;
  const scope = normalizeAmuxOperatingScope(value.scope);
  return typeof value.id === "string" && REQUEST_ID.test(value.id) &&
    Number.isSafeInteger(version) && (version as number) >= 0 && (version as number) < 2_147_483_647 &&
    scope.ok ? { id: value.id, expectedPreviousVersion: version as number, scope: scope.scope } : null;
}

/** A save answer counts only when it is exactly the pending request. */
export function amuxOperatingScopeSavedMatches(value: unknown, pending: PendingAmuxOperatingScope): boolean {
  if (!exactKeys(value, ["state", "id", "version", "scope", "auditId"])) return false;
  const saved = normalizeAmuxOperatingScope(value.scope);
  return value.state === "saved" && value.id === pending.id &&
    value.version === pending.expectedPreviousVersion + 1 &&
    typeof value.auditId === "string" && value.auditId.length > 0 && saved.ok &&
    JSON.stringify(saved.scope) === JSON.stringify(pending.scope);
}

export type AmuxOperatingScopeReply =
  | { state: "none"; version: 0 }
  | { state: "current"; version: number; scope: AmuxOperatingScope };

/** The Admin screen trusts only an exact, admissible GET answer. */
export function readAmuxOperatingScopeReply(value: unknown): AmuxOperatingScopeReply | null {
  if (exactKeys(value, ["state", "version"]) && value.state === "none" && value.version === 0) {
    return { state: "none", version: 0 };
  }
  if (!exactKeys(value, ["state", "version", "scope"]) || value.state !== "current" ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1) return null;
  const scope = normalizeAmuxOperatingScope(value.scope);
  return scope.ok ? { state: "current", version: value.version as number, scope: scope.scope } : null;
}

export type AmuxOperatingScopeSaveAnswer =
  | { kind: "saved" }
  | { kind: "refused"; notice: "changed" | "notApproved" | "invalid" | "refused" }
  | { kind: "unknown" };

/** Refusals the route answers before the writer runs: { error, retryWrite: false }. */
const STORE_REFUSALS: Record<string, { status: number; notice: "changed" | "notApproved" | "invalid" | "refused" }> = {
  forbidden: { status: 403, notice: "refused" },
  invalid_scope: { status: 400, notice: "invalid" },
  model_not_approved: { status: 409, notice: "notApproved" },
  revision_changed: { status: 409, notice: "changed" },
  request_already_seen: { status: 409, notice: "refused" },
  // Thrown only before the audit and the row are written (keys, catalog, stored row).
  scope_unavailable: { status: 503, notice: "refused" },
};
/** Security-layer refusals ({ error, code }) raised before the body reaches the writer. */
const SECURITY_REFUSALS: Record<string, number> = {
  API_RATE_LIMITED: 429, REQUEST_BODY_TOO_LARGE: 413, INVALID_JSON: 400, INVALID_REQUEST: 400,
};

/**
 * Classifies one save answer. Only an answer known to come before the write is
 * a refusal; anything else that is not the exact saved row (a lost, malformed
 * or 5xx answer) is unknown and may only be read back by the same ID.
 */
export function classifyAmuxOperatingScopeSaveAnswer(status: number, body: unknown,
  pending: PendingAmuxOperatingScope): AmuxOperatingScopeSaveAnswer {
  if (status === 201) return amuxOperatingScopeSavedMatches(body, pending) ? { kind: "saved" } : { kind: "unknown" };
  const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const store = typeof row.error === "string" && Object.hasOwn(STORE_REFUSALS, row.error)
    ? STORE_REFUSALS[row.error] : null;
  if (store && store.status === status && row.retryWrite === false) return { kind: "refused", notice: store.notice };
  if (status === 428 && row.error === "ADMIN_REAUTHENTICATION_REQUIRED") return { kind: "refused", notice: "refused" };
  if (typeof row.code === "string" && Object.hasOwn(SECURITY_REFUSALS, row.code) &&
      SECURITY_REFUSALS[row.code] === status) return { kind: "refused", notice: "refused" };
  return { kind: "unknown" };
}
