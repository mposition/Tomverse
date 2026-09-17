#!/usr/bin/env node
/**
 * S0 technical verification probe for Zernio (marketing automation).
 *
 * This is an observation tool, not an integration. It exists so that the S0
 * gate in docs/policy/marketing-automation.md (section 14, the per-channel
 * recovery contract) is decided on what the
 * vendor actually did against test accounts, not on what its documentation
 * says it does. Where the documentation is silent or contradicts itself, the
 * probe records what happened and leaves the verdict to a person.
 *
 * Safety properties, each asserted by tests/marketingZernioS0Probe.test.mjs:
 *
 * - Dry run by default. Every call that writes (upload, create, resume,
 *   delete, unpublish) needs `--execute`.
 * - Every write needs `--plan`. The plan names one test profile and an
 *   explicit allowlist of test accounts. Before a write is sent, the probe
 *   reads the accounts back from the API and refuses unless each one exists on
 *   that profile with the stated platform; before a delete or unpublish it
 *   reads the post back and refuses unless every target account is
 *   allowlisted and the post carries the S0 label and `metadata.s0RequestKey`.
 * - A create is journalled and fsynced *before* it is dispatched, with the
 *   exact body stored beside it, so a timeout leaves `outcome_unknown` and a
 *   `resume` path instead of a lost request.
 * - The API key, bearer tokens, presigned upload URLs, webhook secret, error
 *   prose, comment text, author handles and profile URLs are never printed or
 *   written. Account ids are shown by suffix only.
 * - A webhook delivery is authenticated on its raw bytes before anything else
 *   happens to it. A forged or oversized delivery is counted, never parsed,
 *   never deduplicated and never written.
 * - Anything the documentation did not confirm is a TODO entry in
 *   `ENDPOINTS` with `confirmed: false`, and the subcommand that would need it
 *   refuses instead of guessing a path or a field name.
 *
 * Node 22, ESM, no dependencies beyond the standard library. `samples` needs
 * an ffmpeg binary on PATH (or FFMPEG_PATH); nothing else does.
 */

import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const ZERNIO_BASE_URL = "https://zernio.com/api";

/**
 * Every endpoint the probe may call, with the documentation it was read from
 * (2026-09-16, OpenAPI `info.version` 1.5.0 at https://zernio.com/openapi.yaml).
 * `confirmed: false` means the docs did not state it; the probe refuses those.
 */
export const ENDPOINTS = {
    listAccounts: { confirmed: true, method: "GET", path: "/v1/accounts", source: "https://zernio.com/openapi.yaml (operationId listAccounts)" },
    presignMedia: { confirmed: true, method: "POST", path: "/v1/media/presign", source: "https://docs.zernio.com/guides/media-uploads" },
    createPost: { confirmed: true, method: "POST", path: "/v1/posts", source: "https://docs.zernio.com/posts/create-post" },
    listPosts: { confirmed: true, method: "GET", path: "/v1/posts", source: "https://docs.zernio.com/posts/list-posts" },
    getPost: { confirmed: true, method: "GET", path: "/v1/posts/{postId}", source: "https://docs.zernio.com/posts/get-post" },
    // Drafts and scheduled posts only. Published posts need unpublish.
    deletePost: { confirmed: true, method: "DELETE", path: "/v1/posts/{postId}", source: "https://docs.zernio.com/posts/delete-post" },
    unpublishPost: { confirmed: true, method: "POST", path: "/v1/posts/{postId}/unpublish", source: "https://docs.zernio.com/posts/unpublish-post" },
    postComments: { confirmed: true, method: "GET", path: "/v1/inbox/comments/{postId}", source: "https://zernio.com/openapi.yaml (operationId getInboxPostComments)" },
    // TODO(zernio-s0): no documented field reports the visibility a platform
    // actually applied (for example YouTube's "locked to private" for an
    // unaudited API project, or TikTok SELF_ONLY). `platformPostUrl` is not
    // proof of public visibility. Until the docs name such a field, C12 is a
    // human check made while logged out, and this entry stays unconfirmed.
    platformVisibility: { confirmed: false, method: "GET", path: null, source: "TODO: not documented" },
};

/**
 * Platforms `POST /v1/posts/{postId}/unpublish` accepts, copied from the
 * request-body enum. The operation description says: "Not supported on
 * Instagram, TikTok, or Snapchat."
 */
export const UNPUBLISH_PLATFORMS = new Set(["threads", "facebook", "twitter", "linkedin", "youtube", "pinterest", "reddit", "bluesky", "googlebusiness", "telegram"]);

/** The seven S0 channels, by Zernio platform key. */
export const S0_PLATFORMS = ["linkedin", "twitter", "facebook", "instagram", "threads", "youtube", "tiktok"];

/**
 * Recovery windows, measured from the first dispatch of a request key.
 *
 * https://docs.zernio.com/guides/idempotency: an `x-request-id` is remembered
 * "while the first request is in flight and for about 5 minutes after it
 * completes", and a retry inside that window answers 200 with `existingPost`.
 * Independently, `(platform, accountId, content + media URLs)` is rejected
 * with 409 and `details.existingPostId` for 24 hours.
 *
 * Both boundaries are taken short of the documented value. The replay window
 * is counted from dispatch, not completion, and "about" is not a number, so a
 * retry at 4:59 that lands at 5:01 must not be read as safe. Past the content
 * window, only a list scan remains.
 */
export const REPLAY_WINDOW_MS = 4 * 60_000;
export const CONTENT_HASH_WINDOW_MS = 23 * 60 * 60_000;

export const recoveryWindow = (elapsedMs) => {
    if (elapsedMs < 0) return "clock_skew";
    if (elapsedMs <= REPLAY_WINDOW_MS) return "replay_same_request_id";
    if (elapsedMs <= CONTENT_HASH_WINDOW_MS) return "content_hash_409";
    return "list_scan_lookup";
};

/**
 * The docs name no timestamp header and do not sign the payload timestamp,
 * so there is no tolerance to enforce. Kept as an explicit unknown so the
 * summary reports it instead of a number somebody made up.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = null;
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export const SIGNATURE_HEADER = "x-zernio-signature";
export const LEGACY_SIGNATURE_HEADER = "x-late-signature";
export const EVENT_HEADER = "x-zernio-event";
export const EVENT_ID_HEADER = "x-zernio-event-id";

const RATE_LIMIT_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"];
const DEFAULT_MAX_PAGES = 20;
const LIST_PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Shows only the last four characters of an identifier. */
export const redactId = (value) => {
    if (typeof value !== "string" || value.length === 0) return "(none)";
    if (value.length <= 4) return "…" + "*".repeat(value.length);
    return "…" + value.slice(-4);
};

const SECRET_PATTERNS = [/\bsk_[A-Za-z0-9]{16,}\b/g, /\bzrk_[A-Za-z0-9]{16,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi];

/**
 * Removes anything shaped like a credential, plus the exact values passed in
 * `secrets` (the live API key and webhook secret), from free text. This is the
 * last line of defence; the first is not putting such text into output at all.
 */
export const redactText = (text, secrets = []) => {
    let out = String(text ?? "");
    for (const secret of secrets) {
        if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("[REDACTED]");
    }
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
    return out;
};

/** A URL reduced to its host, so a profile handle in the path never lands in a record. */
export const urlHostOnly = (value) => {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
        return new URL(value).host;
    } catch {
        return "(unparseable)";
    }
};

const TOKEN = /^[A-Za-z0-9_.:\[\]-]{1,80}$/;
const token = (value) => (typeof value === "string" && TOKEN.test(value) ? value : undefined);

/**
 * The error envelope reduced to machine-readable tokens
 * (https://docs.zernio.com/guides/error-handling). The human-readable `error`
 * text is dropped entirely: it can name a page, a handle or an account, and the
 * docs say not to branch on it anyway. A field that is not a short token is
 * dropped too, so prose cannot arrive through `code` either.
 */
export const errorSummary = (httpStatus, json) => {
    const out = { httpStatus };
    if (json && typeof json === "object") {
        for (const key of ["type", "code", "param", "platform"]) {
            const value = token(json[key]);
            if (value) out[key] = value;
        }
        const existing = token(json.details?.existingPostId) ?? token(json.existingPostId);
        if (existing) out.existingPostId = existing;
        if (Number.isFinite(json.retryAfterSeconds)) out.retryAfterSeconds = json.retryAfterSeconds;
    }
    return out;
};

// ---------------------------------------------------------------------------
// Webhook signature and delivery handling
// ---------------------------------------------------------------------------

/**
 * Per https://docs.zernio.com/webhooks: `X-Zernio-Signature` is "the lowercase
 * hex HMAC-SHA256 of the raw request body keyed by that secret". Nothing else
 * (no timestamp) is signed.
 */
export const computeZernioSignature = (rawBody, secret) => createHmac("sha256", secret).update(rawBody).digest("hex");

