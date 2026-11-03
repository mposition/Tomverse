import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";
import { MARKETING_REPORT_RETENTION } from "../lib/marketingAutomationSchema.ts";
import { MARKETING_COMMENT_BODY_MAX_CHARS } from "../lib/marketingCommentsMonitor.ts";
import { isAnalyticsUserId } from "../lib/ga4UserIdPolicy.ts";
import { newAnalyticsUserId } from "../lib/ga4UserId.ts";

// The privacy policy sections for comment monitoring and the GA4 User-ID
// (docs/policy/marketing-automation.md sections 10.2 and 12.1). The text is
// public, so what it states about the code is held to the code's own
// constants, and what is not yet confirmed carries a placeholder that is
// listed here, in one place, until the operator resolves it.

const LOCALES = { en, ko, zh, fr, de, es, pt };

const COMMENT_KEYS = [
    "commentsTitle",
    "comments",
    "commentsTransferTitle",
    ...Array.from({ length: 8 }, (_, i) => `commentsTransfer${i + 1}`),
];
const USER_ID_KEYS = [
    "analyticsUserIdTitle",
    ...Array.from({ length: 6 }, (_, i) => `analyticsUserId${i + 1}`),
];

/**
 * The facts the operator still has to confirm. Each is a placeholder in the
 * locale text, and each locale carries the same ones. Resolve one by writing
 * the confirmed fact into every locale and removing it from this list; the
 * checklist is docs/policy/marketing-privacy-dpia-checklist.md.
 */
const PENDING_CONFIRMATIONS = {
    commentsTransfer3: "Zernio's legal entity and country",
    commentsTransfer6: "legal basis for reading public comments",
    commentsTransfer7: "how long Zernio and OpenAI keep the comment text",
};
const PLACEHOLDER = /\[(?:운영자 확인 필요|OPERATOR CONFIRMATION REQUIRED)\]/;

test("every locale carries every comment-monitoring and User-ID key, non-empty", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of [...COMMENT_KEYS, ...USER_ID_KEYS]) {
            const value = bundle.privacyPolicy?.[key];
            assert.equal(typeof value, "string", `${name}.privacyPolicy.${key}`);
            assert.ok(value.trim().length > 5, `${name}.privacyPolicy.${key} is empty or a stub`);
        }
    }
});

test("the page renders every one of those keys", () => {
    const source = readFileSync("components/legal/PrivacyPolicy.tsx", "utf8");
    for (const key of ["commentsTitle", "comments", "commentsTransferTitle", "analyticsUserIdTitle"]) {
        assert.ok(
            source.includes(`"${key}"`) || source.includes(`privacyPolicy.${key}`),
            `${key} is not rendered`
        );
    }
    for (const prefix of ["commentsTransfer", "analyticsUserId"]) {
        const count = prefix === "commentsTransfer" ? 8 : 6;
        for (let i = 1; i <= count; i++) {
            assert.ok(source.includes(`"${prefix}${i}"`), `${prefix}${i} is not in a rendered list`);
        }
    }
});

test("placeholders are exactly the listed pending confirmations, the same in every locale", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const found = Object.entries(bundle.privacyPolicy)
            .filter(([, value]) => typeof value === "string" && PLACEHOLDER.test(value))
            .map(([key]) => key)
            .sort();
        assert.deepEqual(found, Object.keys(PENDING_CONFIRMATIONS).sort(), name);
    }
});

test("the stated retention and limits are the code's own", () => {
    assert.deepEqual(MARKETING_REPORT_RETENTION.comment_alerts, { unit: "day", amount: 90 });
    assert.equal(MARKETING_COMMENT_BODY_MAX_CHARS, 1000);
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const copy = bundle.privacyPolicy;
        assert.match(copy.commentsTransfer7, /\b90\b/, `${name}: alert retention`);
        assert.match(copy.retention, /\b90\b/, `${name}: retention section`);
        assert.match(copy.commentsTransfer1, /1[,.\s]?000/, `${name}: comment length`);
    }
});

test("the User-ID the notice describes is 128 random bits, not derived from the account", () => {
    const id = newAnalyticsUserId();
    assert.equal(isAnalyticsUserId(id), true);
    assert.equal(id.length * 4, 128);
    assert.notEqual(id, newAnalyticsUserId());
    for (const [name, bundle] of Object.entries(LOCALES)) {
        assert.match(bundle.privacyPolicy.analyticsUserId1, /128/, `${name}: 128 bits`);
    }
});

test("the notice does not promise what the monitor does not do", () => {
    // The monitor reads, classifies and opens alerts. These are the verbs the
    // English text must not claim for it.
    const text = en.privacyPolicy.comments + en.privacyPolicy.commentsTransfer5;
    assert.doesNotMatch(text, /\b(profile|profiling|advertis|sell|sold|train)/i);
    const source = readFileSync("lib/marketingCommentsMonitor.ts", "utf8");
    assert.doesNotMatch(source, /\b(hideComment|deleteComment|replyToComment|postReply)\b/);
});
