import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Context bundles (policy §10).
 *
 * Memory changes between the moment a chat request is priced and the moment
 * it runs. A user can approve a memory, edit one, delete all of them or turn
 * the feature off while a preflight response is still in flight — and every
 * one of those changes what the prompt should contain, what it costs, and how
 * many input tokens were reserved. Sending the second request anyway means
 * charging for one prompt and sending another.
 *
 * So preflight signs an opaque description of the context it priced, and
 * `/api/chat` verifies that the context it is about to build still matches.
 * When it does not, the request is refused with CHAT_CONTEXT_BUNDLE_STALE
 * rather than quietly running against a different prompt.
 *
 * The bundle is NOT an admission token, and the two must never stand in for
 * each other (§10, chat-concurrency-and-identity.md §3):
 *
 *   * an admission token grants the right to occupy a concurrency slot;
 *   * a context bundle attests which context snapshot was priced.
 *
 * A comparison presents both, and each still has to pass on its own. They are
 * even signed under different HMAC domains, so a token of one kind can never
 * verify as the other however it is relabelled.
 *
 * Staleness is decided by recomputing, never by trusting the bundle: the
 * bundle carries a fingerprint of what preflight saw, chat computes the
 * fingerprint of what it sees now, and they are compared. A bundle that
 * simply asserted "still fresh" would be exactly as trustworthy as the client
 * holding it.
 *
 * Pure and Node-crypto only — no database, no clock of its own.
 */

export type ContextBundleFingerprintInput = {
    /** "off" is a distinct context, not an absent one. */
    memoryMode: "on" | "off";
    /** Identity of the account's active memory set (see memoryStateFingerprint). */
    memoryVersion: string;
    /** Identity of the approved answer-style set. */
    styleVersion: string;
    /**
     * Release C: the profile version this turn runs under, as
     * `<versionId>:<revision>`. Null when no profile is bound — which is every
     * turn until a conversation names one.
     */
    profileVersion: string | null;
    /** Hash of the §9 retrieval result for this request. */
    retrievalHash: string;
    /** Scoring/selection algorithm identity (§9). */
    retrievalVersion: number;
    /** Prompt assembly identity (§9.1), e.g. "mem-context-v1". */
    promptVersion: string;
    /**
     * Release C (§10): identity of this turn's profile knowledge retrieval —
     * which excerpts came back, plus the algorithm and prompt shape that chose
     * and rendered them. `"none"` when no knowledge was retrieved.
     *
     * Bound separately from `retrievalHash` rather than mixed into it because
     * they answer for different sets under different rules, and a single field
     * would make "a memory changed" and "a knowledge file changed"
     * indistinguishable in a stale bundle's own record.
     */
    knowledgeHash: string;
};

export type ContextBundlePayload = ContextBundleFingerprintInput & {
    version: 1;
    /** Shared lineage identity. A comparison's panels all carry the same one. */
    bundleId: string;
    subjectKey: string;
    /** Null for a conversation that does not exist yet. */
    conversationId: string | null;
    /** One entry for a single model; the whole set for a comparison. */
    modelIds: string[];
    /**
     * Input tokens the memory block contributed, as priced. Carried so the
     * chat request books the same figure preflight reserved against rather
     * than re-deriving a number the user never agreed to.
     */
    memoryTokens: number;
    /**
     * Release C: input tokens the profile's own blocks contributed — its
     * instructions and its retrieved knowledge. Carried beside `memoryTokens`
     * rather than folded into it so the booked figure keeps saying which
     * context it paid for; a profile turn and a memory turn are priced by the
     * same builder but are not the same charge.
     */
    profileTokens: number;
    expiresAtMs: number;
};

export type ContextBundleVerification =
    | { ok: true; payload: ContextBundlePayload }
    | {
          ok: false;
          reason:
              | "malformed"
              | "invalid_signature"
              | "expired"
              | "subject_mismatch"
              | "conversation_mismatch"
              | "model_not_bound"
              | "stale";
      };

const MAX_TOKEN_LENGTH = 8_192;
const MAX_MODELS = 3;

/**
 * Distinct from the admission token's domain on purpose: the same secret
 * signs both, and without separate domains a bundle body that happened to
 * decode as an admission payload would verify as one.
 */
const SIGNING_DOMAIN = "chat-context-bundle.v1.";

/**
 * Identity of the account's active memory set, without carrying any of its
 * content.
 *
 * Count plus newest-modification covers every change that matters: approving,
 * rejecting, editing, pinning and deleting all move one or both. Two edits
 * inside the same millisecond that leave the count unchanged would collide,
 * which is why the *retrieval* hash is bound as well — the two would have to
 * collide together for a changed context to look unchanged.
 */
export function memoryStateFingerprint(input: {
    activeCount: number;
    latestUpdatedAtMs: number;
}): string {
    return `${input.activeCount}:${input.latestUpdatedAtMs}`;
}

/** The comparable value. Order is fixed so two identical states agree. */
export function contextFingerprint(
    input: ContextBundleFingerprintInput
): string {
    return createHash("sha256")
        .update(
            [
                input.memoryMode,
                input.memoryVersion,
                input.styleVersion,
                input.profileVersion ?? "-",
                input.retrievalHash,
                String(input.retrievalVersion),
                input.promptVersion,
                input.knowledgeHash,
            ].join("\n"),
            "utf8"
        )
        .digest("base64url");
}

