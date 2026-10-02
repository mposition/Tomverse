import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";
import type { AvailableFrontierModel } from "./ideaFrontierCatalogUiCore.ts";

export type PreparedIdeaTransferPreview = {
  previewId: string;
  expiresAt: string;
  prompt: string;
  provider: string;
  modelId: string;
  reasoningEffort: string;
  payloadDigest: string;
  payloadDigestKeyId: string;
};

export function readPreparedIdeaTransferPreview(
  status: number, body: unknown, expectedPreviewId: string, expectedIdeaId: string,
  selected: AvailableFrontierModel, effort: string,
): PreparedIdeaTransferPreview | null {
  if ((status !== 200 && status !== 201) || !body || typeof body !== "object" ||
      Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.state !== "prepared" || reply.transferAuthorized !== false ||
      reply.previewId !== expectedPreviewId || typeof reply.expiresAt !== "string" ||
      typeof reply.payloadDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(reply.payloadDigest) ||
      typeof reply.payloadDigestKeyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(reply.payloadDigestKeyId) ||
      !Number.isFinite(Date.parse(reply.expiresAt)) ||
      Date.parse(reply.expiresAt) <= Date.now()) return null;
  const payload = reply.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const choice = record.selection;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
  const model = choice as Record<string, unknown>;
  if (record.version !== 1 || record.previewId !== expectedPreviewId ||
      record.ideaId !== expectedIdeaId ||
      record.templateVersion !== "amux-v4-analysis-prompt-v3" ||
      typeof record.prompt !== "string" || record.prompt.length === 0 ||
      new TextEncoder().encode(record.prompt).length > 65_536 ||
      model.provider !== selected.provider || model.modelId !== selected.modelId ||
      model.reasoningEffort !== effort || model.approvalId !== selected.approvalId ||
      model.approvalVersion !== selected.approvalVersion) return null;
  return { previewId: expectedPreviewId, expiresAt: reply.expiresAt,
    prompt: record.prompt, provider: selected.provider, modelId: selected.modelId,
    reasoningEffort: effort, payloadDigest: reply.payloadDigest,
    payloadDigestKeyId: reply.payloadDigestKeyId };
}

export function previewReceiptKey(operatorId: string, ideaId: string): string {
  return `amux-v4-transfer-preview:${operatorId}:${ideaId}`;
}

export function readPreviewReceipt(storage: Storage | null, operatorId: string, ideaId: string):
  { kind: "absent" } | { kind: "present"; previewId: string;
    model: AvailableFrontierModel; effort: string } | { kind: "unavailable" } {
  if (!storage || !isAmuxIdeaRequestId(ideaId)) return { kind: "unavailable" };
  try {
    const raw = storage.getItem(previewReceiptKey(operatorId, ideaId));
    if (raw === null) return { kind: "absent" };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unavailable" };
    const value = parsed as Record<string, unknown>;
    const model = value.model;
    if (Object.keys(value).length !== 4 || value.ideaId !== ideaId ||
        typeof value.previewId !== "string" || !isAmuxIdeaRequestId(value.previewId) ||
        typeof value.effort !== "string" ||
        !["low", "medium", "high", "xhigh", "max", "ultra"].includes(value.effort) ||
        !model || typeof model !== "object" || Array.isArray(model)) {
      return { kind: "unavailable" };
    }
    const row = model as Record<string, unknown>;
    if (Object.keys(row).length !== 4 ||
        typeof row.approvalId !== "string" || !isAmuxIdeaRequestId(row.approvalId) ||
        !Number.isSafeInteger(row.approvalVersion) || Number(row.approvalVersion) < 1 ||
        (row.provider !== "openai" && row.provider !== "anthropic") ||
        typeof row.modelId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.modelId)) {
      return { kind: "unavailable" };
    }
    return { kind: "present", previewId: value.previewId,
      model: { approvalId: row.approvalId, approvalVersion: row.approvalVersion as number,
        provider: row.provider, modelId: row.modelId, allowedEfforts: [value.effort] },
      effort: value.effort };
  } catch { return { kind: "unavailable" }; }
}