export const verifyZernioSignature = ({ rawBody, signatureHeader, secret }) => {
    if (typeof secret !== "string" || secret.length === 0) return { ok: false, reason: "no_secret_configured" };
    if (typeof signatureHeader !== "string" || signatureHeader.length === 0) return { ok: false, reason: "missing_signature" };
    const expected = Buffer.from(computeZernioSignature(rawBody, secret), "utf8");
    const received = Buffer.from(signatureHeader.trim(), "utf8");
    if (expected.length !== received.length) return { ok: false, reason: "length_mismatch" };
    return timingSafeEqual(expected, received) ? { ok: true, reason: "valid" } : { ok: false, reason: "mismatch" };
};

export const newWebhookCounters = () => ({ accepted: 0, duplicate: 0, invalidSignature: 0, unparseable: 0, oversized: 0 });

/**
 * One delivery, in the only safe order: authenticate the raw bytes, then parse,
 * then deduplicate, then reduce to allowlisted metadata.
 *
 * A delivery that fails the signature returns `meta: null` and touches nothing
 * but a counter. Parsing it would run attacker-supplied JSON through the
 * recorder, deduplicating it would let a forger poison `seenEventIds` so the
 * genuine event is later marked as a redelivery, and persisting it would put
 * unauthenticated bytes into the verification record.
 */
export const processWebhookDelivery = ({ headers, rawBody, secret, seenEventIds, counters, now = new Date() }) => {
    const signature = verifyZernioSignature({ rawBody, signatureHeader: headers[SIGNATURE_HEADER], secret });
    if (!signature.ok) {
        counters.invalidSignature += 1;
        return { status: 401, meta: null };
    }
    let payload;
    try {
        payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
        counters.unparseable += 1;
        return { status: 400, meta: null };
    }
    const eventId = token(headers[EVENT_ID_HEADER]) ?? token(payload?.id) ?? null;
    const duplicate = eventId ? seenEventIds.has(eventId) : false;
    if (eventId) seenEventIds.add(eventId);
    if (duplicate) counters.duplicate += 1;
    else counters.accepted += 1;
    const payloadTimestamp = typeof payload?.timestamp === "string" && !Number.isNaN(Date.parse(payload.timestamp)) ? payload.timestamp : null;
    const platforms = Array.isArray(payload?.post?.platforms)
        ? payload.post.platforms.map((entry) => ({ platform: token(entry?.platform) ?? null, status: token(entry?.status) ?? null, hasPlatformPostId: Boolean(entry?.platformPostId) }))
        : [];
    if (payload?.platform && typeof payload.platform === "object" && token(payload.platform.platform)) {
        platforms.push({ platform: payload.platform.platform, status: token(payload.platform.status) ?? null, hasPlatformPostId: Boolean(payload.platform.platformPostId) });
    }
    return {
        status: 200,
        meta: {
            check: "C9",
            kind: "webhook",
            receivedAt: now.toISOString(),
            eventHeader: token(headers[EVENT_HEADER]) ?? null,
            eventBody: token(payload?.event) ?? null,
            eventId,
            eventIdHeaderMatchesBody: Boolean(eventId && payload?.id && headers[EVENT_ID_HEADER] === payload.id),
            duplicateDelivery: duplicate,
            signature: signature.reason,
            legacySignaturePresent: Boolean(headers[LEGACY_SIGNATURE_HEADER]),
            payloadTimestamp,
            lagSeconds: payloadTimestamp ? Math.round((now.getTime() - Date.parse(payloadTimestamp)) / 1000) : null,
            timestampTolerance: WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS === null ? "undocumented" : WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
            postId: token(payload?.post?.id) ?? null,
            postStatus: token(payload?.post?.status) ?? null,
            platformStatuses: platforms,
            s0RequestKey: token(payload?.post?.metadata?.s0RequestKey) ?? null,
            bodyBytes: rawBody.length,
        },
    };
};

/**
 * The HTTP side of the listener. The body limit is enforced twice: a declared
 * Content-Length over the limit is refused before a byte is read, and a body
 * that grows past it while streaming is refused the moment it does. Either way
 * the answer is an explicit 413 and the connection is closed rather than
 * drained.
 */
export const createWebhookServer = ({ secret, onAccepted, onRejected, maxBytes = WEBHOOK_MAX_BODY_BYTES, counters = newWebhookCounters(), seenEventIds = new Set() }) => {
    const server = createServer((req, res) => {
        const refuseTooLarge = () => {
            counters.oversized += 1;
            onRejected?.({ status: 413, counters });
            res.writeHead(413, { "content-type": "text/plain", connection: "close" });
            res.end("payload too large");
            res.on("finish", () => req.destroy());
        };
        if (req.method !== "POST") {
            res.writeHead(405, { connection: "close" });
            res.end();
            return;
        }
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
            refuseTooLarge();
            return;
        }
        const chunks = [];
        let size = 0;
        let refused = false;
        req.on("data", (chunk) => {
            if (refused) return;
            size += chunk.length;
            if (size > maxBytes) {
                refused = true;
                chunks.length = 0;
                req.pause();
                refuseTooLarge();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (refused) return;
            const headers = {};
            for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
            const { status, meta } = processWebhookDelivery({ headers, rawBody: Buffer.concat(chunks), secret, seenEventIds, counters });
            if (meta) onAccepted?.(meta, counters);
            else onRejected?.({ status, counters });
            res.writeHead(status, { "content-type": "text/plain" });
            res.end(status === 200 ? "ok" : "rejected");
        });
    });
    return { server, counters, seenEventIds };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RefusalError extends Error {
    constructor(message, exitCode = 2) {
        super(message);
        this.exitCode = exitCode;
    }
}

// ---------------------------------------------------------------------------
// Plan and allowlist
// ---------------------------------------------------------------------------

const refIdOf = (value) => (typeof value === "string" ? value : value && typeof value === "object" ? value._id ?? value.id ?? null : null);

export const isAllowlisted = (plan, platform, accountId) =>
    plan.allowlist.accounts.some((entry) => entry.platform === platform && entry.accountId === accountId);

export const loadPlan = (planPath, readFile = readFileSync) => {
    if (!planPath) throw new RefusalError("refused: this subcommand writes and needs --plan <file> naming the test profile and account allowlist.");
    const plan = JSON.parse(readFile(planPath, "utf8"));
    if (typeof plan.testProfileId !== "string" || plan.testProfileId.length === 0) {
        throw new RefusalError("refused: plan.testProfileId must name the Zernio profile that holds only test accounts.");
    }
    if (typeof plan.label !== "string" || !plan.label.includes("S0")) {
        throw new RefusalError("refused: plan.label must be set and contain \"S0\" so every test post is recognisable.");
    }
    const allowlist = plan.allowlist?.accounts;
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
        throw new RefusalError("refused: plan.allowlist.accounts must list every test account as { platform, accountId }.");
    }
    for (const entry of allowlist) {
        if (!S0_PLATFORMS.includes(entry.platform) || typeof entry.accountId !== "string" || entry.accountId.length === 0) {
            throw new RefusalError(`refused: allowlist entry ${JSON.stringify({ platform: entry.platform, accountId: redactId(entry.accountId) })} is not a valid S0 platform/accountId pair.`);
        }
    }
    for (const target of plan.targets ?? []) {
        if (!isAllowlisted(plan, target.platform, target.accountId)) {
            throw new RefusalError(`refused: plan target ${target.platform} ${redactId(target.accountId)} is not in plan.allowlist.accounts.`);
        }
    }
    return plan;
};

const requireConfirmedTestAccounts = (plan) => {
    if (plan.confirmTestAccountsOnly !== true) {
        throw new RefusalError("refused: the plan must set \"confirmTestAccountsOnly\": true. S0 writes go to test accounts only, never production brand accounts.");
    }
};

/**
 * Builds the create-post request for one target. The content is labelled so
 * that anyone who sees it on a platform can tell it is a verification post,
 * and `metadata.s0RequestKey` is what C7 (exact lookup) searches for.
 */
export const buildPostRequest = ({ plan, target, requestKey, runId, now = new Date() }) => {
    const body = {
        content: `[${plan.label}] ${target.platform} ${requestKey.slice(0, 8)} ${now.toISOString()}`,
        platforms: [{ platform: target.platform, accountId: target.accountId, ...(target.platformSpecificData ? { platformSpecificData: target.platformSpecificData } : {}) }],
        metadata: { s0RequestKey: requestKey, s0RunId: runId },
    };
    if (Array.isArray(target.mediaItems) && target.mediaItems.length > 0) body.mediaItems = target.mediaItems;
    const mode = target.mode ?? plan.mode ?? "publishNow";
    if (mode === "publishNow") body.publishNow = true;
    else if (mode === "schedule") {
        const minutes = Number(target.scheduleOffsetMinutes ?? plan.scheduleOffsetMinutes ?? 15);
        body.scheduledFor = new Date(now.getTime() + minutes * 60_000).toISOString();
    } else if (mode === "draft") body.isDraft = true;
    else throw new RefusalError(`refused: unknown mode "${mode}"`);
    return { mode, body };
};

