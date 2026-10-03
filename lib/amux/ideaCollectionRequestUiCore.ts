type Store = Pick<Storage, "getItem" | "setItem">;

export type CollectionRequestReceipt = {
  requestId: string;
  previewId: string;
  ideaId: string;
  scopeApprovalId: string;
  scopeDigest: string;
  frontierApprovalId: string;
  frontierVersion: number;
  provider: "openai" | "anthropic";
  modelId: string;
  reasoningEffort: string;
};

export type CollectionRequestRead =
  | { kind: "committed"; id: string; state: string; expiresAt: string }
  | { kind: "unresolved" };

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(["pending", "claimed", "preview_ready", "hold", "expired", "outcome_unknown"]);
const fields = ["requestId", "previewId", "ideaId", "scopeApprovalId", "scopeDigest",
  "frontierApprovalId", "frontierVersion", "provider", "modelId", "reasoningEffort"] as const;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const COLLECTION_REQUEST_EXPIRY_GRACE_MS = 5 * 60_000;
const keyFor = (operatorId: string, ideaId: string) =>
  `amux-v4-collection-request:${encodeURIComponent(operatorId)}:${ideaId}`;

function validReceipt(value: unknown): value is CollectionRequestReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === fields.length &&
    ["requestId", "previewId", "ideaId", "scopeApprovalId", "frontierApprovalId"]
      .every((field) => typeof row[field] === "string" && ID.test(row[field] as string)) &&
    new Set([row.requestId, row.previewId, row.ideaId,
      row.scopeApprovalId, row.frontierApprovalId]).size === 5 &&
    typeof row.scopeDigest === "string" && DIGEST.test(row.scopeDigest) &&
    Number.isSafeInteger(row.frontierVersion) && Number(row.frontierVersion) > 0 &&
    (row.provider === "openai" || row.provider === "anthropic") &&
    typeof row.modelId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.modelId) &&
    typeof row.reasoningEffort === "string" && EFFORTS.has(row.reasoningEffort);
}

/** The same-tab fence survives a lost POST response and a model/scope change. */
export function readCollectionRequestReceipt(store: Store | null, operatorId: string,
  ideaId: string): { kind: "absent" | "unavailable" } |
  { kind: "present"; receipt: CollectionRequestReceipt } {
  if (!store || !ID.test(ideaId)) return { kind: "unavailable" };
  try {
    const raw = store.getItem(keyFor(operatorId, ideaId));
    if (raw === null) return { kind: "absent" };
    const value: unknown = JSON.parse(raw);
    return validReceipt(value) && value.ideaId === ideaId
      ? { kind: "present", receipt: value } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

export function reserveCollectionRequestReceipt(store: Store | null, operatorId: string,
  receipt: CollectionRequestReceipt): boolean {
  if (!validReceipt(receipt) ||
      readCollectionRequestReceipt(store, operatorId, receipt.ideaId).kind !== "absent") return false;
  try {
    const key = keyFor(operatorId, receipt.ideaId);
    const raw = JSON.stringify(receipt);
    store?.setItem(key, raw);
    return store?.getItem(key) === raw;
  } catch { return false; }
}

/** Replace only a read-back-confirmed terminal request under a distinct owner
 * scope approval. An ambiguous request is never a retry instruction. */
export function replaceTerminalCollectionRequestReceipt(store: Store | null,
  operatorId: string, previous: CollectionRequestReceipt,
  verified: CollectionRequestRead, next: CollectionRequestReceipt,
  verifiedAtMs: number): boolean {
  if (!validReceipt(previous) || !validReceipt(next) ||
      !canReplaceTerminalCollectionRequest(previous, verified,
        next.scopeApprovalId, verifiedAtMs) ||
      previous.ideaId !== next.ideaId ||
      previous.requestId === next.requestId || previous.previewId === next.previewId) {
    return false;
  }
  const current = readCollectionRequestReceipt(store, operatorId, previous.ideaId);
  if (current.kind !== "present" ||
      !fields.every((field) => current.receipt[field] === previous[field])) return false;
  try {
    const key = keyFor(operatorId, previous.ideaId);
    const raw = JSON.stringify(next);
    store?.setItem(key, raw);
    return store?.getItem(key) === raw;
  } catch { return false; }
}

export function canReplaceTerminalCollectionRequest(previous: CollectionRequestReceipt,
  verified: CollectionRequestRead, nextScopeApprovalId: string,
  verifiedAtMs: number): boolean {
  if (!validReceipt(previous) || verified.kind !== "committed" ||
      !ID.test(nextScopeApprovalId) || previous.scopeApprovalId === nextScopeApprovalId ||
      !Number.isFinite(verifiedAtMs) ||
      !Number.isFinite(Date.parse(verified.expiresAt)) ||
      verified.state === "outcome_unknown") return false;
  return verified.state === "hold" ||
    verifiedAtMs >= Date.parse(verified.expiresAt) + COLLECTION_REQUEST_EXPIRY_GRACE_MS;
}

export function collectionPreviewDisplayDeadline(value: CollectionExactPreview): number | null {
  const expires = Date.parse(value.expiresAt);
  const purge = Date.parse(value.resultPurgeAfter);
  return Number.isFinite(expires) && Number.isFinite(purge) ? Math.min(expires, purge) : null;
}

export function formatCollectionTimestamp(value: string, locale: string,
  timeZone?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric",
    minute: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** Only a complete exact-ID response is shown as a recorded request. */
export function readCollectionRequestReply(status: number, body: unknown,
  receipt: CollectionRequestReceipt, mode: "write" | "read"): CollectionRequestRead {
  if (!validReceipt(receipt) || !body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "unresolved" };
  }
  const row = body as Record<string, unknown>;
  if ((mode === "write" ? status !== 201 : status !== 200) ||
      (mode === "read" && row.status !== "committed") ||
      row.requestId !== receipt.requestId || row.previewId !== receipt.previewId ||
      row.collectionVerified !== false || row.transferAuthorized !== false ||
      typeof row.id !== "string" || !ID.test(row.id) ||
      typeof row.state !== "string" || !STATES.has(row.state) ||
      typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt)) ||
      typeof row.requestDigest !== "string" || !DIGEST.test(row.requestDigest) ||
      typeof row.requestDigestKeyId !== "string" || !KEY_ID.test(row.requestDigestKeyId)) {
    return { kind: "unresolved" };
  }
  return { kind: "committed", id: row.id, state: row.state, expiresAt: row.expiresAt };
}

