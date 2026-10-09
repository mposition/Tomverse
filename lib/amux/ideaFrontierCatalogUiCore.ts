export type AvailableFrontierModel = {
  approvalId: string;
  approvalVersion: number;
  provider: "openai" | "anthropic";
  modelId: string;
  allowedEfforts: string[];
};

export type CheckedFrontierSelection = { approvalId: string; approvalVersion: number };

export type PendingFrontierCatalogApproval = {
  approvalId: string;
  provider: "openai" | "anthropic";
  modelId: string;
  allowedEfforts: string[];
  expectedPreviousVersion: number;
};

export type FrontierCatalogApprovalObservation =
  | { state: "found"; status: "approved" | "revoked"; approvalVersion: number }
  | { state: "not_visible" };

type FrontierRegistrationStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const APPROVAL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const AUDIT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const REGISTRATION_RECEIPT_PREFIX = "amux-v4-frontier-registration:";

const exactEfforts = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual) && actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const validPendingApproval = (expected: PendingFrontierCatalogApproval): boolean =>
  APPROVAL_ID.test(expected.approvalId) &&
  (expected.provider === "openai" || expected.provider === "anthropic") &&
  MODEL_ID.test(expected.modelId) &&
  expected.allowedEfforts.length > 0 && expected.allowedEfforts.length <= EFFORTS.size &&
  expected.allowedEfforts.every((value) => EFFORTS.has(value)) &&
  new Set(expected.allowedEfforts).size === expected.allowedEfforts.length &&
  Number.isSafeInteger(expected.expectedPreviousVersion) &&
  expected.expectedPreviousVersion >= 0 && expected.expectedPreviousVersion <= 999_999_999;

const registrationReceiptKey = (operatorId: string): string =>
  `${REGISTRATION_RECEIPT_PREFIX}${encodeURIComponent(operatorId)}`;

/** The receipt carries only the exact catalog selection needed for read-back.
 * Its actor-bound key and value prevent one Admin session using another's ID. */
export function readFrontierRegistrationReceipt(
  store: FrontierRegistrationStore | null,
  operatorId: string,
): { kind: "absent" } | { kind: "present"; registration: PendingFrontierCatalogApproval } |
   { kind: "unavailable" } {
  if (!store || operatorId.length === 0) return { kind: "unavailable" };
  try {
    const raw = store.getItem(registrationReceiptKey(operatorId));
    if (raw === null) return { kind: "absent" };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unavailable" };
    }
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== 6 || value.operatorId !== operatorId ||
        typeof value.approvalId !== "string" ||
        (value.provider !== "openai" && value.provider !== "anthropic") ||
        typeof value.modelId !== "string" || !Array.isArray(value.allowedEfforts) ||
        !Number.isSafeInteger(value.expectedPreviousVersion)) {
      return { kind: "unavailable" };
    }
    const registration: PendingFrontierCatalogApproval = {
      approvalId: value.approvalId,
      provider: value.provider,
      modelId: value.modelId,
      allowedEfforts: [...value.allowedEfforts] as string[],
      expectedPreviousVersion: value.expectedPreviousVersion as number,
    };
    return validPendingApproval(registration)
      ? { kind: "present", registration } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Persist before POST and never replace an unresolved approval ID. */
export function reserveFrontierRegistrationReceipt(
  store: FrontierRegistrationStore | null,
  operatorId: string,
  registration: PendingFrontierCatalogApproval,
): boolean {
  if (!store || operatorId.length === 0 || !validPendingApproval(registration)) return false;
  const key = registrationReceiptKey(operatorId);
  try {
    if (store.getItem(key) !== null) return false;
    const receipt = JSON.stringify({ operatorId, ...registration });
    store.setItem(key, receipt);
    return store.getItem(key) === receipt;
  } catch {
    return false;
  }
}