/**
 * A post may be deleted or unpublished only when it is recognisably ours:
 * every target account is allowlisted, and it carries both the label the probe
 * writes into the content and the request key it writes into metadata.
 */
export const s0PostProblems = (plan, post, platform) => {
    const problems = [];
    if (!post || typeof post !== "object") return ["post could not be read"];
    if (typeof post.metadata?.s0RequestKey !== "string" || post.metadata.s0RequestKey.length === 0) problems.push("metadata.s0RequestKey missing");
    if (typeof post.content !== "string" || !post.content.startsWith(`[${plan.label}]`)) problems.push("content does not start with the plan label");
    const targets = Array.isArray(post.platforms) ? post.platforms : [];
    if (targets.length === 0) problems.push("post has no platform targets");
    for (const target of targets) {
        if (!isAllowlisted(plan, target.platform, refIdOf(target.accountId))) {
            problems.push(`target ${token(target.platform) ?? "?"} ${redactId(refIdOf(target.accountId))} is not allowlisted`);
        }
    }
    if (platform && !targets.some((target) => target.platform === platform)) problems.push(`post has no ${platform} target`);
    return problems;
};

// ---------------------------------------------------------------------------
// Durable journal
// ---------------------------------------------------------------------------

/*
 * Every run writes into its own directory, `<base>/runs/<utc>-<random>`, unless
 * the operator names one with `--run`. A shared default path would let an old
 * run's journal answer a new run's `resume`, and would fold past attempts into
 * this run's summary. Directories are created 0700 and files 0600. On Windows
 * those modes are not enforced and ACLs are inherited from the parent, so the
 * S0 document gives the icacls command that restricts the base directory.
 */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export const newRunName = (now = new Date()) => `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;

export const journalPath = (runDir) => join(runDir, "journal.jsonl");
const requestBodyPath = (runDir, requestKey) => join(runDir, "requests", `${requestKey}.json`);
export const resultsFile = (runDir) => join(runDir, "results.jsonl");
const webhookFile = (runDir) => join(runDir, "webhook-events.jsonl");

const ensureDir = (dir) => mkdirSync(dir, { recursive: true, mode: DIR_MODE });

/** Append one line and fsync it before returning. */
export const durableAppend = (file, line) => {
    ensureDir(dirname(file));
    const fd = openSync(file, "a", FILE_MODE);
    try {
        writeSync(fd, line.endsWith("\n") ? line : line + "\n");
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
};

const durableWrite = (file, text) => {
    ensureDir(dirname(file));
    const fd = openSync(file, "w", FILE_MODE);
    try {
        writeSync(fd, text);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
};

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const readJsonl = (file) =>
    existsSync(file)
        ? readFileSync(file, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                  try {
                      return JSON.parse(line);
                  } catch {
                      return null;
                  }
              })
              .filter(Boolean)
        : [];

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const requireConfirmed = (name) => {
    const endpoint = ENDPOINTS[name];
    if (!endpoint || endpoint.confirmed !== true) {
        throw new RefusalError(
            `refused: "${name}" is not confirmed by the Zernio documentation (${endpoint?.source ?? "unknown"}). ` +
                "The probe does not guess endpoints or fields; record this item as a human check instead."
        );
    }
    return endpoint;
};

const pickHeaders = (headers, names) => {
    const out = {};
    for (const name of names) {
        const value = headers.get(name);
        if (value !== null) out[name] = value;
    }
    return out;
};

/** Transport failures reduced to a name; the message can carry a URL. */
const transportErrorName = (error) => token(error?.cause?.code) ?? token(error?.name) ?? "transport_error";

const callZernio = async (ctx, name, { params, query, body, headers } = {}) => {
    const endpoint = requireConfirmed(name);
    const url = new URL(ZERNIO_BASE_URL + endpoint.path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key])));
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const started = Date.now();
    let response;
    try {
        response = await ctx.fetchImpl(url, {
            method: endpoint.method,
            headers: { authorization: `Bearer ${ctx.apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(headers ?? {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(ctx.timeoutMs ?? 60_000),
        });
    } catch (error) {
        return { transportError: transportErrorName(error), elapsedMs: Date.now() - started };
    }
    let json = null;
    try {
        const text = await response.text();
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: response.status, elapsedMs: Date.now() - started, rateLimit: pickHeaders(response.headers, RATE_LIMIT_HEADERS), json };
};

const postSummary = (post) => {
    if (!post || typeof post !== "object") return null;
    return {
        postId: token(refIdOf(post)) ?? null,
        status: token(post.status) ?? null,
        hasS0RequestKey: Boolean(post.metadata?.s0RequestKey),
        platforms: Array.isArray(post.platforms)
            ? post.platforms.map((entry) => ({
                  platform: token(entry.platform) ?? null,
                  accountId: redactId(refIdOf(entry.accountId)),
                  status: token(entry.status) ?? null,
                  hasPlatformPostId: Boolean(entry.platformPostId),
                  platformPostUrlHost: urlHostOnly(entry.platformPostUrl ?? entry.publishedUrl),
                  errorCategory: token(entry.errorCategory) ?? null,
              }))
            : [],
    };
};

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Creates this run's directory on first write and says where it is, once. */
const ensureRunDir = (ctx) => {
    if (!existsSync(ctx.outDir)) ensureDir(ctx.outDir);
    if (!ctx.runAnnounced) {
        ctx.runAnnounced = true;
        ctx.stdout.write(`run directory: ${ctx.outDir}
`);
    }
};

const record = (ctx, file, entry) => {
    ensureRunDir(ctx);
    durableAppend(file, redactText(JSON.stringify({ at: new Date().toISOString(), ...entry }), ctx.secrets));
};
const journal = (ctx, entry) => record(ctx, journalPath(ctx.outDir), entry);

const print = (ctx, value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    ctx.stdout.write(redactText(text, ctx.secrets) + "\n");
};

const requireApiKey = (ctx) => {
    if (!ctx.apiKey) throw new RefusalError("refused: ZERNIO_API_KEY is not set in this shell. Set it in the same window; never paste it into chat.");
};

/**
 * The allowlist is the operator's statement; this is the API's. Every
 * allowlisted account must exist, on the stated platform, inside the test
 * profile. An id typed into the plan by mistake from a brand profile fails
 * here rather than after a post has gone out.
 */
export const verifyAllowlistAgainstApi = async (ctx, plan) => {
    const res = await callZernio(ctx, "listAccounts", { query: { profileId: plan.testProfileId } });
    if (res.transportError || res.status !== 200) {
        throw new RefusalError(`refused: could not read accounts to verify the allowlist (${res.transportError ?? "HTTP " + res.status}).`);
    }
    const accounts = Array.isArray(res.json?.accounts) ? res.json.accounts : [];
    const problems = [];
    for (const entry of plan.allowlist.accounts) {
        const found = accounts.find((account) => refIdOf(account) === entry.accountId);
        if (!found) problems.push(`${entry.platform} ${redactId(entry.accountId)}: not found on the test profile`);
        else if (found.platform !== entry.platform) problems.push(`${entry.platform} ${redactId(entry.accountId)}: API says platform ${token(found.platform) ?? "?"}`);
        else if (refIdOf(found.profileId) !== plan.testProfileId) problems.push(`${entry.platform} ${redactId(entry.accountId)}: belongs to another profile`);
    }
    if (problems.length > 0) throw new RefusalError(`refused: allowlist does not match the API:\n  ${problems.join("\n  ")}`);
};

/**
 * Which HTTP answers to a create leave the outcome unknown.
 *
 * https://docs.zernio.com/guides/error-handling: "503 on writes -- the
 * operation may have succeeded upstream". A 5xx, and a 408 request timeout, can
 * arrive after the post was created, so they are `outcome_unknown` exactly like a
 * transport timeout, and only `resume` may follow them. A 429 is treated the
 * same way: the rate-limit guide says to wait `Retry-After` and retry the same
 * request, but it does not promise that nothing was created, and a platform's
 * own 429 can be relayed from after the platform call. Read conservatively, it
 * is not a rejection this probe can rely on.
 */
export const isUncertainStatus = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);

export const resumeGuidance = (requestKey) =>
    `outcome unknown for ${requestKey}. Do not resend by hand; run: resume ${requestKey} --run <this run directory> --plan <plan> [--execute] (after Retry-After if one was given)`;
export const isOutcomeUnknown = (res) => Boolean(res.transportError) || isUncertainStatus(res.status);

/**
 * One create, journalled on both sides of the network call. The `dispatching`
 * line and the exact request body reach disk before the request leaves; a
 * transport failure or an uncertain status writes `outcome_unknown`, because
 * neither says whether Zernio created the post.
 */
