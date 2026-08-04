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

/**
 * docs/policy/external-conversation-import-and-memory.md §16, Release B row.
 *
 * Release B starts processing activities the Release A copy does not cover:
 * selected source text goes to an extraction provider, and approved memories
 * go to whichever provider answers each new chat. Every supported locale has
 * to say so in the same release, checked statically here — the same division
 * of labour as tests/externalImportPrivacyCopy.test.mjs, with ko/en rendering
 * covered in E2E.
 */

const LOCALES = { ko, en, zh, fr, de, es, pt };
const KEYS = ["memoryTitle", "memory"];

test("every supported locale carries the memory privacy copy", () => {
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
    const english = en.privacyPolicy.memory;
    for (const [name, bundle] of Object.entries(LOCALES)) {
        if (name === "en") continue;
        assert.notEqual(
            bundle.privacyPolicy.memory,
            english,
            `${name} must not duplicate the English privacy copy`
        );
    }
});

test("the copy states the facts the policy requires", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.memory;
        assert.ok(body.includes("Tomverse"), `${name} must name Tomverse`);
        // The Release B row of §16 is a long list (provider transmission,
        // retention, user controls, sensitive review). A short string cannot
        // be covering it; the floor is deliberately low because Chinese says
        // the same things in far fewer characters.
        assert.ok(
            body.length > 200,
            `${name} copy is too short to cover the required disclosures`
        );
    }
});

test("the privacy page renders the section", () => {
    const source = readFileSync(
        new URL("../components/legal/PrivacyPolicy.tsx", import.meta.url),
        "utf8"
    );
    assert.ok(source.includes("memoryTitle"));
    assert.ok(source.includes('"memory"'));
});

test("the copy describes no source lock, which this release does not ship", () => {
    // §16: describe actual processing, never the roadmap. Conversation lock
    // generalisation and the memory suspension it drives are the B5 slice
    // (§7, §7.1); until that ships, a privacy notice describing locked
    // sources would describe a product that does not exist. The sentence
    // lands with B5, not before.
    const FORBIDDEN = {
        ko: ["잠금", "잠긴"],
        en: ["lock"],
        zh: ["锁定"],
        fr: ["verrou"],
        de: ["sperr"],
        es: ["bloque"],
        pt: ["bloque"],
    };
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.memory.toLowerCase();
        for (const forbidden of FORBIDDEN[name]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not describe source locking before B5 ships it`
            );
        }
    }
});

test("the copy makes no claim §17 forbids", () => {
    // §17 marketing boundary: memory is reviewed reference material, not a
    // replica of the user or of another provider's assistant. Legal copy is
    // held to the same line as marketing copy.
    const FORBIDDEN = {
        ko: ["복제", "재현", "손실 없"],
        en: ["replicate", "replica", "clone", "identical to"],
        zh: ["复制", "克隆"],
        fr: ["répliqu", "clone"],
        de: ["repliz", "klon"],
        es: ["replic", "clon"],
        pt: ["replic", "clon"],
    };
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.memory.toLowerCase();
        for (const forbidden of FORBIDDEN[name]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not claim memory replicates anything (§17)`
            );
        }
    }
});