/** Clear only after the exact ID has a known stored outcome. */
export function clearFrontierRegistrationReceipt(
  store: FrontierRegistrationStore | null,
  operatorId: string,
  approvalId: string,
): void {
  try {
    const receipt = readFrontierRegistrationReceipt(store, operatorId);
    if (receipt.kind === "present" && receipt.registration.approvalId === approvalId) {
      store?.removeItem(registrationReceiptKey(operatorId));
    }
  } catch {
    // A leftover receipt safely forces the same exact-ID read-back next time.
  }
}

/** Malformed or transfer-authorizing replies never become visible model choices. */
export function readAvailableFrontierModels(status: number, body: unknown): AvailableFrontierModel[] | null {
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.state !== "available" || reply.transferAuthorized !== false || !Array.isArray(reply.models) ||
      reply.models.length > 256) return null;
  const models: AvailableFrontierModel[] = [];
  const seen = new Set<string>();
  for (const value of reply.models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.approvalId !== "string" || !APPROVAL_ID.test(row.approvalId) ||
        seen.has(row.approvalId) || !Number.isSafeInteger(row.approvalVersion) ||
        Number(row.approvalVersion) < 1 || (row.provider !== "openai" && row.provider !== "anthropic") ||
        typeof row.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.modelId) ||
        !Array.isArray(row.allowedEfforts) || row.allowedEfforts.length === 0 ||
        row.allowedEfforts.length > EFFORTS.size ||
        row.allowedEfforts.some((effort) => typeof effort !== "string" || !EFFORTS.has(effort)) ||
        new Set(row.allowedEfforts).size !== row.allowedEfforts.length) return null;
    seen.add(row.approvalId);
    models.push({ approvalId: row.approvalId, approvalVersion: row.approvalVersion as number,
      provider: row.provider, modelId: row.modelId, allowedEfforts: [...row.allowedEfforts] as string[] });
  }
  return models;
}

/** A check is a current observation only, never a transfer receipt. */
export function readCheckedFrontierSelection(
  status: number,
  body: unknown,
  selected: AvailableFrontierModel,
): CheckedFrontierSelection | null {
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.state !== "current" || reply.transferAuthorized !== false ||
      reply.approvalId !== selected.approvalId ||
      reply.approvalVersion !== selected.approvalVersion) return null;
  return { approvalId: selected.approvalId, approvalVersion: selected.approvalVersion };
}

/** A write response is accepted only for the exact owner-authored request ID
 * and the next expected model revision. Malformed success is outcome unknown. */
export function readFrontierCatalogApprovalWrite(
  status: number,
  body: unknown,
  expected: PendingFrontierCatalogApproval,
): FrontierCatalogApprovalObservation | null {
  if (status !== 201 || !validPendingApproval(expected) || !body ||
      typeof body !== "object" || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.approvalId !== expected.approvalId || reply.status !== "approved" ||
      reply.version !== expected.expectedPreviousVersion + 1 ||
      typeof reply.auditId !== "string" || !AUDIT_ID.test(reply.auditId)) return null;
  return { state: "found", status: "approved",
    approvalVersion: expected.expectedPreviousVersion + 1 };
}

/** Exact-ID read-back never turns absence into permission to submit again. */
export function readFrontierCatalogApprovalReadBack(
  status: number,
  body: unknown,
  expected: PendingFrontierCatalogApproval,
): FrontierCatalogApprovalObservation | null {
  if (status !== 200 || !validPendingApproval(expected) || !body ||
      typeof body !== "object" || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.retryWrite !== false) return null;
  if (reply.state === "not_visible") return { state: "not_visible" };
  if (reply.state !== "found" || !reply.approval ||
      typeof reply.approval !== "object" || Array.isArray(reply.approval)) return null;
  const approval = reply.approval as Record<string, unknown>;
  if (approval.id !== expected.approvalId || approval.provider !== expected.provider ||
      approval.modelId !== expected.modelId ||
      !exactEfforts(approval.allowedEfforts, expected.allowedEfforts) ||
      approval.version !== expected.expectedPreviousVersion + 1 ||
      (approval.status !== "approved" && approval.status !== "revoked")) return null;
  return { state: "found", status: approval.status,
    approvalVersion: expected.expectedPreviousVersion + 1 };
}