export const dispatchCreate = async (ctx, { requestKey, xRequestId, attempt, body, platform, accountId }) => {
    const bodyText = JSON.stringify(body);
    const bodySha256 = sha256(bodyText);
    const bodyFile = requestBodyPath(ctx.outDir, requestKey);
    if (!existsSync(bodyFile)) durableWrite(bodyFile, bodyText);
    const base = { requestKey, xRequestIdIsRequestKey: xRequestId === requestKey, attempt, platform, accountId: redactId(accountId), bodySha256 };
    journal(ctx, { ...base, state: "dispatching" });
    const res = await callZernio(ctx, "createPost", { body, headers: { "x-request-id": xRequestId } });
    if (isOutcomeUnknown(res)) {
        journal(ctx, { ...base, state: "outcome_unknown", ...(res.transportError ? { transportError: res.transportError } : { httpStatus: res.status, error: errorSummary(res.status, res.json) }) });
        return res;
    }
    const post = res.json?.post ?? res.json?.existingPost ?? null;
    journal(ctx, { ...base, state: "responded", httpStatus: res.status, postId: token(refIdOf(post)) ?? null, existingPostId: errorSummary(res.status, res.json).existingPostId ?? null });
    return res;
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Scans `GET /v1/posts` for `metadata.s0RequestKey`. The list endpoint has no
 * metadata filter, so this is a bounded scan narrowed by account and date, and
 * its result says which of these happened:
 *
 * - `complete`  every page the API said exists was read; `matches` is the
 *               whole answer. This is the only status a resend may rest on.
 * - `truncated` fewer pages were read than the API said exist: the page budget
 *               ran out, or a page came back empty before the stated last one.
 *               Zero matches proves nothing.
 * - `ambiguous` more than one post carries the key; nothing may be resent.
 * - `error`     a page could not be read, or its pagination was not a count.
 *
 * The scan fails closed: anything that is not positively `complete` is one of
 * the other three, because W2 turns `complete` with zero matches into a new
 * public post.
 */
export const validateMaxPages = (value) => {
    const pages = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    if (!Number.isInteger(pages) || pages < 1) throw new RefusalError(`refused: --max-pages must be an integer of at least 1 (got ${JSON.stringify(value)}).`);
    return pages;
};

export const scanForRequestKey = async (ctx, { requestKey, accountId, dateFrom, maxPages = DEFAULT_MAX_PAGES }) => {
    const budget = validateMaxPages(maxPages);
    const matches = [];
    let pagesRead = 0;
    let totalPages = null;
    let httpError = null;
    let malformed = false;
    let consumed = false;
    for (let page = 1; page <= budget; page += 1) {
        const res = await callZernio(ctx, "listPosts", { query: { page, limit: LIST_PAGE_LIMIT, dateFrom, accountId, sortBy: "created-desc" } });
        if (res.transportError || res.status !== 200) {
            httpError = res.transportError ?? errorSummary(res.status, res.json);
            break;
        }
        const stated = res.json?.pagination?.pages;
        if (!Number.isInteger(stated) || stated < 0 || !Array.isArray(res.json?.posts)) {
            malformed = true;
            break;
        }
        pagesRead += 1;
        totalPages = stated;
        const posts = res.json.posts;
        for (const post of posts) if (post?.metadata?.s0RequestKey === requestKey) matches.push(postSummary(post));
        if (page >= Math.max(totalPages, 1)) {
            consumed = true;
            break;
        }
        // An empty page before the stated last page is not the end of the
        // data; it is a listing that changed underneath the scan.
        if (posts.length === 0) break;
    }
    let scanStatus;
    if (httpError || malformed) scanStatus = "error";
    else if (matches.length > 1) scanStatus = "ambiguous";
    else if (consumed && pagesRead >= Math.max(totalPages, 1)) scanStatus = "complete";
    else scanStatus = "truncated";
    return { scanStatus, matchCount: matches.length, matches, pagesRead, totalPages, maxPages: budget, httpError: httpError ?? (malformed ? "malformed_pagination" : null) };
};

const journalFor = (ctx, requestKey) => readJsonl(journalPath(ctx.outDir)).filter((entry) => entry.requestKey === requestKey);

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const cmdAccounts = async (ctx) => {
    requireApiKey(ctx);
    const res = await callZernio(ctx, "listAccounts");
    if (res.transportError) throw new RefusalError(`transport error: ${res.transportError}`, 1);
    const accounts = Array.isArray(res.json?.accounts) ? res.json.accounts : [];
    const rows = accounts.map((account) => ({ platform: token(account.platform) ?? null, accountId: redactId(refIdOf(account)), profileId: redactId(refIdOf(account.profileId)), isActive: account.isActive ?? null }));
    const entry = { check: "C2", kind: "accounts", platform: "all", httpStatus: res.status, rateLimit: res.rateLimit, count: rows.length, rows, ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}) };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
};

const cmdPost = async (ctx) => {
    const plan = loadPlan(ctx.planPath, ctx.readFile);
    if (!Array.isArray(plan.targets) || plan.targets.length === 0) throw new RefusalError("refused: plan.targets is empty.", 1);
    const runId = randomUUID();
    const planned = plan.targets.map((target) => {
        const requestKey = randomUUID();
        return { target, requestKey, ...buildPostRequest({ plan, target, requestKey, runId }) };
    });
    if (!ctx.execute) {
        print(ctx, "dry-run: nothing was sent. With --execute the probe first verifies the allowlist against GET /v1/accounts, then journals and sends each request.");
        for (const item of planned) {
            print(ctx, {
                platform: item.target.platform,
                accountId: redactId(item.target.accountId),
                mode: item.mode,
                hasMedia: Boolean(item.body.mediaItems),
                requestKeyPrefix: item.requestKey.slice(0, 8),
                sends: plan.probeContentDedup === false ? 2 : 3,
                ...(item.target.platform === "twitter" ? { note: "X API calls are billed pass-through per request (see pricing)." } : {}),
            });
        }
        return;
    }
    requireConfirmedTestAccounts(plan);
    requireApiKey(ctx);
    await verifyAllowlistAgainstApi(ctx, plan);

    for (const item of planned) {
        const common = { platform: item.target.platform, accountId: item.target.accountId, body: item.body, requestKey: item.requestKey };
        const attempts = [
            { attempt: 1, xRequestId: item.requestKey, label: "same" },
            { attempt: 2, xRequestId: item.requestKey, label: "same" },
            ...(plan.probeContentDedup === false ? [] : [{ attempt: 3, xRequestId: randomUUID(), label: "fresh" }]),
        ];
        for (const { attempt, xRequestId, label } of attempts) {
            const res = await dispatchCreate(ctx, { ...common, attempt, xRequestId });
            const entry = {
                check: "C6",
                kind: "post-attempt",
                runId,
                platform: item.target.platform,
                accountId: redactId(item.target.accountId),
                mode: item.mode,
                requestKey: item.requestKey,
                attempt,
                xRequestId: label,
                ...(isOutcomeUnknown(res)
                    ? { state: "outcome_unknown", ...(res.transportError ? { transportError: res.transportError } : { httpStatus: res.status, error: errorSummary(res.status, res.json) }) }
                    : {
                          state: "responded",
                          httpStatus: res.status,
                          bodyHasPost: Boolean(res.json?.post),
                          bodyHasExistingPost: Boolean(res.json?.existingPost),
                          post: postSummary(res.json?.post ?? res.json?.existingPost ?? null),
                          rateLimit: res.rateLimit,
                          ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}),
                      }),
            };
            record(ctx, resultsFile(ctx.outDir), entry);
            print(ctx, entry);
            if (isOutcomeUnknown(res)) {
                print(ctx, resumeGuidance(item.requestKey));
                break;
            }
        }
    }
    print(ctx, `journal: ${journalPath(ctx.outDir)}\nresults: ${resultsFile(ctx.outDir)}`);
};

/**
 * Settles a request whose outcome is not known, according to how long ago it
 * was first dispatched. See `recoveryWindow` for the boundaries and
 * the operator's S0 runbook (kept outside this repository) for the contract
 * each branch is evidence for.
 */