export type CollectionExactPreview = {
  promptVersion: string;
  prompt: string;
  model: { provider: string; modelId: string; reasoningEffort: string };
  source: { repository: string; refName: string; refObjectSha: string;
    refCommitSha: string; commitSha: string; path: string; blobSha: string;
    fileSha256: string; startByte: number; endByte: number };
  selectedSourceIndices: [0];
  unselectedSourceCount: 0;
  provenance: "collector_attested";
  resultDigest: string;
  resultDigestKeyId: string;
  expiresAt: string;
  resultPurgeAfter: string;
};

/** A display parser, never a transfer authorization. Source text is present
 * only inside the exact prompt; a caller must render that text as plain text. */
export function readCollectionExactPreview(status: number, body: unknown,
  receipt: CollectionRequestReceipt, collectionRequestId: string,
  expectedSource: { repository: string; commitSha: string; path: string }): CollectionExactPreview | null {
  if (status !== 200 || !validReceipt(receipt) || !ID.test(collectionRequestId) ||
      !body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  const model = row.model && typeof row.model === "object" && !Array.isArray(row.model)
    ? row.model as Record<string, unknown> : null;
  const source = row.source && typeof row.source === "object" && !Array.isArray(row.source)
    ? row.source as Record<string, unknown> : null;
  const sha = (value: unknown) => typeof value === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  const iso = (value: unknown) => typeof value === "string" &&
    Number.isFinite(Date.parse(value));
  if (row.collectionRequestId !== collectionRequestId ||
      row.requestId !== receipt.requestId || row.previewId !== receipt.previewId ||
      row.state !== "preview_ready" || row.collectionVerified !== false ||
      row.transferAuthorized !== false ||
      typeof row.promptVersion !== "string" || row.promptVersion.length === 0 ||
      row.promptVersion.length > 100 ||
      typeof row.prompt !== "string" || row.prompt.length === 0 || row.prompt.length > 32_000 ||
      !model || model.provider !== receipt.provider || model.modelId !== receipt.modelId ||
      model.reasoningEffort !== receipt.reasoningEffort ||
      !Array.isArray(row.selectedSourceIndices) || row.selectedSourceIndices.length !== 1 ||
      row.selectedSourceIndices[0] !== 0 || row.unselectedSourceCount !== 0 ||
      row.provenance !== "collector_attested" ||
      !source || source.sourceIndex !== 0 ||
      !Number.isSafeInteger(source.repositoryId) || Number(source.repositoryId) < 1 ||
      source.repository !== expectedSource.repository || source.repository.length > 200 ||
      typeof source.refName !== "string" || !source.refName.startsWith("refs/") ||
      !sha(source.refObjectSha) || !sha(source.refCommitSha) ||
      source.commitSha !== expectedSource.commitSha || !sha(source.commitSha) ||
      source.path !== expectedSource.path || source.path.length > 256 ||
      !sha(source.blobSha) || typeof source.fileSha256 !== "string" ||
      !DIGEST.test(source.fileSha256) || !Number.isSafeInteger(source.startByte) ||
      Number(source.startByte) < 0 || !Number.isSafeInteger(source.endByte) ||
      Number(source.endByte) <= Number(source.startByte) ||
      typeof row.resultDigest !== "string" || !DIGEST.test(row.resultDigest) ||
      typeof row.resultDigestKeyId !== "string" || !KEY_ID.test(row.resultDigestKeyId) ||
      !iso(row.expiresAt) || !iso(row.resultPurgeAfter)) return null;
  return {
    promptVersion: row.promptVersion, prompt: row.prompt,
    model: { provider: model.provider, modelId: model.modelId,
      reasoningEffort: model.reasoningEffort },
    source: { repository: source.repository, refName: source.refName,
      refObjectSha: source.refObjectSha, refCommitSha: source.refCommitSha,
      commitSha: source.commitSha, path: source.path, blobSha: source.blobSha,
      fileSha256: source.fileSha256, startByte: source.startByte, endByte: source.endByte },
    selectedSourceIndices: [0], unselectedSourceCount: 0,
    provenance: "collector_attested", resultDigest: row.resultDigest,
    resultDigestKeyId: row.resultDigestKeyId, expiresAt: row.expiresAt,
    resultPurgeAfter: row.resultPurgeAfter,
  } as CollectionExactPreview;
}

/** UI eligibility only. The server rechecks the decrypted approved scope. */
export function oneRepositoryFile(canonicalScopeJson: string):
  { repository: string; commitSha: string; path: string } | null {
  try {
    const value: unknown = JSON.parse(canonicalScopeJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const scope = value as Record<string, unknown>;
    if (scope.version !== 1 || !Array.isArray(scope.sources) || scope.sources.length !== 1) return null;
    const source = scope.sources[0] as Record<string, unknown> | null;
    return source?.kind === "repository_file" &&
      typeof source.repository === "string" && typeof source.commitSha === "string" &&
      typeof source.path === "string" ?
      { repository: source.repository, commitSha: source.commitSha, path: source.path } : null;
  } catch { return null; }
}
