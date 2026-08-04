import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The §10 context bundle: a signed, opaque handle to the memory snapshot a
 * request was priced and admitted against.
 *
 * docs/policy/external-conversation-import-and-memory.md §10, §9.1.
 *
 * The problem it solves is a gap between two requests. Preflight builds the
 * memory context, counts its tokens, and reserves credits for a prompt of that
 * size. `POST /api/chat` then builds the prompt for real — and in between, the
 * user may have approved a memory, deleted one, pinned one, or turned memory
 * off in another tab. Without a binding, chat would silently send a *different*
 * prompt than the one that was quoted, and the reservation would describe
 * something that never happened.
 *
 * So the bundle carries **hashes, never content**. Two reasons, and the second
 * is the important one:
 *
 *  - the client holds this token, and a user's memories must not travel
 *    through the browser to come back again (§16);
 *  - a hash makes the check total. Chat rebuilds the context server-side with
 *    the same builder and compares; anything that changed the snapshot changes
 *    a hash, whether or not whoever added the field remembered to check it.
 *
 * Bound fields are §10's list: subject, conversation, memory mode, model set,
 * memory state, style, profile, retrieval result, retrieval version, prompt
 * version, expiry and a nonce.
 *
 * **This is not an admission token and does not replace one.** The admission
 * token decides which concurrency slot a request occupies; this decides which
 * context snapshot it was quoted against. A comparison request presents both,
 * and each is verified on its own terms (chat-concurrency-and-identity.md §3).
 */

export const MEMORY_CONTEXT_BUNDLE_VERSION = 1;

/** Conversation-level memory mode (`Conversation.memoryMode`). */
export type MemoryMode = "inherit" | "on" | "off";

export type ContextBundlePayload = {
    version: typeof MEMORY_CONTEXT_BUNDLE_VERSION;
    /** Nonce. Distinct per issue, so two identical snapshots are two bundles. */
    bundleId: string;
    subjectKey: string;
    /** Null for the first turn of a conversation that does not exist yet. */
    conversationId: string | null;
    memoryMode: MemoryMode;
    /** Sorted, so a comparison's panels agree regardless of request order. */
    modelIds: string[];
    /** Hash of the account's whole active memory set (§10 memory version). */
    memoryStateHash: string;
    /** Hash of what retrieval actually selected, in order. */
    retrievalHash: string;
    retrievalVersion: number;
    /** Answer-style state, which changes the prompt without changing memory. */
    styleEnabled: boolean;
    /** Release C. Null until assistant profiles exist. */
    profileVersion: string | null;
    /** The §9.1 prompt-boundary version this context was rendered for. */
    promptVersion: string;
    /** Tokens the memory sections occupy; part of what was reserved. */
    memoryTokens: number;
    issuedAtMs: number;
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
              | "model_set_mismatch"
              | "snapshot_changed";
      };

const MAX_TOKEN_LENGTH = 4_096;
const MAX_MODELS = 8;

/**
 * Bundle lifetime. Long enough for a person to finish typing and send, short
 * enough that a token found later is useless. Staleness is detected by hash
 * comparison regardless, so this is a replay bound rather than a freshness
 * mechanism.
 */
export const MEMORY_CONTEXT_BUNDLE_TTL_MS = 10 * 60 * 1000;

const digest = (material: string) =>
    createHash("sha256").update(material, "utf8").digest("base64url");

/**
 * Hash of the account's active memory set.
 *
 * `id:revision` per row, sorted: an approval, an edit, a deletion and a pin
 * all move it, and nothing else does. Revision rather than `updatedAt` because
 * two edits inside one millisecond are two different memories and must not
 * hash the same.
 */
export const memoryStateHash = (
    rows: ReadonlyArray<{ id: string; revision: number }>
): string =>
    digest(
        [...rows]
            .map((row) => `${row.id}:${row.revision}`)
            .sort()
            .join("|")
    );

/** Hash of a retrieval selection, from the material the retriever produced. */
export const retrievalHash = (material: string): string => digest(material);

const encode = (payload: ContextBundlePayload) =>
    Buffer.from(
        JSON.stringify({
            v: payload.version,
            b: payload.bundleId,
            s: payload.subjectKey,
            c: payload.conversationId,
            mm: payload.memoryMode,
            m: payload.modelIds,
            ms: payload.memoryStateHash,
            rh: payload.retrievalHash,
            rv: payload.retrievalVersion,
            se: payload.styleEnabled,
            pv: payload.profileVersion,
            p: payload.promptVersion,
            mt: payload.memoryTokens,
            i: payload.issuedAtMs,
            e: payload.expiresAtMs,
        }),
        "utf8"
    ).toString("base64url");

const sign = (body: string, secret: string) =>
    createHmac("sha256", secret)
        .update(`chat-context-bundle.v1.${body}`)
        .digest("base64url");

export const issueContextBundle = (
    payload: ContextBundlePayload,
    secret: string
): string => {
    const body = encode(payload);
    return `${body}.${sign(body, secret)}`;
};

