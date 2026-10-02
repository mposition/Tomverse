import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

/** Code remains dark: writing even a scope decision needs the separate v4
 * staging-write approval. This approval does not collect GitHub bytes. */
export const AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE_ENV =
  "TOMVERSE_AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE";
export const AMUX_V4_SOURCE_SCOPE_APPROVAL_READ_ENV =
  "TOMVERSE_AMUX_V4_SOURCE_SCOPE_APPROVAL_READ";
export const AMUX_V4_SOURCE_SCOPE_APPROVAL_CODE_ENABLED = false;
export const AMUX_V4_SOURCE_SCOPE_APPROVAL_MAX_BYTES = 20 * 1024;

export type AmuxSourceScopeApprovalRequest = {
  schemaVersion: 1;
  approvalId: string;
  ideaId: string;
  ideaDigest: string;
  canonicalScopeJson: string;
  scopeDigest: string;
  scopeDigestKeyId: string;
};

const DIGEST = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_KEYS = ["schemaVersion", "approvalId", "ideaId", "ideaDigest",
  "canonicalScopeJson", "scopeDigest", "scopeDigestKeyId"];

export const sourceScopeApprovalWritePermitted = (value: string | undefined): boolean =>
  AMUX_V4_SOURCE_SCOPE_APPROVAL_CODE_ENABLED && value === "enabled";
export const sourceScopeApprovalReadPermitted = (value: string | undefined): boolean =>
  AMUX_V4_SOURCE_SCOPE_APPROVAL_CODE_ENABLED && value === "enabled";

export function inspectAmuxSourceScopeApprovalRequest(raw: string):
  | { ok: true; request: AmuxSourceScopeApprovalRequest }
  | { ok: false; code: "schema_rejected" | "too_large" } {
  if (typeof raw !== "string") return { ok: false, code: "schema_rejected" };
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_SOURCE_SCOPE_APPROVAL_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "schema_rejected" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== REQUEST_KEYS.length ||
      !REQUEST_KEYS.every((key) => Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 ||
      typeof value.approvalId !== "string" || !isAmuxIdeaRequestId(value.approvalId) ||
      typeof value.ideaId !== "string" || !isAmuxIdeaRequestId(value.ideaId) ||
      typeof value.ideaDigest !== "string" || !DIGEST.test(value.ideaDigest) ||
      typeof value.scopeDigest !== "string" || !DIGEST.test(value.scopeDigest) ||
      typeof value.scopeDigestKeyId !== "string" || !KEY_ID.test(value.scopeDigestKeyId) ||
      typeof value.canonicalScopeJson !== "string" ||
      Buffer.byteLength(value.canonicalScopeJson, "utf8") > 16 * 1024) {
    return { ok: false, code: "schema_rejected" };
  }
  return { ok: true, request: value as AmuxSourceScopeApprovalRequest };
}
