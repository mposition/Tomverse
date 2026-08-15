import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROVIDER_LABELS } from "../components/imports/importFormatting.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §16.
 *
 * Release A starts a new processing activity — conversations exported from a
 * third-party AI service, which may contain other people's personal data —
 * so the privacy policy has to describe it in every supported locale, in the
 * same release. Parity is checked statically rather than by rendering seven
 * privacy pages in E2E; ko/en render coverage lives in the E2E suite.
 */

const LOCALES = { ko, en, zh, fr, de, es, pt };
const KEYS = ["externalImportTitle", "externalImport"];

test("every supported locale carries the external import privacy copy", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        for (const key of KEYS) {
            const value = bundle.privacyPolicy?.[key];
            assert.equal(
                typeof value,
                "string",
                `${name}.privacyPolicy.${key} must exist`
            );
            assert.ok(
                value.trim().length > 0,
                `${name}.privacyPolicy.${key} must not be empty`
            );
        }
    }
});

test("no locale silently reuses the English copy", () => {
    // A missing translation that falls back to English reads as done and
    // ships an untranslated legal notice.
    const english = en.privacyPolicy.externalImport;
    for (const [name, bundle] of Object.entries(LOCALES)) {
        if (name === "en") continue;
        assert.notEqual(
            bundle.privacyPolicy.externalImport,
            english,
            `${name} must not duplicate the English privacy copy`
        );
    }
});

test("the copy states the facts the policy requires", () => {
    // Locale-independent anchors: every translation must name every service
    // the import actually accepts, and none may omit the browser-only
    // processing claim by being suspiciously short.
    //
    // The service list comes from the canonical provider set rather than being
    // spelled out here, because the drift this catches has already happened
    // once: Gemini shipped through the adapter, the server and the wizard's
    // guide cards while the privacy notice still described a two-provider
    // feature. A privacy notice that under-describes the processing is the
    // one place where lagging behind the code is a legal problem, not a
    // copy problem.
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.externalImport;
        for (const brand of Object.values(PROVIDER_LABELS)) {
            assert.ok(body.includes(brand), `${name} must name ${brand}`);
        }
        assert.ok(body.includes("Tomverse"), `${name} must name Tomverse`);
        // A length floor catches a stub or placeholder translation. It is
        // deliberately low: Chinese carries the same disclosures in roughly
        // half the characters, so a Latin-calibrated threshold would fail a
        // perfectly complete translation.
        assert.ok(
            body.length > 150,
            `${name} copy is too short to cover the required disclosures`
        );
    }
});

test("the privacy page renders the section", () => {
    // The keys existing is not enough — an unreferenced key is copy nobody
    // ever sees.
    const source = readFileSync(
        new URL("../components/legal/PrivacyPolicy.tsx", import.meta.url),
        "utf8"
    );
    assert.ok(source.includes("externalImportTitle"));
    assert.ok(source.includes('"externalImport"'));
});

test("the copy makes no promise the implementation does not keep", () => {
    // Release A does not import media, does not offer a password lock, and
    // does not create memories. Copy that implies otherwise would be a
    // privacy notice describing a product that does not exist.
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.externalImport.toLowerCase();
        for (const forbidden of ["memory", "메모리", "记忆", "mémoire"]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not describe memory features in the Release A copy`
            );
        }
    }
});
