import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

export type ScopeApprovalBinding = {
  approvalId: string;
  ideaId: string;
  ideaDigest: string;
  previewScopeDigest: string;
  previewScopeDigestKeyId: string;
};

type Reply = { status: number; body: unknown };
export type ScopeApprovalDecision =
  | { kind: "approved"; expiresAt: string }
  | { kind: "expired" }
  | { kind: "refused"; code: string }
  | { kind: "outcome_unknown" };

const digest = /^[a-f0-9]{64}$/;
const keyId = /^[A-Za-z0-9_-]{1,64}$/;
const refusalStatuses = new Set([400, 403, 404, 409, 413, 415, 428, 429]);

export function classifySourceScopeApprovalReply(reply: Reply,
  expected: ScopeApprovalBinding, mode: "write" | "read"): ScopeApprovalDecision {
  const body = reply.body && typeof reply.body === "object" && !Array.isArray(reply.body)
    ? reply.body as Record<string, unknown> : null;
  const sameBinding = body?.approvalId === expected.approvalId &&
    body.ideaId === expected.ideaId && body.ideaDigest === expected.ideaDigest &&
    body.previewScopeDigest === expected.previewScopeDigest &&
    body.previewScopeDigestKeyId === expected.previewScopeDigestKeyId &&
    body.collectionVerified === false && body.transferAuthorized === false;
  if ((reply.status === 200 || reply.status === 201) && sameBinding &&
      body?.state === "approved" && typeof body.expiresAt === "string" &&
      Number.isFinite(Date.parse(body.expiresAt)) &&
      typeof body.scopeDigest === "string" && digest.test(body.scopeDigest) &&
      typeof body.scopeDigestKeyId === "string" && keyId.test(body.scopeDigestKeyId)) {
    return { kind: "approved", expiresAt: body.expiresAt };
  }
  if (reply.status === 200 && sameBinding && body?.state === "expired") {
    return { kind: "expired" };
  }
  // A duplicate ID may already have committed. Never release its browser fence.
  if (body?.error === "approval_exists") return { kind: "outcome_unknown" };
  if (mode === "write" && refusalStatuses.has(reply.status) && typeof body?.error === "string" &&
      /^[a-zA-Z0-9_]{1,64}$/.test(body.error)) {
    return { kind: "refused", code: body.error };
  }
  if (mode === "write" && reply.status === 503 && body &&
      ["approval_disabled", "integrity_unavailable"].includes(String(body?.error)) &&
      body.collectionVerified === false && body.transferAuthorized === false) {
    return { kind: "refused", code: body.error as string };
  }
  return { kind: "outcome_unknown" };
}

const attemptKey = (operatorId: string, ideaId: string, previewScopeDigest: string): string =>
  `amux-v4-source-scope-approval:${operatorId}:${ideaId}:${previewScopeDigest}`;

function valid(binding: ScopeApprovalBinding): boolean {
  return isAmuxIdeaRequestId(binding.approvalId) &&
    isAmuxIdeaRequestId(binding.ideaId) &&
    digest.test(binding.ideaDigest) && digest.test(binding.previewScopeDigest) &&
    keyId.test(binding.previewScopeDigestKeyId);
}

/** The same-tab fence is written before POST; ambiguity permits read-back only. */
export function readSourceScopeApprovalAttempt(storage: Storage | null, operatorId: string,
  expected: Omit<ScopeApprovalBinding, "approvalId">):
  | { kind: "absent" | "unavailable" }
  | { kind: "present"; binding: ScopeApprovalBinding } {
  if (!storage || !isAmuxIdeaRequestId(expected.ideaId) ||
      !digest.test(expected.ideaDigest) || !digest.test(expected.previewScopeDigest) ||
      !keyId.test(expected.previewScopeDigestKeyId)) return { kind: "unavailable" };
  try {
    const raw = storage.getItem(attemptKey(operatorId, expected.ideaId,
      expected.previewScopeDigest));
    if (raw === null) return { kind: "absent" };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unavailable" };
    }
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== 5 ||
        !["approvalId", "ideaId", "ideaDigest", "previewScopeDigest",
          "previewScopeDigestKeyId"].every((field) => Object.hasOwn(value, field)) ||
        typeof value.approvalId !== "string" ||
        typeof value.ideaId !== "string" ||
        typeof value.ideaDigest !== "string" ||
        typeof value.previewScopeDigest !== "string" ||
        typeof value.previewScopeDigestKeyId !== "string") {
      return { kind: "unavailable" };
    }
    const binding = value as ScopeApprovalBinding;
    return valid(binding) && binding.ideaId === expected.ideaId &&
      binding.ideaDigest === expected.ideaDigest &&
      binding.previewScopeDigest === expected.previewScopeDigest &&
      binding.previewScopeDigestKeyId === expected.previewScopeDigestKeyId
      ? { kind: "present", binding } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

export function reserveSourceScopeApprovalAttempt(storage: Storage | null, operatorId: string,
  binding: ScopeApprovalBinding): boolean {
  if (!storage || !valid(binding) ||
      readSourceScopeApprovalAttempt(storage, operatorId, binding).kind !== "absent") {
    return false;
  }
  try {
    const key = attemptKey(operatorId, binding.ideaId, binding.previewScopeDigest);
    const value = JSON.stringify(binding);
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch { return false; }
}

/** Only a proven non-write or expired row releases the local fence. */
export function clearSourceScopeApprovalAttempt(storage: Storage | null, operatorId: string,
  binding: ScopeApprovalBinding): boolean {
  if (!storage || !valid(binding)) return false;
  const current = readSourceScopeApprovalAttempt(storage, operatorId, binding);
  if (current.kind !== "present" || current.binding.approvalId !== binding.approvalId) {
    return false;
  }
  try {
    const key = attemptKey(operatorId, binding.ideaId, binding.previewScopeDigest);
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch { return false; }
}
