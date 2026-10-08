import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";

export type ConfirmedIdeaTransfer = {
  previewId: string;
  ideaId: string;
  payloadDigest: string;
  payloadDigestKeyId: string;
  confirmExpiresAt: string;
};

/** A response only reports the human decision. It is never evidence of a model call. */
export function readConfirmedIdeaTransfer(status: number, body: unknown,
  expectedPreviewId: string, expectedIdeaId: string,
  expectedDigest: string, expectedDigestKeyId: string): ConfirmedIdeaTransfer | null {
  if (!isAmuxIdeaRequestId(expectedPreviewId) || !isAmuxIdeaRequestId(expectedIdeaId) ||
      !/^[a-f0-9]{64}$/.test(expectedDigest) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(expectedDigestKeyId) ||
      (status !== 200 && status !== 201) ||
      !body || typeof body !== "object" || Array.isArray(body)) return null;
  const result = body as Record<string, unknown>;
  if (result.state !== "confirmed" || result.previewId !== expectedPreviewId ||
      result.ideaId !== expectedIdeaId ||
      result.payloadDigest !== expectedDigest ||
      result.payloadDigestKeyId !== expectedDigestKeyId ||
      result.modelCallStarted !== false ||
      typeof result.confirmExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(result.confirmExpiresAt))) return null;
  return { previewId: expectedPreviewId, ideaId: expectedIdeaId,
    payloadDigest: expectedDigest, payloadDigestKeyId: expectedDigestKeyId,
    confirmExpiresAt: result.confirmExpiresAt };
}

export function confirmationAttemptKey(operatorId: string, previewId: string): string {
  if (!isAmuxIdeaRequestId(previewId)) throw new Error("Invalid preview ID");
  return `amux-v4-transfer-confirm:${operatorId}:${previewId}`;
}

/** A lost confirmation response must survive refresh as a read-back-only state. */
export function readConfirmationAttemptForPreview(storage: Storage | null,
  operatorId: string, previewId: string, ideaId: string):
  | { kind: "absent" | "unavailable" }
  | { kind: "present"; payloadDigest: string; payloadDigestKeyId: string } {
  if (!storage || !isAmuxIdeaRequestId(ideaId)) return { kind: "unavailable" };
  try {
    const raw = storage.getItem(confirmationAttemptKey(operatorId, previewId));
    if (raw === null) return { kind: "absent" };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unavailable" };
    }
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value.ideaId !== ideaId ||
        typeof value.payloadDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
        typeof value.payloadDigestKeyId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(value.payloadDigestKeyId)) {
      return { kind: "unavailable" };
    }
    return { kind: "present", payloadDigest: value.payloadDigest,
      payloadDigestKeyId: value.payloadDigestKeyId };
  } catch { return { kind: "unavailable" }; }
}

export function readConfirmationAttempt(storage: Storage | null, operatorId: string,
  previewId: string, ideaId: string, payloadDigest: string,
  payloadDigestKeyId: string): "absent" | "present" | "unavailable" {
  const attempt = readConfirmationAttemptForPreview(storage, operatorId, previewId, ideaId);
  if (attempt.kind !== "present") return attempt.kind;
  return attempt.payloadDigest === payloadDigest &&
    attempt.payloadDigestKeyId === payloadDigestKeyId ? "present" : "unavailable";
}

export function reserveConfirmationAttempt(storage: Storage | null, operatorId: string,
  previewId: string, ideaId: string, payloadDigest: string,
  payloadDigestKeyId: string): boolean {
  if (!storage || readConfirmationAttempt(storage, operatorId, previewId,
    ideaId, payloadDigest, payloadDigestKeyId) !== "absent" ||
    !/^[a-f0-9]{64}$/.test(payloadDigest) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(payloadDigestKeyId)) return false;
  try {
    const key = confirmationAttemptKey(operatorId, previewId);
    const value = JSON.stringify({ ideaId, payloadDigest, payloadDigestKeyId });
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch { return false; }
}

/** Only a definitive pre-write refusal may release the same-tab attempt fence. */
export function clearRefusedConfirmationAttempt(storage: Storage | null, operatorId: string,
  previewId: string, ideaId: string, payloadDigest: string,
  payloadDigestKeyId: string): boolean {
  if (!storage || readConfirmationAttempt(storage, operatorId, previewId,
    ideaId, payloadDigest, payloadDigestKeyId) !== "present") return false;
  try {
    const key = confirmationAttemptKey(operatorId, previewId);
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch { return false; }
}
