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
import { SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED } from "../lib/privacyNoticeStatus.ts";
import {
    SEMANTIC_RETRIEVAL_LIMITS,
    SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED,
} from "../lib/semanticRetrievalCore.ts";

// The privacy policy section for semantic search (docs/policy/external-
// conversation-import-and-memory.md sections 9a and 16). The text is public, so
// what it states about the code is held to the code's own constants, and a fact
// the operator has not confirmed yet carries a placeholder listed in
// PENDING_CONFIRMATIONS, in one place. While any placeholder is left the page
// must not render the section and no semantic call may run -- both read the
// one flag in lib/privacyNoticeStatus.ts -- and the flag cannot be true with a
// placeholder still in any locale. (zhHant reuses the English copy.)

const LOCALES = { en, ko, zh, fr, de, es, pt };

const KEYS = [
    "semanticSearchTitle",
    "semanticSearch",
    "semanticSearchTransferTitle",
    ...Array.from({ length: 8 }, (_, i) => `semanticSearchTransfer${i + 1}`),
];

/**
 * The facts the operator still has to confirm, each mapped to the one key that
 * carries its placeholder in every locale. Resolve one by writing the confirmed
 * fact into every locale and removing it here; when the list is empty, set
 * SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED to true (that flip is the operator's
 * approval of the new /privacy version).
 */
const PENDING_CONFIRMATIONS = {
    // The country where Cohere processes and stores API requests.
    processingCountry: "semanticSearchTransfer2",
    // That Tomverse has opted out of Cohere using the data for training.
    trainingOptOut: "semanticSearchTransfer5",
    // How long Cohere keeps the requests (30 days by default, none under zero data retention).
    retention: "semanticSearchTransfer6",
};
const PLACEHOLDER = /\[(?:운영자 확인 필요|OPERATOR CONFIRMATION REQUIRED)\]/;
const placeholderFor = (name) => (name === "ko" ? "[운영자 확인 필요]" : "[OPERATOR CONFIRMATION REQUIRED]");
const occurrences = (text, needle) => text.split(needle).length - 1;

test("every locale carries every semantic-search key, non-empty", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of KEYS) {
            const value = bundle.privacyPolicy?.[key];
            assert.equal(typeof value, "string", `${name}.privacyPolicy.${key}`);
            assert.ok(value.trim().length > 5, `${name}.privacyPolicy.${key} is empty or a stub`);
        }
    }
});

test("the page renders every one of those keys", () => {
    const source = readFileSync("components/legal/PrivacyPolicy.tsx", "utf8");
    for (const key of ["semanticSearchTitle", "semanticSearch", "semanticSearchTransferTitle"]) {
        assert.ok(
            source.includes(`"${key}"`) || source.includes(`privacyPolicy.${key}`),
            `${key} is not rendered`
        );
    }
    for (let i = 1; i <= 8; i++) {
        assert.ok(source.includes(`"semanticSearchTransfer${i}"`), `semanticSearchTransfer${i} is not in a rendered list`);
    }
});

test("placeholders are exactly the pending confirmations, once each, the same in every locale, and none once confirmed", () => {
    const expected = SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED ? [] : Object.values(PENDING_CONFIRMATIONS).sort();
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const found = Object.entries(bundle.privacyPolicy)
            .filter(([, value]) => typeof value === "string" && PLACEHOLDER.test(value))
            .map(([key]) => key)
            .sort();
        assert.deepEqual(found, expected, name);
        for (const key of found) {
            const value = bundle.privacyPolicy[key];
            assert.equal(occurrences(value, placeholderFor(name)), 1, `${name}.${key}: one placeholder, in the locale's own form`);
            // The other form must not leak into this locale.
            const other = name === "ko" ? "[OPERATOR CONFIRMATION REQUIRED]" : "[운영자 확인 필요]";
            assert.equal(occurrences(value, other), 0, `${name}.${key}: wrong placeholder form`);
        }
    }
});

test("the placeholder keys are the ones the notice assigns to the three open facts", () => {
    assert.deepEqual(Object.keys(PENDING_CONFIRMATIONS).sort(), ["processingCountry", "retention", "trainingOptOut"]);
    for (const key of Object.values(PENDING_CONFIRMATIONS)) {
        assert.ok(KEYS.includes(key), key);
    }
    assert.equal(new Set(Object.values(PENDING_CONFIRMATIONS)).size, 3);
});