const cmdResume = async (ctx, requestKey) => {
    if (!requestKey) throw new RefusalError("usage: resume <requestKey> --run <run dir of the post> --plan <file> [--execute]", 1);
    if (!ctx.runDirExplicit) throw new RefusalError("refused: resume needs --run <dir>, the run directory the post was journalled in.");
    const plan = loadPlan(ctx.planPath, ctx.readFile);
    const entries = journalFor(ctx, requestKey);
    const first = entries.find((entry) => entry.state === "dispatching");
    if (!first) throw new RefusalError(`refused: no dispatch of ${requestKey} in ${journalPath(ctx.outDir)}.`);
    const settled = entries.find((entry) => entry.state === "responded" && (entry.httpStatus < 300 || entry.existingPostId));
    if (settled) {
        print(ctx, { requestKey, state: "already_settled", httpStatus: settled.httpStatus, postId: settled.postId ?? settled.existingPostId });
        return;
    }
    const bodyFile = requestBodyPath(ctx.outDir, requestKey);
    if (!existsSync(bodyFile)) throw new RefusalError(`refused: stored body for ${requestKey} is missing; resending a rebuilt body would defeat both dedup layers.`);
    const bodyText = readFileSync(bodyFile, "utf8");
    if (sha256(bodyText) !== first.bodySha256) throw new RefusalError("refused: stored body does not match the journalled digest.");
    const body = JSON.parse(bodyText);
    const target = body.platforms?.[0];
    if (!target || !isAllowlisted(plan, target.platform, target.accountId)) throw new RefusalError("refused: the journalled request targets an account that is not in plan.allowlist.accounts.");

    const elapsedMs = (ctx.now ?? Date.now()) - Date.parse(first.at);
    const window = recoveryWindow(elapsedMs);
    if (window === "clock_skew") throw new RefusalError("refused: journal timestamp is in the future; check the clock.");
    const report = { check: "C7", kind: "resume", requestKey, platform: target.platform, elapsedSeconds: Math.round(elapsedMs / 1000), window };

    if (window === "replay_same_request_id") {
        if (!ctx.execute) {
            print(ctx, { ...report, dryRun: `would resend the stored body with the same x-request-id; expected 200 + existingPost if the first request landed.` });
            return;
        }
        requireConfirmedTestAccounts(plan);
        requireApiKey(ctx);
        await verifyAllowlistAgainstApi(ctx, plan);
        const res = await dispatchCreate(ctx, { requestKey, xRequestId: requestKey, attempt: "resume-replay", body, platform: target.platform, accountId: target.accountId });
        const entry = { ...report, action: "replayed", ...(isOutcomeUnknown(res) ? { state: "outcome_unknown", ...(res.transportError ? { transportError: res.transportError } : { httpStatus: res.status }) } : { state: "responded", httpStatus: res.status, bodyHasExistingPost: Boolean(res.json?.existingPost), post: postSummary(res.json?.post ?? res.json?.existingPost ?? null), ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}) }) };
        record(ctx, resultsFile(ctx.outDir), entry);
        print(ctx, entry);
        if (isOutcomeUnknown(res)) print(ctx, resumeGuidance(requestKey));
        return;
    }

    requireApiKey(ctx);
    const dateFrom = new Date(Date.parse(first.at) - 86_400_000).toISOString().slice(0, 10);
    const scan = await scanForRequestKey(ctx, { requestKey, accountId: target.accountId, dateFrom, maxPages: ctx.maxPages });
    const scanned = { ...report, scan: { scanStatus: scan.scanStatus, matchCount: scan.matchCount, pagesRead: scan.pagesRead, totalPages: scan.totalPages, matches: scan.matches, ...(scan.httpError ? { httpError: scan.httpError } : {}) } };

    if (scan.scanStatus === "complete" && scan.matchCount === 1) {
        const entry = { ...scanned, action: "recovered_by_lookup" };
        record(ctx, resultsFile(ctx.outDir), entry);
        print(ctx, entry);
        return;
    }
    if (scan.scanStatus !== "complete") {
        record(ctx, resultsFile(ctx.outDir), { ...scanned, action: "refused_scan_not_conclusive" });
        throw new RefusalError(`refused: scan is ${scan.scanStatus}; nothing is resent. A person decides (for truncated, retry with a larger --max-pages).`);
    }
    if (window === "list_scan_lookup") {
        record(ctx, resultsFile(ctx.outDir), { ...scanned, action: "refused_outside_dedup_windows" });
        throw new RefusalError("refused: complete scan found no match and both dedup windows have passed; a resend would be a new post. A person decides.");
    }
    // Belt and braces: a fresh request id creates a new public post unless the
    // original exists, so the resend rests only on a scan that read every page
    // the API said exists and found nothing.
    const fullyConsumed = scan.scanStatus === "complete" && scan.matchCount === 0 && Number.isInteger(scan.totalPages) && scan.pagesRead >= Math.max(scan.totalPages, 1);
    if (!fullyConsumed) {
        record(ctx, resultsFile(ctx.outDir), { ...scanned, action: "refused_scan_not_conclusive" });
        throw new RefusalError("refused: the scan did not consume every stated page; nothing is resent and the request stays outcome_unknown.");
    }
    if (!ctx.execute) {
        print(ctx, { ...scanned, dryRun: "would resend the stored body with a fresh x-request-id; expected 409 + existingPostId if the first request landed, 201 if it never did." });
        return;
    }
    requireConfirmedTestAccounts(plan);
    await verifyAllowlistAgainstApi(ctx, plan);
    const res = await dispatchCreate(ctx, { requestKey, xRequestId: randomUUID(), attempt: "resume-content-hash", body, platform: target.platform, accountId: target.accountId });
    const entry = { ...scanned, action: "resent_under_content_hash", ...(isOutcomeUnknown(res) ? { state: "outcome_unknown", ...(res.transportError ? { transportError: res.transportError } : { httpStatus: res.status }) } : { state: "responded", httpStatus: res.status, post: postSummary(res.json?.post ?? null), ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}) }) };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
    if (isOutcomeUnknown(res)) print(ctx, resumeGuidance(requestKey));
};

const cmdStatus = async (ctx, postId) => {
    if (!postId) throw new RefusalError("usage: status <postId>", 1);
    requireApiKey(ctx);
    const res = await callZernio(ctx, "getPost", { params: { postId } });
    const entry = { check: "C8", kind: "status", postId, ...(res.transportError ? { transportError: res.transportError } : { httpStatus: res.status, post: postSummary(res.json?.post), rateLimit: res.rateLimit, ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}) }) };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
};

const cmdLookup = async (ctx, requestKey) => {
    if (!requestKey) throw new RefusalError("usage: lookup <requestKey> [--account <id>] [--date-from YYYY-MM-DD] [--max-pages N]", 1);
    requireApiKey(ctx);
    const first = journalFor(ctx, requestKey).find((entry) => entry.state === "dispatching");
    let accountId = ctx.accountId;
    let platform = ctx.platform ?? first?.platform ?? null;
    if (!accountId && first && existsSync(requestBodyPath(ctx.outDir, requestKey))) {
        const target = JSON.parse(readFileSync(requestBodyPath(ctx.outDir, requestKey), "utf8")).platforms?.[0];
        accountId = target?.accountId;
        platform = platform ?? target?.platform ?? null;
    }
    const dateFrom = ctx.dateFrom ?? (first ? new Date(Date.parse(first.at) - 86_400_000) : new Date(Date.now() - 86_400_000)).toISOString().slice(0, 10);
    const scan = await scanForRequestKey(ctx, { requestKey, accountId, dateFrom, maxPages: ctx.maxPages });
    const entry = { check: "C7", kind: "lookup", requestKey, platform, accountId: redactId(accountId), dateFrom, ...scan };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
};

const cmdDelete = async (ctx, postId) => {
    if (!postId) throw new RefusalError("usage: delete <postId> --plan <file> [--platform <platform>] [--execute]", 1);
    const platform = ctx.platform;
    if (platform && !UNPUBLISH_PLATFORMS.has(platform)) {
        throw new RefusalError(
            `refused: Zernio documents unpublish as not supported on "${platform}" (${ENDPOINTS.unpublishPost.source}). ` +
                "Delete it by hand in the platform app while logged in to the test account, then record C10 as manual."
        );
    }
    const plan = loadPlan(ctx.planPath, ctx.readFile);
    const action = platform ? `unpublish post ${postId} from ${platform}` : `delete draft/scheduled post ${postId}`;
    if (!ctx.execute) {
        print(ctx, `dry-run: would verify the allowlist, read post ${postId} back, check its label, metadata and target accounts, then ${action}. Nothing was sent. Add --execute to send it.`);
        return;
    }
    requireConfirmedTestAccounts(plan);
    requireApiKey(ctx);
    await verifyAllowlistAgainstApi(ctx, plan);
    const read = await callZernio(ctx, "getPost", { params: { postId } });
    if (read.transportError || read.status !== 200) throw new RefusalError(`refused: could not read post ${postId} back (${read.transportError ?? "HTTP " + read.status}).`);
    const post = read.json?.post;
    const problems = s0PostProblems(plan, post, platform);
    if (problems.length > 0) throw new RefusalError(`refused: post ${postId} is not a recognisable S0 test post:\n  ${problems.join("\n  ")}`);
    const summary = postSummary(post);
    const res = platform
        ? await callZernio(ctx, "unpublishPost", { params: { postId }, body: { platform } })
        : await callZernio(ctx, "deletePost", { params: { postId } });
    const entry = {
        check: "C10",
        kind: platform ? "unpublish" : "delete",
        postId,
        platform: platform ?? summary.platforms.map((p) => p.platform).join(","),
        ...(res.transportError ? { state: "outcome_unknown", transportError: res.transportError } : { httpStatus: res.status, success: res.json?.success === true, ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}) }),
    };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
};

