import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
    bundleConsumptionKey,
    contextFingerprint,
    decideBundleStaleRecovery,
    issueContextBundle,
    memoryStateFingerprint,
    verifyContextBundle,
} from "../lib/chatContextBundleCore.ts";
import { issueAdmissionToken, verifyAdmissionToken } from "../lib/chatAdmissionCore.ts";

/**
 * Context bundles (§10).
 *
 * The bundle exists so a request cannot be priced against one prompt and run
 * against another. The assertions below are about the ways that could still
 * happen: an edited bundle, a stolen one, an expired one, a panel that was
 * never priced, and above all a context that changed while the request was in
 * flight.
 */

const SECRET = "qa-context-bundle-secret";
const NOW = new Date("2026-08-04T00:00:00.000Z");

const fingerprintInput = (overrides = {}) => ({
    memoryMode: "on",
    memoryVersion: "12:1754265600000",
    styleVersion: "style-3",
    profileVersion: null,
    retrievalHash: "abc123",
    retrievalVersion: 1,
    promptVersion: "mem-context-v1",
    knowledgeHash: "none",
    ...overrides,
});

const payload = (overrides = {}) => ({
    version: 1,
    bundleId: "bundle-1",
    subjectKey: "user:u-1",
    conversationId: "conv-1",
    modelIds: ["gpt-5-6-luna"],
    memoryTokens: 120,
    profileTokens: 0,
    expiresAtMs: NOW.getTime() + 60_000,
    ...fingerprintInput(),
    ...overrides,
});

const verifyOptions = (overrides = {}) => ({
    secret: SECRET,
    subjectKey: "user:u-1",
    conversationId: "conv-1",
    modelId: "gpt-5-6-luna",
    now: NOW,
    ...overrides,
});

/* ------------------------------------------------------------ round trip -- */

test("a freshly issued bundle verifies and returns what was priced", () => {
    const token = issueContextBundle(payload(), SECRET);
    const result = verifyContextBundle(token, verifyOptions());
    assert.equal(result.ok, true);
    assert.equal(result.payload.memoryTokens, 120);
    assert.equal(result.payload.bundleId, "bundle-1");
    assert.equal(result.payload.promptVersion, "mem-context-v1");
});

test("a conversation that does not exist yet is a valid binding", () => {
    const token = issueContextBundle(payload({ conversationId: null }), SECRET);
    const result = verifyContextBundle(
        token,
        verifyOptions({ conversationId: null })
    );
    assert.equal(result.ok, true);
});

/* -------------------------------------------------------------- forgery  -- */