test("the page renders the section only when the flag is confirmed", () => {
    const source = readFileSync("components/legal/PrivacyPolicy.tsx", "utf8").replace(/\r\n/g, "\n");
    assert.match(source, /import \{ SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED \} from "@\/lib\/privacyNoticeStatus"/);
    assert.match(
        source,
        /\.filter\(\s*\(\[, bodyKey\]\) =>\s*bodyKey !== "semanticSearch" \|\| SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED\s*\)/
    );
    assert.match(source, /visibleSections\.map\(/);
    assert.doesNotMatch(source, /[^e]sections\.map\(/, "the unfiltered list must not be rendered");
    // The section sits right after the assistant profiles one.
    assert.match(
        source,
        /\["assistantProfilesTitle", "assistantProfiles", \w+\],[\s\S]*?\["semanticSearchTitle", "semanticSearch", \w+\],/
    );
});

test("the notice is on the page exactly when the semantic calls are allowed", () => {
    assert.equal(SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED, SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED);
    const core = readFileSync("lib/semanticRetrievalCore.ts", "utf8");
    assert.match(core, /import \{ SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED \} from "@\/lib\/privacyNoticeStatus"/);
});

test("the stated limits are the code's own", () => {
    const minutes = SEMANTIC_RETRIEVAL_LIMITS.cacheTtlMs / 60_000;
    assert.equal(minutes, 10);
    assert.equal(SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments, 100);
    assert.equal(SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes, 400);

    assert.match(ko.privacyPolicy.semanticSearch, new RegExp(`${minutes}분 동안`));
    assert.match(ko.privacyPolicy.semanticSearchTransfer1, new RegExp(`${SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes}바이트`));
    assert.match(ko.privacyPolicy.semanticSearchTransfer1, new RegExp(`최대 ${SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments}개`));

    assert.match(en.privacyPolicy.semanticSearch, /for ten minutes after it was last used/);
    assert.match(en.privacyPolicy.semanticSearchTransfer1, new RegExp(`first ${SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes} bytes`));
    assert.match(en.privacyPolicy.semanticSearchTransfer1, new RegExp(`at most ${SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments} at a time`));

    // Every translation carries the same two numbers.
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const copy = bundle.privacyPolicy.semanticSearchTransfer1;
        assert.match(copy, new RegExp(`\\b${SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes}\\b`), `${name}: query bytes`);
        assert.match(copy, new RegExp(`\\b${SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments}\\b`), `${name}: documents per call`);
        assert.match(bundle.privacyPolicy.semanticSearchTransfer6, /\b30\b/, `${name}: Cohere's logging period`);
    }
});

test("core, pinned and answer-style memories are stated as never sent, in Korean and English", () => {
    const koText = ko.privacyPolicy.semanticSearch + ko.privacyPolicy.semanticSearchTransfer1;
    assert.match(koText, /핵심 기억/);
    assert.match(koText, /직접 고정한 기억|고정한 기억/);
    assert.match(koText, /답변 스타일 기억/);
    assert.match(ko.privacyPolicy.semanticSearch, /보내지 않습니다/);
    assert.match(ko.privacyPolicy.semanticSearchTransfer1, /이전하지 않습니다/);

    const enText = en.privacyPolicy.semanticSearch + en.privacyPolicy.semanticSearchTransfer1;
    assert.match(enText, /Core memories|core memories/);
    assert.match(enText, /memories you pinned|pinned memories/);
    assert.match(enText, /answer-style memories/i);
    assert.match(en.privacyPolicy.semanticSearch, /never sent/);
    // "sends", not "transferred": the marketing claim guard reads "memories ... transferred"
    // as a replication claim (docs/policy/external-conversation-import-and-memory.md §17).
    assert.match(en.privacyPolicy.semanticSearchTransfer1, /never sends core memories/);
});

test("the notice says no account identifier, email or IP is attached, and that the lexical search sends nothing", () => {
    assert.match(ko.privacyPolicy.semanticSearch, /계정 식별자, 이메일, 클라이언트 IP를 붙이지 않습니다/);
    assert.match(ko.privacyPolicy.semanticSearch, /Cohere로 전송하지 않습니다/);
    assert.match(en.privacyPolicy.semanticSearch, /do not include your account identifier, email address or client IP address/);
    assert.match(en.privacyPolicy.semanticSearch, /nothing is sent to Cohere/);
});

test("every locale names the recipient and its privacy contact", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        assert.match(bundle.privacyPolicy.semanticSearchTransfer4, /Cohere Inc\./, `${name}: recipient`);
        assert.match(bundle.privacyPolicy.semanticSearchTransfer4, /privacy@cohere\.com/, `${name}: contact`);
        assert.match(bundle.privacyPolicy.semanticSearchTransfer2, /Cohere Inc\./, `${name}: entity beside the country`);
    }
});

test("text outside the semantic-search section never carries a placeholder", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of ["memory", "assistantProfiles", "retention", "rights", "providers", "collected", "purpose"]) {
            assert.doesNotMatch(bundle.privacyPolicy[key], PLACEHOLDER, `${name}.${key}`);
        }
    }
});
