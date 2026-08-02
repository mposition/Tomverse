import assert from "node:assert/strict";
import { test } from "node:test";
import {
    admissionSlotFor,
    issueAdmissionToken,
    verifyAdmissionToken,
} from "../lib/chatAdmissionCore.ts";

const SECRET = "test-secret-value-that-is-long-enough";
const OTHER_SECRET = "a-completely-different-secret-value!!";

const payload = (overrides = {}) => ({
    version: 1,
    admissionId: "adm-1",
    subjectKey: "guest:alice",
    comparisonId: "1754000000000",
    slots: [
        { leaseId: "lease-a", modelId: "gpt-5-6-luna" },
        { leaseId: "lease-b", modelId: "claude-opus-4-8" },
        { leaseId: "lease-c", modelId: "gemini-3-1-pro" },
    ],
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
});

test("a freshly issued token verifies and round-trips every slot", () => {
    const source = payload();
    const verified = verifyAdmissionToken(issueAdmissionToken(source, SECRET), {
        secret: SECRET,
        subjectKey: source.subjectKey,
    });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.payload.slots, source.slots);
    assert.equal(verified.payload.admissionId, "adm-1");
    assert.equal(verified.payload.comparisonId, "1754000000000");
});

test("a token signed with another secret is refused", () => {
    const token = issueAdmissionToken(payload(), OTHER_SECRET);
    const verified = verifyAdmissionToken(token, {
        secret: SECRET,
        subjectKey: "guest:alice",
    });
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, "invalid_signature");
});

test("editing the body invalidates the signature", () => {
    const token = issueAdmissionToken(payload(), SECRET);
    const [body, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.l.push(["lease-forged", "gpt-5-5-thinking"]);
    const forged = `${Buffer.from(JSON.stringify(decoded), "utf8").toString(
        "base64url"
    )}.${signature}`;

    const verified = verifyAdmissionToken(forged, {
        secret: SECRET,
        subjectKey: "guest:alice",
    });
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, "invalid_signature");
});

test("another guest session cannot use a token issued to this one", () => {
    const token = issueAdmissionToken(payload(), SECRET);
    const verified = verifyAdmissionToken(token, {
        secret: SECRET,
        subjectKey: "guest:mallory",
    });
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, "subject_mismatch");
});

test("an expired token is refused even though it is authentically signed", () => {
    const token = issueAdmissionToken(
        payload({ expiresAtMs: Date.now() - 1 }),
        SECRET
    );
    const verified = verifyAdmissionToken(token, {
        secret: SECRET,
        subjectKey: "guest:alice",
    });
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, "expired");
});

test("expiry is evaluated against the supplied clock, not only wall time", () => {
    const expiresAtMs = Date.parse("2026-08-02T00:01:00.000Z");
    const token = issueAdmissionToken(payload({ expiresAtMs }), SECRET);

    assert.equal(
        verifyAdmissionToken(token, {
            secret: SECRET,
            subjectKey: "guest:alice",
            now: new Date("2026-08-02T00:00:30.000Z"),
        }).ok,
        true
    );
    assert.equal(
        verifyAdmissionToken(token, {
            secret: SECRET,
            subjectKey: "guest:alice",
            now: new Date("2026-08-02T00:01:30.000Z"),
        }).reason,
        "expired"
    );
});

test("a model that was never admitted cannot borrow the comparison's token", () => {
    const token = issueAdmissionToken(payload(), SECRET);
    const verified = verifyAdmissionToken(token, {
        secret: SECRET,
        subjectKey: "guest:alice",
        modelId: "gpt-5-4-mini",
    });
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, "model_not_admitted");
});

test("garbage, empty and oversized inputs are refused rather than thrown on", () => {
    for (const token of ["", "not-a-token", "a.b", "x".repeat(5_000)]) {
        const verified = verifyAdmissionToken(token, {
            secret: SECRET,
            subjectKey: "guest:alice",
        });
        assert.equal(verified.ok, false);
    }
});

test("a token carrying more slots than a comparison can have is malformed", () => {
    const oversized = {
        v: 1,
        a: "adm",
        s: "guest:alice",
        c: "1",
        l: Array.from({ length: 4 }, (_, index) => [`l${index}`, `m${index}`]),
        e: Date.now() + 60_000,
    };
    const body = Buffer.from(JSON.stringify(oversized), "utf8").toString(
        "base64url"
    );
    // Signed properly, so only the payload shape can reject it.
    const token = issueAdmissionToken(
        {
            version: 1,
            admissionId: "adm",
            subjectKey: "guest:alice",
            comparisonId: "1",
            slots: [{ leaseId: "l", modelId: "m" }],
            expiresAtMs: Date.now() + 60_000,
        },
        SECRET
    );
    const signature = token.split(".")[1];
    const verified = verifyAdmissionToken(`${body}.${signature}`, {
        secret: SECRET,
        subjectKey: "guest:alice",
    });
    assert.equal(verified.ok, false);
});

test("admissionSlotFor picks this model's own slot and nothing else", () => {
    const source = payload();
    assert.deepEqual(admissionSlotFor(source, "claude-opus-4-8"), {
        leaseId: "lease-b",
        modelId: "claude-opus-4-8",
    });
    assert.equal(admissionSlotFor(source, "not-in-this-run"), null);
});