test("an edited body fails the signature, not a field check", () => {
    const token = issueContextBundle(payload(), SECRET);
    const [body, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.t = 0; // claim the memory block cost nothing
    const forged = `${Buffer.from(JSON.stringify(decoded), "utf8").toString(
        "base64url"
    )}.${signature}`;
    assert.deepEqual(verifyContextBundle(forged, verifyOptions()), {
        ok: false,
        reason: "invalid_signature",
    });
});

test("another secret cannot mint a usable bundle", () => {
    const token = issueContextBundle(payload(), "some-other-secret");
    assert.equal(verifyContextBundle(token, verifyOptions()).reason, "invalid_signature");
});

test("garbage is malformed rather than throwing", () => {
    for (const token of ["", "no-separator", "...", "a.b"]) {
        const result = verifyContextBundle(token, verifyOptions());
        assert.equal(result.ok, false);
        assert.ok(["malformed", "invalid_signature"].includes(result.reason));
    }
});

test("an over-long token is rejected before any parsing", () => {
    const result = verifyContextBundle(`${"a".repeat(9000)}.sig`, verifyOptions());
    assert.deepEqual(result, { ok: false, reason: "malformed" });
});

/* -------------------------------------------------------------- bindings -- */

test("a bundle issued for another subject is refused verbatim", () => {
    const token = issueContextBundle(payload({ subjectKey: "user:u-2" }), SECRET);
    assert.equal(verifyContextBundle(token, verifyOptions()).reason, "subject_mismatch");
});

test("a bundle priced for another conversation is refused", () => {
    const token = issueContextBundle(payload({ conversationId: "conv-9" }), SECRET);
    assert.equal(
        verifyContextBundle(token, verifyOptions()).reason,
        "conversation_mismatch"
    );
});

test("a model that was never priced is not admitted by the set", () => {
    const token = issueContextBundle(payload(), SECRET);
    assert.equal(
        verifyContextBundle(token, verifyOptions({ modelId: "gpt-5-4-mini" }))
            .reason,
        "model_not_bound"
    );
});

test("every panel of a comparison verifies against the one shared bundle", () => {
    const models = ["gpt-5-6-luna", "gpt-5-4-mini", "claude-fable-5"];
    const token = issueContextBundle(payload({ modelIds: models }), SECRET);
    for (const modelId of models) {
        const result = verifyContextBundle(token, verifyOptions({ modelId }));
        assert.equal(result.ok, true, `${modelId} must verify`);
        assert.equal(result.payload.bundleId, "bundle-1", "one lineage");
    }
});

test("an expired bundle is refused even if nothing else changed", () => {
    const token = issueContextBundle(payload(), SECRET);
    const later = new Date(NOW.getTime() + 61_000);
    assert.equal(
        verifyContextBundle(token, verifyOptions({ now: later })).reason,
        "expired"
    );
});

/* ------------------------------------------------------------- freshness -- */

test("a matching fingerprint passes the freshness check", () => {
    const token = issueContextBundle(payload(), SECRET);
    const result = verifyContextBundle(
        token,
        verifyOptions({
            currentFingerprint: contextFingerprint(fingerprintInput()),
        })
    );
    assert.equal(result.ok, true);
});

test("every part of the context makes the bundle stale when it moves", () => {
    const token = issueContextBundle(payload(), SECRET);
    const changes = [
        { memoryMode: "off" },
        { memoryVersion: "13:1754265600000" },
        { styleVersion: "style-4" },
        { profileVersion: "profile-1" },
        { retrievalHash: "def456" },
        { retrievalVersion: 2 },
        { promptVersion: "mem-context-v2" },
        { knowledgeHash: "1|profile-context-v1|f-a:0" },
    ];
    for (const change of changes) {
        const result = verifyContextBundle(
            token,
            verifyOptions({
                currentFingerprint: contextFingerprint(fingerprintInput(change)),
            })
        );
        assert.equal(
            result.reason,
            "stale",
            `${Object.keys(change)[0]} must invalidate the bundle`
        );
    }
});

test("a knowledge retrieval that returned different excerpts is stale", () => {
    // Release C's own half of the same rule. Bound apart from `retrievalHash`
    // so a changed knowledge file and a changed memory are distinguishable in
    // the record of why a bundle stopped matching.
    const token = issueContextBundle(
        payload({ knowledgeHash: "1|profile-context-v1|f-a:0,f-b:2" }),
        SECRET
    );
    const result = verifyContextBundle(
        token,
        verifyOptions({
            currentFingerprint: contextFingerprint(
                fingerprintInput({
                    knowledgeHash: "1|profile-context-v1|f-a:0,f-c:1",
                })
            ),
        })
    );
    assert.equal(result.reason, "stale");
});

test("a bundle issued before profiles were bound still verifies", () => {
    // The rolling-deploy case. A bundle lives five minutes, so the two
    // Release C fields are read tolerantly: absent means "no profile", which
    // is the same context a turn without one has. Refusing it as malformed
    // would answer an aged-out bundle with INVALID_CONTEXT_BUNDLE, telling the
    // client its request was wrong rather than that its context expired.
    const legacyFingerprint = fingerprintInput();
    const legacyBody = Buffer.from(
        JSON.stringify({
            v: 1,
            b: "bundle-1",
            s: "user:u-1",
            c: "conv-1",
            m: ["gpt-5-6-luna"],
            mode: legacyFingerprint.memoryMode,
            mv: legacyFingerprint.memoryVersion,
            sv: legacyFingerprint.styleVersion,
            pv: legacyFingerprint.profileVersion,
            rh: legacyFingerprint.retrievalHash,
            rv: legacyFingerprint.retrievalVersion,
            prv: legacyFingerprint.promptVersion,
            t: 120,
            e: NOW.getTime() + 60_000,
        }),
        "utf8"
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET)
        .update(`chat-context-bundle.v1.${legacyBody}`)
        .digest("base64url");
    const result = verifyContextBundle(
        `${legacyBody}.${signature}`,
        verifyOptions({
            currentFingerprint: contextFingerprint(fingerprintInput()),
        })
    );
    assert.equal(result.ok, true);
    assert.equal(result.payload.knowledgeHash, "none");
    assert.equal(result.payload.profileTokens, 0);
});

test("a present Release C field of the wrong type is still refused", () => {
    // Tolerance is for the old shape, never for a forged one.
    const body = Buffer.from(
        JSON.stringify({
            v: 1,
            b: "bundle-1",
            s: "user:u-1",
            c: "conv-1",
            m: ["gpt-5-6-luna"],
            mode: "on",
            mv: "12:1754265600000",
            sv: "style-3",
            pv: null,
            rh: "abc123",
            rv: 1,
            prv: "mem-context-v1",
            kh: 7,
            t: 120,
            e: NOW.getTime() + 60_000,
        }),
        "utf8"
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET)
        .update(`chat-context-bundle.v1.${body}`)
        .digest("base64url");
    assert.equal(
        verifyContextBundle(`${body}.${signature}`, verifyOptions()).reason,
        "malformed"
    );
});

test("turning memory off is a different context, not an absent one", () => {
    // The failure this guards: treating "off" as "nothing to compare" and
    // running a memory-priced request with memory disabled.
    assert.notEqual(
        contextFingerprint(fingerprintInput({ memoryMode: "on" })),
        contextFingerprint(fingerprintInput({ memoryMode: "off" }))
    );
});

test("omitting the current fingerprint checks the signature but not freshness", () => {
    // Documented behaviour, asserted so it cannot become an accidental bypass:
    // callers that skip it get a signature check only.
    const token = issueContextBundle(payload(), SECRET);
    assert.equal(verifyContextBundle(token, verifyOptions()).ok, true);
});

test("the memory state fingerprint moves with count and with edits", () => {
    const base = { activeCount: 12, latestUpdatedAtMs: 1754265600000 };
    assert.notEqual(
        memoryStateFingerprint(base),
        memoryStateFingerprint({ ...base, activeCount: 13 })
    );
    assert.notEqual(
        memoryStateFingerprint(base),
        memoryStateFingerprint({ ...base, latestUpdatedAtMs: 1754265600001 })
    );
    assert.equal(memoryStateFingerprint(base), memoryStateFingerprint({ ...base }));
});

/* ------------------------------------------------- separation of concerns -- */

test("an admission token can never verify as a context bundle", () => {
    // §10's role separation, enforced by the signing domain rather than by
    // whoever remembers to check which value they were handed.
    const admission = issueAdmissionToken(
        {
            version: 1,
            admissionId: "adm-1",
            subjectKey: "user:u-1",
            comparisonId: "cmp-1",
            slots: [{ leaseId: "lease-1", modelId: "gpt-5-6-luna" }],
            expiresAtMs: NOW.getTime() + 60_000,
        },
        SECRET
    );
    const asBundle = verifyContextBundle(admission, verifyOptions());
    assert.equal(asBundle.ok, false);
    assert.equal(asBundle.reason, "invalid_signature");
});

test("a context bundle can never verify as an admission token", () => {
    const bundle = issueContextBundle(payload(), SECRET);
    const asAdmission = verifyAdmissionToken(bundle, {
        secret: SECRET,
        subjectKey: "user:u-1",
        now: NOW,
    });
    assert.equal(asAdmission.ok, false);
    assert.equal(asAdmission.reason, "invalid_signature");
});

/* -------------------------------------------------------------- recovery -- */

test("a single-model request re-preflights and retries exactly once", () => {
    assert.deepEqual(
        decideBundleStaleRecovery({
            layout: "single",
            priorAutomaticRetries: 0,
            streamStarted: false,
        }),
        { action: "retry_after_preflight" }
    );
    assert.deepEqual(
        decideBundleStaleRecovery({
            layout: "single",
            priorAutomaticRetries: 1,
            streamStarted: false,
        }),
        { action: "surface_to_user", reason: "already_retried" }
    );
});

test("nothing retries automatically once bytes have been shown", () => {
    for (const layout of ["single", "comparison"]) {
        assert.deepEqual(
            decideBundleStaleRecovery({
                layout,
                priorAutomaticRetries: 0,
                streamStarted: true,
            }),
            { action: "surface_to_user", reason: "stream_started" },
            `${layout} must not replace an answer already being read`
        );
    }
});

test("a comparison re-preflights as a whole, never one panel", () => {
    assert.deepEqual(
        decideBundleStaleRecovery({
            layout: "comparison",
            priorAutomaticRetries: 0,
            streamStarted: false,
        }),
        { action: "repreflight_all" }
    );
});

/* ----------------------------------------------------------- consumption -- */

test("consumption is counted per model, so a comparison is not self-blocking", () => {
    assert.notEqual(
        bundleConsumptionKey("bundle-1", "gpt-5-6-luna"),
        bundleConsumptionKey("bundle-1", "gpt-5-4-mini")
    );
    assert.equal(
        bundleConsumptionKey("bundle-1", "gpt-5-6-luna"),
        bundleConsumptionKey("bundle-1", "gpt-5-6-luna")
    );
});