const cmdComments = async (ctx, postId) => {
    if (!postId || !ctx.accountId) throw new RefusalError("usage: comments <postId> --account <accountId> [--platform <platform>]", 1);
    requireApiKey(ctx);
    const res = await callZernio(ctx, "postComments", { params: { postId }, query: { accountId: ctx.accountId, limit: 25 } });
    const comments = Array.isArray(res.json?.comments) ? res.json.comments : [];
    const seen = [...new Set(comments.map((comment) => token(comment.platform)).filter(Boolean))];
    // Counts and capability flags only: no message text, no author fields.
    const entry = {
        check: "C11",
        kind: "comments",
        postId,
        platform: ctx.platform ?? seen[0] ?? null,
        accountId: redactId(ctx.accountId),
        ...(res.transportError
            ? { transportError: res.transportError }
            : { httpStatus: res.status, commentCount: comments.length, withReplies: comments.filter((comment) => Array.isArray(comment.replies) && comment.replies.length > 0).length, hasNextCursor: Boolean(res.json?.pagination?.cursor), ...(res.status >= 300 ? { error: errorSummary(res.status, res.json) } : {}) }),
    };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
};

const UPLOAD_CONTENT_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4" };

/**
 * Hosts a presigned `uploadUrl` may point at.
 *
 * TODO(zernio-s0): the documentation shows the upload URL only as the
 * placeholder "<presigned-upload-url>"; it names no host. The trust center says
 * media is stored on Cloudflare R2, which suggests a host but does not state
 * one. So nothing is listed here, and the probe will not PUT a test file (and,
 * with it, a bearer URL for the object) to a host nobody has documented. The
 * operator may name one exact host with `--allow-upload-host` after comparing
 * it with the trust center; that choice is recorded with the upload.
 */
export const DOCUMENTED_UPLOAD_HOSTS = [];

/** The `publicUrl` host in the create-presign example (openapi `getMediaPresignedUrl`). */
export const DOCUMENTED_PUBLIC_MEDIA_HOSTS = ["media.zernio.com"];

export const checkHttpsHost = (value, allowedHosts) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return { ok: false, reason: "unparseable_url", host: null };
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return { ok: false, reason: "not_https", host };
    if (url.username || url.password) return { ok: false, reason: "credentials_in_url", host };
    if (!allowedHosts.map((allowed) => allowed.toLowerCase()).includes(host)) return { ok: false, reason: "host_not_allowlisted", host };
    return { ok: true, reason: "ok", host };
};