const isModelIdList = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MODELS &&
    value.every(
        (entry) =>
            typeof entry === "string" &&
            entry.length > 0 &&
            entry.length <= 160
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
    if (record.v !== MEMORY_CONTEXT_BUNDLE_VERSION) return null;
    if (
        typeof record.b !== "string" ||
        typeof record.s !== "string" ||
        (record.c !== null && typeof record.c !== "string") ||
        (record.mm !== "inherit" && record.mm !== "on" && record.mm !== "off") ||
        !isModelIdList(record.m) ||
        typeof record.ms !== "string" ||
        typeof record.rh !== "string" ||
        typeof record.rv !== "number" ||
        !Number.isSafeInteger(record.rv) ||
        typeof record.se !== "boolean" ||
        (record.pv !== null && typeof record.pv !== "string") ||
        typeof record.p !== "string" ||
        typeof record.mt !== "number" ||
        !Number.isSafeInteger(record.mt) ||
        record.mt < 0 ||
        typeof record.i !== "number" ||
        !Number.isSafeInteger(record.i) ||
        typeof record.e !== "number" ||
        !Number.isSafeInteger(record.e)
    ) {
        return null;
    }
    return {
        version: MEMORY_CONTEXT_BUNDLE_VERSION,
        bundleId: record.b,
        subjectKey: record.s,
        conversationId: record.c,
        memoryMode: record.mm,
        modelIds: record.m,
        memoryStateHash: record.ms,
        retrievalHash: record.rh,
        retrievalVersion: record.rv,
        styleEnabled: record.se,
        profileVersion: record.pv,
        promptVersion: record.p,
        memoryTokens: record.mt,
        issuedAtMs: record.i,
        expiresAtMs: record.e,
    };
};

const sameModelSet = (left: readonly string[], right: readonly string[]) => {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((entry, index) => entry === sortedRight[index]);
};

/**
 * Verifies a bundle against the snapshot the server just rebuilt.
 *
 * The order matters: signature before anything is read from the payload, then
 * identity (subject, conversation, model set), then expiry, then the snapshot
 * hashes. Comparing a hash from an unverified payload would be comparing the
 * caller's own claim against itself.
 *
 * `current` is optional so a caller that only needs "is this token mine and
 * unexpired" — the preflight echo path — can skip the rebuild. Every caller
 * that is about to *spend* on the bundle must pass it.
 */
export const verifyContextBundle = (
    token: string,
    options: {
        secret: string;
        subjectKey: string;
        conversationId?: string | null;
        modelIds?: readonly string[];
        now?: Date;
        current?: {
            memoryStateHash: string;
            retrievalHash: string;
            retrievalVersion: number;
            styleEnabled: boolean;
            memoryMode: MemoryMode;
            profileVersion: string | null;
            promptVersion: string;
        };
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

    if (payload.subjectKey !== options.subjectKey) {
        return { ok: false, reason: "subject_mismatch" };
    }
    if (
        options.conversationId !== undefined &&
        payload.conversationId !== options.conversationId
    ) {
        return { ok: false, reason: "conversation_mismatch" };
    }
    if (options.modelIds && !sameModelSet(payload.modelIds, options.modelIds)) {
        return { ok: false, reason: "model_set_mismatch" };
    }
    const now = options.now ?? new Date();
    if (payload.expiresAtMs <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }

    if (options.current) {
        const changed =
            payload.memoryStateHash !== options.current.memoryStateHash ||
            payload.retrievalHash !== options.current.retrievalHash ||
            payload.retrievalVersion !== options.current.retrievalVersion ||
            payload.styleEnabled !== options.current.styleEnabled ||
            payload.memoryMode !== options.current.memoryMode ||
            payload.profileVersion !== options.current.profileVersion ||
            payload.promptVersion !== options.current.promptVersion;
        if (changed) return { ok: false, reason: "snapshot_changed" };
    }

    return { ok: true, payload };
};

/**
 * §10 error shape for a bundle that no longer describes the current state.
 *
 * `requiresPreflight` is the whole contract: the client must go back and get a
 * new bundle, not retry the same one. A single-model request may re-preflight
 * and retry exactly once, and only before any of the response has been shown;
 * a comparison re-preflights every panel together, because panels sharing a
 * snapshot is the property that makes them comparable.
 */
export const CHAT_CONTEXT_BUNDLE_STALE = "CHAT_CONTEXT_BUNDLE_STALE" as const;

export const contextBundleStaleBody = (reason: string) => ({
    error: "The memory context changed. Please retry.",
    code: CHAT_CONTEXT_BUNDLE_STALE,
    details: { requiresPreflight: true, reason },
});

/** Verification reasons that mean "re-preflight", rather than "reject". */
export const isRepreflightableBundleFailure = (
    reason: Exclude<ContextBundleVerification, { ok: true }>["reason"]
): boolean => reason === "expired" || reason === "snapshot_changed";