export function reservePreviewReceipt(
  storage: Storage | null, operatorId: string, ideaId: string, previewId: string,
  model: AvailableFrontierModel, effort: string,
): boolean {
  if (!storage || !isAmuxIdeaRequestId(ideaId) || !isAmuxIdeaRequestId(previewId) ||
      !model.allowedEfforts.includes(effort)) return false;
  try {
    if (storage.getItem(previewReceiptKey(operatorId, ideaId)) !== null) return false;
    const receipt = JSON.stringify({ ideaId, previewId,
      model: { approvalId: model.approvalId, approvalVersion: model.approvalVersion,
        provider: model.provider, modelId: model.modelId }, effort });
    storage.setItem(previewReceiptKey(operatorId, ideaId), receipt);
    return storage.getItem(previewReceiptKey(operatorId, ideaId)) ===
      receipt;
  } catch { return false; }
}

/** Replace only the receipt already checked by the operator. A rejected write
 * can restore the prior id so read-back remains possible. */
export function replacePreviewReceipt(
  storage: Storage | null, operatorId: string, ideaId: string,
  expectedPreviewId: string, previewId: string,
  model: AvailableFrontierModel, effort: string,
): boolean {
  if (!storage || !isAmuxIdeaRequestId(expectedPreviewId) ||
      !isAmuxIdeaRequestId(previewId) || expectedPreviewId === previewId ||
      !model.allowedEfforts.includes(effort)) return false;
  const current = readPreviewReceipt(storage, operatorId, ideaId);
  if (current.kind !== "present" || current.previewId !== expectedPreviewId) return false;
  try {
    const receipt = JSON.stringify({ ideaId, previewId,
      model: { approvalId: model.approvalId, approvalVersion: model.approvalVersion,
        provider: model.provider, modelId: model.modelId }, effort });
    storage.setItem(previewReceiptKey(operatorId, ideaId), receipt);
    return storage.getItem(previewReceiptKey(operatorId, ideaId)) === receipt;
  } catch { return false; }
}

/** Only a response known to precede the writer may release the same-tab fence. */
export function definitivePreviewPrewriteRefusal(status: number, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const { error, code } = body as Record<string, unknown>;
  if (status === 400) return error === "schema_rejected" || error === "too_large" ||
    code === "INVALID_JSON";
  if (status === 403) return error === "Forbidden.";
  if (status === 404) return error === "Not found." || error === "not_found";
  if (status === 413) return error === "too_large" || code === "REQUEST_BODY_TOO_LARGE";
  if (status === 415) return error === "content_type_refused";
  if (status === 428) return error === "ADMIN_REAUTHENTICATION_REQUIRED";
  if (status === 429) return code === "API_RATE_LIMITED";
  if (status === 409) return error === "not_ready" || error === "model_changed";
  return status === 503 && error === "preview_disabled";
}

/** Keep a readable response for the Admin error notice before consuming JSON.
 * A definite refusal must not fall through to ambiguous ID read-back merely
 * because its body was already consumed. */
export async function readPreviewWriteReply(response: Response): Promise<{
  body: unknown;
  refusalResponse: Response;
  definitiveRefusal: boolean;
}> {
  const refusalResponse = response.clone();
  const body: unknown = await response.json();
  return { body, refusalResponse,
    definitiveRefusal: definitivePreviewPrewriteRefusal(response.status, body) };
}

/** A generic 503 or lost response is never proof that the write did not land. */
export function clearRefusedPreviewReceipt(storage: Storage | null,
  operatorId: string, ideaId: string, expectedPreviewId: string): boolean {
  const current = readPreviewReceipt(storage, operatorId, ideaId);
  if (!storage || current.kind !== "present" || current.previewId !== expectedPreviewId) return false;
  try {
    const key = previewReceiptKey(operatorId, ideaId);
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch { return false; }
}