const cmdUpload = async (ctx, file) => {
    if (!file) throw new RefusalError("usage: upload <file> --plan <file> [--allow-upload-host <host>] [--execute]", 1);
    const plan = loadPlan(ctx.planPath, ctx.readFile);
    const contentType = UPLOAD_CONTENT_TYPES[extname(file).toLowerCase()];
    if (!contentType) throw new RefusalError(`refused: ${extname(file)} is not one of ${Object.keys(UPLOAD_CONTENT_TYPES).join(", ")}.`);
    const bytes = ctx.readFile(file);
    const size = bytes.length;
    if (!ctx.execute) {
        print(ctx, `dry-run: would verify the allowlist, presign ${basename(file)} (${contentType}, ${size} bytes), check the upload and public URL hosts, and PUT it to Zernio temporary storage. Nothing was sent.`);
        return;
    }
    requireConfirmedTestAccounts(plan);
    requireApiKey(ctx);
    await verifyAllowlistAgainstApi(ctx, plan);
    const presign = await callZernio(ctx, "presignMedia", { body: { filename: basename(file), contentType, size } });
    if (presign.transportError || presign.status !== 200 || typeof presign.json?.uploadUrl !== "string") {
        throw new RefusalError(`presign failed: ${presign.transportError ?? JSON.stringify(errorSummary(presign.status, presign.json))}`, 1);
    }
    const base = { check: "C4", kind: "upload", platform: "all", file: basename(file), contentType, bytes: size, sha256: sha256(bytes) };
    const uploadHosts = [...DOCUMENTED_UPLOAD_HOSTS, ...(ctx.allowUploadHost ? [ctx.allowUploadHost] : [])];
    const uploadCheck = checkHttpsHost(presign.json.uploadUrl, uploadHosts);
    const publicCheck = checkHttpsHost(presign.json.publicUrl, DOCUMENTED_PUBLIC_MEDIA_HOSTS);
    if (!uploadCheck.ok || !publicCheck.ok) {
        // The presigned URL is a bearer credential for one object: only its host is recorded.
        record(ctx, resultsFile(ctx.outDir), { ...base, usable: false, refused: !uploadCheck.ok ? `upload_url_${uploadCheck.reason}` : `public_url_${publicCheck.reason}`, uploadHost: uploadCheck.host, publicHost: publicCheck.host });
        throw new RefusalError(
            !uploadCheck.ok
                ? `refused: presigned upload URL ${uploadCheck.reason} (host ${uploadCheck.host ?? "?"}). No upload host is documented; compare it with the Zernio trust center and, only if it matches, rerun with --allow-upload-host ${uploadCheck.host ?? "<host>"}.`
                : `refused: publicUrl ${publicCheck.reason} (host ${publicCheck.host ?? "?"}); documented host is ${DOCUMENTED_PUBLIC_MEDIA_HOSTS.join(", ")}. Nothing was uploaded.`
        );
    }
    let put;
    try {
        put = await ctx.fetchImpl(presign.json.uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bytes, redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
    } catch (error) {
        record(ctx, resultsFile(ctx.outDir), { ...base, usable: false, refused: "put_transport_error", transportError: transportErrorName(error), uploadHost: uploadCheck.host });
        throw new RefusalError(`upload failed: ${transportErrorName(error)}; the publicUrl is not usable.`, 1);
    }
    // A redirect is never followed: the presigned host was checked, the
    // Location was not, and following it would send the file (and whatever the
    // URL authorises) somewhere nobody looked at. `redirect: "manual"` surfaces
    // the 3xx here, and an opaque redirect reports status 0.
    if (put.status < 200 || put.status >= 300 || put.type === "opaqueredirect") {
        record(ctx, resultsFile(ctx.outDir), { ...base, usable: false, refused: put.status >= 300 && put.status < 400 || put.type === "opaqueredirect" ? "put_redirect_not_followed" : "put_not_2xx", putStatus: put.status, uploadHost: uploadCheck.host });
        throw new RefusalError(`upload failed: PUT answered HTTP ${put.status}; the publicUrl is not usable.`, 1);
    }
    const entry = { ...base, usable: true, putStatus: put.status, uploadHost: uploadCheck.host, uploadHostSource: DOCUMENTED_UPLOAD_HOSTS.includes(uploadCheck.host) ? "documented" : "operator_allowed", publicUrl: presign.json.publicUrl };
    record(ctx, resultsFile(ctx.outDir), entry);
    print(ctx, entry);
};

const cmdVisibility = async () => {
    requireConfirmed("platformVisibility");
};

const cmdWebhookListen = async (ctx) => {
    const secret = ctx.env.ZERNIO_WEBHOOK_SECRET;
    if (!secret) throw new RefusalError("refused: ZERNIO_WEBHOOK_SECRET is not set. Signature verification is the point of C9.");
    const { server } = createWebhookServer({
        secret,
        onAccepted: (meta, counters) => {
            record(ctx, webhookFile(ctx.outDir), meta);
            print(ctx, `${meta.receivedAt} ${meta.eventHeader ?? "?"} id=${meta.eventId ?? "?"} duplicate=${meta.duplicateDelivery} counters=${JSON.stringify(counters)}`);
        },
        // Rejections are counted and printed, never written.
        onRejected: ({ status, counters }) => print(ctx, `rejected HTTP ${status} counters=${JSON.stringify(counters)}`),
    });
    const port = Number(ctx.port ?? 8787);
    await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
    print(ctx, `listening on http://127.0.0.1:${port} ; accepted events -> ${webhookFile(ctx.outDir)} ; Ctrl+C to stop`);
    return server;
};

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * The media S0 needs, with what each file is for and what should happen to it.
 * Generated rather than committed: two short videos are megabytes, and a
 * generator with a manifest is the same evidence at a few kilobytes of source.
 * Synthetic test patterns only, so no person, text or brand asset can reach a
 * platform through S0.
 */
export const SAMPLE_SPECS = [
    {
        file: "s0-square-1.jpg",
        contentType: "image/jpeg",
        ffmpegArgs: ["-f", "lavfi", "-i", "testsrc2=size=1080x1080:rate=1", "-frames:v", "1", "-q:v", "3"],
        usedBy: ["C4 instagram carousel item 1", "C4 facebook/linkedin/twitter/threads image (optional)"],
        expected: "accepted: 1:1 is inside the Instagram feed aspect range 0.5625-1.91",
    },
    {
        file: "s0-square-2.jpg",
        contentType: "image/jpeg",
        ffmpegArgs: ["-f", "lavfi", "-i", "mandelbrot=size=1080x1080:rate=1", "-frames:v", "1", "-q:v", "3"],
        usedBy: ["C4 instagram carousel item 2"],
        expected: "accepted",
    },
    {
        file: "s0-wide-3to1.jpg",
        contentType: "image/jpeg",
        ffmpegArgs: ["-f", "lavfi", "-i", "testsrc2=size=1800x600:rate=1", "-frames:v", "1", "-q:v", "3"],
        usedBy: ["C14 instagram feed image (negative case)"],
        expected: "rejected: 3:1 is outside the Instagram feed aspect range 0.5625-1.91 (openapi InstagramPlatformData). If Zernio crops instead, that is the observation.",
    },
    {
        file: "s0-vertical-15s.mp4",
        contentType: "video/mp4",
        ffmpegArgs: [
            "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "15", "-c:v", "libx264", "-profile:v", "high", "-crf", "30", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-shortest",
        ],
        usedBy: ["C4 instagram reels", "C4 youtube shorts (vertical, 3 min or less)", "C4 tiktok video", "C12 youtube/tiktok visibility"],
        expected: "accepted: H.264 High + AAC, 9:16, 15 s; YouTube classifies it as a Short",
    },
];

const runTool = (binary, args) => {
    try {
        return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
        const detail = String(error?.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" / ");
        throw new RefusalError(`${basename(binary)} failed: ${error?.code ?? error?.status ?? "error"} ${detail}`.trim(), 1);
    }
};

const probeMedia = (ffprobe, file) => {
    const out = JSON.parse(runTool(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,width,height,pix_fmt:format=duration", "-of", "json", file]));
    const video = out.streams?.find((stream) => stream.codec_type === "video");
    const audio = out.streams?.find((stream) => stream.codec_type === "audio");
    return {
        width: video?.width ?? null,
        height: video?.height ?? null,
        videoCodec: video ? `${video.codec_name}${video.profile ? " " + video.profile : ""}` : null,
        pixelFormat: video?.pix_fmt ?? null,
        audioCodec: audio?.codec_name ?? null,
        durationSeconds: out.format?.duration ? Number(Number(out.format.duration).toFixed(2)) : null,
    };
};

const cmdSamples = async (ctx) => {
    const ffmpeg = ctx.env.FFMPEG_PATH ?? "ffmpeg";
    const ffprobe = ctx.env.FFPROBE_PATH ?? (ctx.env.FFMPEG_PATH ? join(dirname(ctx.env.FFMPEG_PATH), basename(ctx.env.FFMPEG_PATH).replace(/ffmpeg/i, "ffprobe")) : "ffprobe");
    const version = runTool(ffmpeg, ["-version"]).split(/\r?\n/)[0].trim();
    ensureRunDir(ctx);
    const dir = join(ctx.outDir, "samples");
    ensureDir(dir);
    const files = [];
    for (const spec of SAMPLE_SPECS) {
        const target = join(dir, spec.file);
        runTool(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...spec.ffmpegArgs, target]);
        chmodSync(target, FILE_MODE);
        const bytes = readFileSync(target);
        files.push({ file: spec.file, contentType: spec.contentType, bytes: bytes.length, sha256: sha256(bytes), ...probeMedia(ffprobe, target), usedBy: spec.usedBy, expected: spec.expected, generatedWith: spec.ffmpegArgs.join(" ") });
    }
    const manifest = { generatedAt: new Date().toISOString(), generator: "scripts/marketing/zernio-s0-probe.mjs samples", ffmpeg: version, note: "Synthetic test patterns only: no people, text, logos or brand assets.", files };
    durableWrite(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    print(ctx, manifest);
    print(ctx, `written to ${dir}`);
};

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const channelsOf = (entry) => {
    if (typeof entry.platform === "string" && entry.platform.length > 0) return entry.platform.split(",");
    const fromPost = (entry.post?.platforms ?? []).map((p) => p.platform).filter(Boolean);
    return fromPost.length > 0 ? [...new Set(fromPost)] : ["unknown"];
};

/**
 * Turns recorded observations into the draft matrix and the per-channel
 * recovery-contract draft. Every row names its channel; verdict cells stay
 * empty because verdicts are for a person.
 */
/**
 * Which recovery window a recorded outcome is evidence for (§4.1). Attempt 2
 * and a same-id replay are W1; attempt 3 and a resume in the content-hash window
 * are W2; a lookup, or a resume past both windows, is W3.
 */
const windowOf = (entry) => {
    if (entry.kind === "post-attempt") return entry.attempt === 2 ? "W1" : entry.attempt === 3 ? "W2" : null;
    if (entry.kind === "resume") return { replay_same_request_id: "W1", content_hash_409: "W2", list_scan_lookup: "W3" }[entry.window] ?? null;
    if (entry.kind === "lookup") return "W3";
    return null;
};

const outcomeText = (entry) => {
    if (entry.state === "outcome_unknown") return "outcome_unknown";
    if (entry.kind === "lookup") return `scan=${entry.scanStatus}:${entry.matchCount}`;
    if (entry.kind === "resume" && !("httpStatus" in entry)) return `${entry.action ?? "dry-run"}${entry.scan ? " scan=" + entry.scan.scanStatus + ":" + entry.scan.matchCount : ""}`;
    return `HTTP ${entry.httpStatus}${entry.bodyHasExistingPost ? "+existingPost" : ""}${entry.error?.existingPostId ? "+existingPostId" : ""}${entry.kind === "resume" ? " (resume)" : ""}`;
};

export const summarizeRecords = ({ results, webhooks, journal = [] }) => {
    const ordered = results.map((entry, index) => ({ entry, index })).sort((a, b) => (Date.parse(a.entry.at ?? "") || 0) - (Date.parse(b.entry.at ?? "") || 0) || a.index - b.index).map((item) => item.entry);
    const rows = [];
    const add = (check, channel, observation) => rows.push({ check, channel, observation });

    for (const entry of results) {
        for (const channel of channelsOf(entry)) {
            switch (entry.kind) {
                case "post-attempt":
                    add("C6", channel, `#${entry.attempt}(${entry.xRequestId}) ${entry.state === "outcome_unknown" ? "outcome_unknown " + entry.transportError : `HTTP ${entry.httpStatus}${entry.bodyHasExistingPost ? " existingPost" : ""}${entry.error?.code ? " code=" + entry.error.code : ""}${entry.error?.existingPostId ? " existingPostId" : ""}`}`);
                    break;
                case "status":
                    for (const p of (entry.post?.platforms ?? []).filter((p) => p.platform === channel)) add("C8", channel, `post ${entry.postId} ${entry.post?.status ?? "?"} / ${p.status}${p.hasPlatformPostId ? " +platformPostId" : ""}`);
                    if (!entry.post) add("C8", channel, `post ${entry.postId} ${entry.transportError ?? "HTTP " + entry.httpStatus}`);
                    break;
                case "lookup":
                    add("C7", channel, `key ${String(entry.requestKey).slice(0, 8)} scan=${entry.scanStatus} matches=${entry.matchCount} pages=${entry.pagesRead}/${entry.totalPages ?? "?"}`);
                    break;
                case "resume":
                    add("C7", channel, `resume ${String(entry.requestKey).slice(0, 8)} window=${entry.window} action=${entry.action ?? "dry-run"}${entry.scan ? " scan=" + entry.scan.scanStatus : ""}${entry.httpStatus ? " HTTP " + entry.httpStatus : ""}${entry.state === "outcome_unknown" ? " outcome_unknown" : ""}`);
                    break;
                case "unpublish":
                case "delete":
                    add("C10", channel, `${entry.kind} ${entry.postId} ${entry.state === "outcome_unknown" ? "outcome_unknown" : "HTTP " + entry.httpStatus + " success=" + entry.success}`);
                    break;
                case "comments":
                    add("C11", channel, `${entry.transportError ?? "HTTP " + entry.httpStatus} comments=${entry.commentCount ?? "?"}${entry.error?.code ? " code=" + entry.error.code : ""}`);
                    break;
                case "upload":
                    add("C4", channel, `upload ${entry.file} PUT ${entry.putStatus}`);
                    break;
                default:
                    break;
            }
        }
    }
    const withStatus = results.filter((entry) => "httpStatus" in entry);
    add("C13", "all", `responses carrying X-RateLimit headers: ${withStatus.filter((entry) => entry.rateLimit && Object.keys(entry.rateLimit).length > 0).length}/${withStatus.length}`);

    if (webhooks.length === 0) add("C9", "all", "미기록 (webhook-events.jsonl 없음)");
    const byChannel = new Map();
    for (const event of webhooks) {
        const channels = [...new Set((event.platformStatuses ?? []).map((p) => p.platform).filter(Boolean))];
        for (const channel of channels.length > 0 ? channels : ["all"]) {
            if (!byChannel.has(channel)) byChannel.set(channel, []);
            byChannel.get(channel).push(event);
        }
    }
    for (const [channel, events] of byChannel) {
        const names = [...new Set(events.map((event) => event.eventHeader).filter(Boolean))].join(", ");
        const lags = events.map((event) => event.lagSeconds).filter((value) => typeof value === "number");
        add("C9", channel, `accepted=${events.length} duplicates=${events.filter((event) => event.duplicateDelivery).length} events=[${names}] maxLagSeconds=${lags.length ? Math.max(...lags) : "-"}`);
    }

    const order = [...S0_PLATFORMS, "all", "unknown"];
    rows.sort((a, b) => a.check.localeCompare(b.check, "en", { numeric: true }) || order.indexOf(a.channel) - order.indexOf(b.channel));

    const lines = [
        "<!-- draft generated by scripts/marketing/zernio-s0-probe.mjs summarize: observations only, verdicts are for a person -->",
        "",
        "## 관측 초안 (자동 생성, 판정 없음)",
        "",
        "| check | channel | 관측 | 판정 |",
        "|---|---|---|---|",
        ...rows.map((row) => `| ${row.check} | ${row.channel} | ${row.observation.replace(/\|/g, "/")} | |`),
        "",
        "## 복구 계약 관측 초안 (§4, 판정 없음)",
        "",
        "| channel | W1 ≤4분 same x-request-id (C6 #2) | W2 4분–23시간 fresh id (C6 #3) | W3 23시간 이후 scan (C7) | outcome_unknown 미해결 | 최종 계약 | 판정 |",
        "|---|---|---|---|---|---|---|",
    ];
    for (const channel of S0_PLATFORMS) {
        const cell = (windowName) => {
            const byKey = new Map();
            for (const entry of ordered.filter((item) => channelsOf(item).includes(channel) && windowOf(item) === windowName)) {
                if (!byKey.has(entry.requestKey)) byKey.set(entry.requestKey, []);
                byKey.get(entry.requestKey).push(entry);
            }
            if (byKey.size === 0) return "미기록";
            return [...byKey].map(([key, entries]) => {
                // The latest resolved outcome wins: a resume that settled an
                // outcome_unknown attempt replaces it; an unresolved one stays.
                const resolved = entries.filter((entry) => entry.state !== "outcome_unknown");
                const latest = resolved.length > 0 ? resolved.at(-1) : entries.at(-1);
                return `${String(key).slice(0, 8)} ${outcomeText(latest)}`;
            }).join("; ");
        };
        // Unresolved: any outcome_unknown, and any request whose last journal
        // line is `dispatching` -- the process died between send and answer,
        // which is the same unknown without the courtesy of saying so.
        const keys = [...new Set(journal.filter((entry) => entry.platform === channel).map((entry) => entry.requestKey))];
        const unresolved = new Set(keys.filter((key) => {
            const lines = journal.filter((entry) => entry.requestKey === key);
            return lines.some((entry) => entry.state === "outcome_unknown") || lines.at(-1)?.state === "dispatching";
        }));
        for (const key of [...unresolved]) {
            const settled = journal.some((entry) => entry.requestKey === key && entry.state === "responded" && (entry.httpStatus < 300 || entry.existingPostId));
            const recovered = results.some((entry) => entry.kind === "resume" && entry.requestKey === key && entry.action === "recovered_by_lookup");
            if (settled || recovered) unresolved.delete(key);
        }
        lines.push(`| ${channel} | ${cell("W1")} | ${cell("W2")} | ${cell("W3")} | ${unresolved.size} | | |`);
    }
    return lines.join("\n") + "\n";
};

const cmdSummarize = async (ctx) => {
    // One run unless several are named explicitly: a default would fold every
    // past run under the base directory into this draft.
    if (!ctx.runDirExplicit) throw new RefusalError("refused: summarize needs --run <dir> (repeat --run to combine runs on purpose).");
    const missing = ctx.runDirs.filter((dir) => !existsSync(dir));
    if (missing.length > 0) throw new RefusalError(`refused: run directory not found: ${missing.join(", ")}`);
    const collect = (pick) => ctx.runDirs.flatMap((dir) => readJsonl(pick(dir)));
    const markdown = summarizeRecords({ results: collect(resultsFile), webhooks: collect(webhookFile), journal: collect(journalPath) });
    const target = join(ctx.outDir, ctx.runDirs.length > 1 ? `matrix-draft-combined-${ctx.runDirs.length}.md` : "matrix-draft.md");
    durableWrite(target, markdown);
    print(ctx, markdown);
    print(ctx, `written to ${target}`);
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: zernio-s0-probe <subcommand> [args] [options]

read-only (need ZERNIO_API_KEY)
  accounts                            connected accounts (platform + id suffixes)
  status <postId>                     post and per-platform status
  lookup <requestKey>                 scan for metadata.s0RequestKey: complete | truncated | ambiguous | error
  comments <postId> --account <id>    comment count only (no text, no authors)

writes (need --plan; send only with --execute)
  upload <file>                       presign + PUT a sample to Zernio temporary storage
  post                                journalled test posts: same x-request-id twice, then a fresh id
  resume <requestKey> --run <dir>     settle an outcome_unknown request by its recovery window
  delete <postId> [--platform p]      DELETE (draft/scheduled) or unpublish, after verifying the post is S0

local only
  samples                             generate test media + manifest.json with ffmpeg
  webhook-listen [--port 8787]        verify X-Zernio-Signature first; record accepted metadata only
  summarize --run <dir> [--run <dir>] turn one run's JSONL files (or several, named) into the matrix draft
  visibility <postId>                 refuses: no documented visibility field

options
  --plan <file>              plan with testProfileId and allowlist.accounts (required for writes)
  --execute                  send write calls (default is dry run)
  --run <dir>                use this run directory (default: a new one per invocation)
  --base-dir <dir>           where new run directories are made (default: <os tmp>/zernio-s0)
  --allow-upload-host <host> exact presigned-upload host the operator checked (none is documented)
  --max-pages <n>            lookup page budget, integer >= 1 (default ${DEFAULT_MAX_PAGES}, ${LIST_PAGE_LIMIT} posts per page)
`;

export const runCli = async (argv, deps = {}) => {
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;
    const env = deps.env ?? process.env;
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                execute: { type: "boolean", default: false },
                plan: { type: "string" },
                run: { type: "string", multiple: true },
                "base-dir": { type: "string" },
                "allow-upload-host": { type: "string" },
                platform: { type: "string" },
                account: { type: "string" },
                port: { type: "string" },
                "date-from": { type: "string" },
                "max-pages": { type: "string" },
                help: { type: "boolean", default: false },
            },
        });
    } catch (error) {
        stderr.write(`${error.message}\n${USAGE}`);
        return 1;
    }
    const [subcommand, arg] = parsed.positionals;
    const apiKey = env.ZERNIO_API_KEY ?? "";
    const ctx = {
        env,
        apiKey,
        secrets: [apiKey, env.ZERNIO_WEBHOOK_SECRET ?? ""].filter(Boolean),
        execute: parsed.values.execute,
        planPath: parsed.values.plan,
        // --run names an existing (or new) run directory explicitly; otherwise a
        // fresh one is made under the base directory on first write.
        runDirs: (parsed.values.run ?? []).map((dir) => resolve(dir)),
        runDirExplicit: (parsed.values.run ?? []).length > 0,
        outDir: parsed.values.run?.[0] ? resolve(parsed.values.run[0]) : join(resolve(parsed.values["base-dir"] ?? deps.baseDir ?? join(tmpdir(), "zernio-s0")), "runs", newRunName()),
        allowUploadHost: parsed.values["allow-upload-host"],
        platform: parsed.values.platform,
        accountId: parsed.values.account,
        port: parsed.values.port,
        dateFrom: parsed.values["date-from"],
        maxPages: parsed.values["max-pages"] ?? DEFAULT_MAX_PAGES,
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
        readFile: deps.readFile ?? readFileSync,
        timeoutMs: deps.timeoutMs,
        now: deps.now,
        stdout,
    };
    const commands = {
        accounts: () => cmdAccounts(ctx),
        status: () => cmdStatus(ctx, arg),
        lookup: () => cmdLookup(ctx, arg),
        comments: () => cmdComments(ctx, arg),
        upload: () => cmdUpload(ctx, arg),
        post: () => cmdPost(ctx),
        resume: () => cmdResume(ctx, arg),
        delete: () => cmdDelete(ctx, arg),
        samples: () => cmdSamples(ctx),
        visibility: () => cmdVisibility(ctx, arg),
        "webhook-listen": () => cmdWebhookListen(ctx),
        summarize: () => cmdSummarize(ctx),
    };
    if (parsed.values.help || !subcommand || !commands[subcommand]) {
        (parsed.values.help ? stdout : stderr).write(USAGE);
        return parsed.values.help ? 0 : 1;
    }
    try {
        ctx.maxPages = validateMaxPages(ctx.maxPages);
        await commands[subcommand]();
        return 0;
    } catch (error) {
        const exitCode = error instanceof RefusalError ? error.exitCode : 1;
        stderr.write(redactText(error instanceof RefusalError ? error.message : `error: ${error?.name ?? "Error"} ${error?.code ?? ""}`.trim(), ctx.secrets) + "\n");
        return exitCode;
    }
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    const code = await runCli(process.argv.slice(2));
    const subcommand = process.argv.slice(2).find((value) => !value.startsWith("-"));
    if (!(subcommand === "webhook-listen" && code === 0)) process.exitCode = code;
}
