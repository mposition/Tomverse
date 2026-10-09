import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";
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
  selected: AvailableFrontierModel, effort: string, chunkIndex = 0,
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
  if (record.version !== (chunkIndex === 0 ? 1 : 2) ||
      (chunkIndex > 0 && record.chunkIndex !== chunkIndex) ||
      record.previewId !== expectedPreviewId ||
      record.ideaId !== expectedIdeaId ||
      record.templateVersion !== "amux-v4-analysis-prompt-v4" ||
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

export function previewReceiptKey(operatorId: string, ideaId: string,
  chunkIndex = 0): string {
  return `amux-v4-transfer-preview:${operatorId}:${ideaId}` +
    (chunkIndex > 0 ? `:${chunkIndex}` : "");
}

export function readPreviewReceipt(storage: Storage | null, operatorId: string,
  ideaId: string, chunkIndex = 0):
  { kind: "absent" } | { kind: "present"; previewId: string;
    model: AvailableFrontierModel; effort: string } | { kind: "unavailable" } {
  if (!storage || !isAmuxIdeaRequestId(ideaId)) return { kind: "unavailable" };
  try {
    const raw = storage.getItem(previewReceiptKey(operatorId, ideaId, chunkIndex));
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
  model: AvailableFrontierModel, effort: string, chunkIndex = 0,
): boolean {
  if (!storage || !isAmuxIdeaRequestId(ideaId) || !isAmuxIdeaRequestId(previewId) ||
      !model.allowedEfforts.includes(effort)) return false;
  try {
    if (storage.getItem(previewReceiptKey(operatorId, ideaId, chunkIndex)) !== null) return false;
    const receipt = JSON.stringify({ ideaId, previewId,
      model: { approvalId: model.approvalId, approvalVersion: model.approvalVersion,
        provider: model.provider, modelId: model.modelId }, effort });
    storage.setItem(previewReceiptKey(operatorId, ideaId, chunkIndex), receipt);
    return storage.getItem(previewReceiptKey(operatorId, ideaId, chunkIndex)) ===
      receipt;
  } catch { return false; }
}