const encode = (payload: ContextBundlePayload) =>
    Buffer.from(
        JSON.stringify({
            v: payload.version,
            b: payload.bundleId,
            s: payload.subjectKey,
            c: payload.conversationId,
            m: payload.modelIds,
            mode: payload.memoryMode,
            mv: payload.memoryVersion,
            sv: payload.styleVersion,
            pv: payload.profileVersion,
            rh: payload.retrievalHash,
            rv: payload.retrievalVersion,
            prv: payload.promptVersion,
            kh: payload.knowledgeHash,
            t: payload.memoryTokens,
            pt: payload.profileTokens,
            e: payload.expiresAtMs,
        }),
        "utf8"
    ).toString("base64url");

const sign = (body: string, secret: string) =>
    createHmac("sha256", secret)
        .update(`${SIGNING_DOMAIN}${body}`)
        .digest("base64url");

export const issueContextBundle = (
    payload: ContextBundlePayload,
    secret: string
) => {
    const body = encode(payload);
    return `${body}.${sign(body, secret)}`;
};

const isModelList = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MODELS &&
    value.every(
        (entry) =>
            typeof entry === "string" && entry.length > 0 && entry.length <= 160
    );

const decode = (body: string): ContextBundlePayload | null => {
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
        typeof record.b !== "string" ||
        typeof record.s !== "string" ||
        (record.c !== null && typeof record.c !== "string") ||
        !isModelList(record.m) ||
        (record.mode !== "on" && record.mode !== "off") ||
        typeof record.mv !== "string" ||
        typeof record.sv !== "string" ||
        (record.pv !== null && typeof record.pv !== "string") ||
        typeof record.rh !== "string" ||
        typeof record.rv !== "number" ||
        !Number.isSafeInteger(record.rv) ||
        typeof record.prv !== "string" ||
        typeof record.t !== "number" ||
        !Number.isSafeInteger(record.t) ||
        record.t < 0 ||
        typeof record.e !== "number" ||
        !Number.isSafeInteger(record.e)
    ) {
        return null;
    }
    // The two Release C fields are read tolerantly, and only these two.
    //
    // A bundle lives five minutes, so a deploy that added them strictly would
    // spend that long turning every in-flight bundle into a malformed one --
    // and `malformed` is answered with INVALID_CONTEXT_BUNDLE (400), which
    // tells the client its request was wrong rather than that its context
    // aged out. Absent means "issued before profiles were bound", which is
    // exactly the same context a turn with no profile has. A *present* field
    // of the wrong type is still refused: tolerance is for the old shape, not
    // for a forged one.
    if (record.kh !== undefined && typeof record.kh !== "string") return null;
    if (
        record.pt !== undefined &&
        (typeof record.pt !== "number" ||
            !Number.isSafeInteger(record.pt) ||
            record.pt < 0)
    ) {
        return null;
    }
    return {
        version: 1,
        bundleId: record.b,
        subjectKey: record.s,
        conversationId: record.c,
        modelIds: record.m,
        memoryMode: record.mode,
        memoryVersion: record.mv,
        styleVersion: record.sv,
        profileVersion: record.pv,
        retrievalHash: record.rh,
        retrievalVersion: record.rv,
        promptVersion: record.prv,
        knowledgeHash: typeof record.kh === "string" ? record.kh : "none",
        memoryTokens: record.t,
        profileTokens: typeof record.pt === "number" ? record.pt : 0,
        expiresAtMs: record.e,
    };
};

export const verifyContextBundle = (
    token: string,
    options: {
        secret: string;
        subjectKey: string;
        conversationId: string | null;
        modelId: string;
        /**
         * The fingerprint of the context the request is about to build. Omit
         * only where there is nothing to compare against yet; passing it is
         * what makes the check a freshness check rather than a signature
         * check.
         */
        currentFingerprint?: string;
        now?: Date;
    }
): ContextBundleVerification => {
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

    // Signature verified first, so everything below compares trusted content.
    if (payload.subjectKey !== options.subjectKey) {
        return { ok: false, reason: "subject_mismatch" };
    }
    if (payload.conversationId !== options.conversationId) {
        return { ok: false, reason: "conversation_mismatch" };
    }
    // A comparison's panels share one bundle, so this asks whether this model
    // is in the set that was priced — not whether it is the only one.
    if (!payload.modelIds.includes(options.modelId)) {
        return { ok: false, reason: "model_not_bound" };
    }
    const now = options.now ?? new Date();
    if (payload.expiresAtMs <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    if (
        options.currentFingerprint !== undefined &&
        options.currentFingerprint !== contextFingerprint(payload)
    ) {
        return { ok: false, reason: "stale" };
    }
    return { ok: true, payload };
};

/**
 * The stale-recovery decision lives in `lib/chatContextBundleRecovery.ts` and
 * is re-exported here so server callers still find it beside the rest of the
 * bundle contract. It is a separate module because the *client* is what makes
 * this decision — it holds the request and knows whether anything has been
 * shown — and this module's `node:crypto` import can never reach a browser
 * bundle.
 */
export {
    decideBundleStaleRecovery,
    type BundleStaleRecovery,
} from "@/lib/chatContextBundleRecovery";

/**
 * The consumption key for the nonce contract (§10).
 *
 * Per model rather than per bundle: a comparison's three requests legitimately
 * present the same bundle, so a per-bundle single-use rule would refuse two of
 * its own panels. Enforcement is a durable conditional write and lands with
 * the chat wiring; this only fixes what is counted.
 */
export const bundleConsumptionKey = (bundleId: string, modelId: string) =>
    `${bundleId}:${modelId}`;
