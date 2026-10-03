import { isFrontierApprovalId } from "./ideaFrontierCatalogWriteCore.ts";
import { inspectAmuxIdeaInput, type IdeaInput } from "./ideaInputCore.ts";
import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";
import { inspectAmuxIdeaSourceScope, type IdeaSourceFile,
  type IdeaSourceScopeProposal } from "./ideaSourceScopeCore.ts";

/** Dark contract only. Neither inspection creates a DB row nor reads GitHub. */
export const AMUX_V4_COLLECTION_REQUEST_MAX_BYTES = 1_024;
export const AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT = 8_192;
export const AMUX_V4_COLLECTION_FIRST_ATTEMPT = 1;

export type AmuxIdeaCollectionRequestInput = {
  schemaVersion: 1;
  requestId: string;
  previewId: string;
  ideaId: string;
  scopeApprovalId: string;
  frontierApprovalId: string;
  frontierVersion: number;
  provider: "openai" | "anthropic";
  modelId: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sourceIndex: 0;
};

export type AmuxIdeaCollectionRequest = AmuxIdeaCollectionRequestInput & {
  attempt: typeof AMUX_V4_COLLECTION_FIRST_ATTEMPT;
  sourceByteLimit: typeof AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT;
};

const FIELDS = ["schemaVersion", "requestId", "previewId", "ideaId",
  "scopeApprovalId", "frontierApprovalId", "frontierVersion", "provider",
  "modelId", "reasoningEffort", "sourceIndex"] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

/** This checks syntax only; the writer must check both approval rows and their
 * current state under its own authority. DB unique constraints enforce global
 * requestId/previewId uniqueness, including ambiguous-response read-back. */
export function inspectAmuxIdeaCollectionRequestInput(raw: string):
  | { ok: true; request: AmuxIdeaCollectionRequest }
  | { ok: false; code: "schema_rejected" | "too_large" } {
  if (typeof raw !== "string") return { ok: false, code: "schema_rejected" };
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_COLLECTION_REQUEST_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "schema_rejected" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.hasOwn(value, field)) ||
      value.schemaVersion !== 1 ||
      typeof value.requestId !== "string" || !isAmuxIdeaRequestId(value.requestId) ||
      typeof value.previewId !== "string" || !isAmuxIdeaRequestId(value.previewId) ||
      typeof value.ideaId !== "string" || !isAmuxIdeaRequestId(value.ideaId) ||
      typeof value.scopeApprovalId !== "string" || !isAmuxIdeaRequestId(value.scopeApprovalId) ||
      typeof value.frontierApprovalId !== "string" || !isFrontierApprovalId(value.frontierApprovalId) ||
      new Set([value.requestId, value.previewId, value.ideaId,
        value.scopeApprovalId, value.frontierApprovalId]).size !== 5 ||
      !Number.isSafeInteger(value.frontierVersion) || Number(value.frontierVersion) < 1 ||
      Number(value.frontierVersion) > 1_000_000_000 ||
      (value.provider !== "openai" && value.provider !== "anthropic") ||
      typeof value.modelId !== "string" || !MODEL_ID.test(value.modelId) ||
      typeof value.reasoningEffort !== "string" || !EFFORTS.has(value.reasoningEffort) ||
      value.sourceIndex !== 0) {
    return { ok: false, code: "schema_rejected" };
  }
  return { ok: true, request: {
    ...(value as AmuxIdeaCollectionRequestInput),
    attempt: AMUX_V4_COLLECTION_FIRST_ATTEMPT,
    sourceByteLimit: AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT,
  } };
}

/** A separately loaded owner-approved scope must be exact, canonical, and
 * contain one repository file. PR files and multi-file scopes remain closed. */
export function checkAmuxIdeaCollectionSource(
  request: AmuxIdeaCollectionRequest,
  expectedIdeaId: string,
  canonicalScopeJson: string,
  declaredIdea: IdeaInput,
):
  | { decision: "eligible"; source: Extract<IdeaSourceFile, { kind: "repository_file" }> }
  | { decision: "hold"; reason: "idea_unverified" | "scope_unverified" }
  | { decision: "reject"; reason: "source_selection_unsupported" } {
  if (!request || request.ideaId !== expectedIdeaId ||
      !isAmuxIdeaRequestId(expectedIdeaId)) {
    return { decision: "hold", reason: "idea_unverified" };
  }
  let ideaJson: string;
  try { ideaJson = JSON.stringify(declaredIdea); } catch {
    return { decision: "hold", reason: "idea_unverified" };
  }
  const idea = inspectAmuxIdeaInput(ideaJson);
  if (!idea.ok) return { decision: "hold", reason: "idea_unverified" };
  if (typeof canonicalScopeJson !== "string") {
    return { decision: "hold", reason: "scope_unverified" };
  }
  const scope = inspectAmuxIdeaSourceScope(canonicalScopeJson, idea.input);
  if (!scope.ok || scope.canonicalJson !== canonicalScopeJson) {
    return { decision: "hold", reason: "scope_unverified" };
  }
  const canonical = JSON.parse(scope.canonicalJson) as IdeaSourceScopeProposal;
  if (request.sourceIndex !== 0 || canonical.sources.length !== 1 ||
      canonical.sources[0].kind !== "repository_file") {
    return { decision: "reject", reason: "source_selection_unsupported" };
  }
  return { decision: "eligible", source: canonical.sources[0] };
}
