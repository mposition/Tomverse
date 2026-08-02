import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Admission tokens for a multi-model comparison.
 *
 * A three-model comparison is one user action but three `POST /api/chat`
 * requests. Each used to take its own concurrency slot on arrival, so with a
 * limit of three and any other request already running, some panels started and
 * the rest were refused -- a partial admission the user experiences as "two of
 * my three answers failed".
 *
 * The fix is to decide admission once. The aggregate preflight reserves every
 * slot the comparison needs inside a single transaction (all or nothing) and
 * hands back an admission token naming one pre-created lease per model. Each
 * model request presents the token and *claims* its own lease instead of
 * competing for a new one.
 *
 * The token is signed, scoped and short-lived:
 *
 *   * signed with the app secret, so it cannot be forged or edited;
 *   * bound to the issuing subject key, so another guest session's token is
 *     rejected even if it is stolen verbatim;
 *   * carries an expiry, so an old token cannot be replayed later.
 *
 * It is not a capability by itself. Claiming a slot is a conditional database
 * update against a row that exists only because the preflight created it, so a
 * replayed token within its lifetime finds the slot already claimed and gets
 * nothing. Credits, plan access, conversation ownership and cost guardrails are
 * still checked in full on every model request -- the token only decides *which
 * concurrency slot* that request occupies.
 */

export type AdmissionSlot = {
    leaseId: string;
    modelId: string;
};

export type AdmissionPayload = {
    version: 1;
    admissionId: string;
    subjectKey: string;
    comparisonId: string;
    slots: AdmissionSlot[];
    expiresAtMs: number;
};

export type AdmissionVerification =
    | { ok: true; payload: AdmissionPayload }
    | {
          ok: false;
          reason:
              | "malformed"
              | "invalid_signature"
              | "expired"
              | "subject_mismatch"
              | "model_not_admitted";
      };

const MAX_TOKEN_LENGTH = 4_096;
const MAX_SLOTS = 3;

const encode = (payload: AdmissionPayload) =>
    Buffer.from(
        JSON.stringify({
            v: payload.version,
            a: payload.admissionId,
            s: payload.subjectKey,
            c: payload.comparisonId,
            l: payload.slots.map((slot) => [slot.leaseId, slot.modelId]),
            e: payload.expiresAtMs,
        }),
        "utf8"
    ).toString("base64url");

const sign = (body: string, secret: string) =>
    createHmac("sha256", secret).update(`chat-admission.v1.${body}`).digest("base64url");

export const issueAdmissionToken = (
    payload: AdmissionPayload,
    secret: string
) => {
    const body = encode(payload);
    return `${body}.${sign(body, secret)}`;
};

const isStringArrayPair = (value: unknown): value is [string, string] =>
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    value[0].length > 0 &&
    value[0].length <= 100 &&
    value[1].length > 0 &&
    value[1].length <= 160;

const decode = (body: string): AdmissionPayload | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    if (
        typeof record.a !== "string" ||
        typeof record.s !== "string" ||
        typeof record.c !== "string" ||
        typeof record.e !== "number" ||
        !Number.isSafeInteger(record.e) ||
        !Array.isArray(record.l) ||
        record.l.length === 0 ||
        record.l.length > MAX_SLOTS ||
        !record.l.every(isStringArrayPair)
    ) {
        return null;
    }
    return {
        version: 1,
        admissionId: record.a,
        subjectKey: record.s,
        comparisonId: record.c,
        slots: (record.l as Array<[string, string]>).map(
            ([leaseId, modelId]) => ({ leaseId, modelId })
        ),
        expiresAtMs: record.e,
    };
};

export const verifyAdmissionToken = (
    token: string,
    options: {
        secret: string;
        subjectKey: string;
        modelId?: string;
        now?: Date;
    }
): AdmissionVerification => {
    if (!token || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: "malformed" };
    }
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return { ok: false, reason: "malformed" };

    const body = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = sign(body, options.secret);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
        return { ok: false, reason: "invalid_signature" };
    }

    const payload = decode(body);
    if (!payload) return { ok: false, reason: "malformed" };

    // Signature verified first, so these comparisons are on trusted content.
    if (payload.subjectKey !== options.subjectKey) {
        return { ok: false, reason: "subject_mismatch" };
    }
    const now = options.now ?? new Date();
    if (payload.expiresAtMs <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    if (
        options.modelId &&
        !payload.slots.some((slot) => slot.modelId === options.modelId)
    ) {
        return { ok: false, reason: "model_not_admitted" };
    }
    return { ok: true, payload };
};

export const admissionSlotFor = (
    payload: AdmissionPayload,
    modelId: string
) => payload.slots.find((slot) => slot.modelId === modelId) ?? null;
