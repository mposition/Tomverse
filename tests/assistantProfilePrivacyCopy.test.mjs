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
 * docs/policy/external-conversation-import-and-memory.md §16, Release C row.
 *
 * Release C is the release where the processing actually starts: profile
 * instructions are stored and sent to a provider, knowledge files are stored,
 * their text extracted, indexed and excerpted, and those excerpts leave the
 * account with every profile-backed turn. §16 wants that described in the
 * release that ships it, in every supported locale — checked statically here,
 * the same division of labour as tests/memoryPrivacyCopy.test.mjs, with the
 * rendered page covered in E2E.
 */

const LOCALES = { ko, en, zh, fr, de, es, pt };
const KEYS = ["assistantProfilesTitle", "assistantProfiles"];

test("every supported locale carries the assistant profile privacy copy", () => {
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
    const english = en.privacyPolicy.assistantProfiles;
    for (const [name, bundle] of Object.entries(LOCALES)) {
        if (name === "en") continue;
        assert.notEqual(
            bundle.privacyPolicy.assistantProfiles,
            english,
            `${name} must not duplicate the English privacy copy`
        );
    }
});

test("the copy states the facts the policy requires", () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.assistantProfiles;
        assert.ok(body.includes("Tomverse"), `${name} must name Tomverse`);
        // The Release C row is a longer list than Release B's: what a profile
        // stores, what a knowledge file becomes, what leaves for a provider,
        // what deletion removes. The floor is deliberately below the shortest
        // locale because Chinese says all of it in far fewer characters.
        assert.ok(
            body.length > 250,
            `${name} copy is too short to cover the required disclosures`
        );
    }
});

test("the privacy page renders the section", () => {
    const source = readFileSync(
        new URL("../components/legal/PrivacyPolicy.tsx", import.meta.url),
        "utf8"
    );
    assert.ok(source.includes("assistantProfilesTitle"));
    assert.ok(source.includes('"assistantProfiles"'));
});

test("the copy describes lexical retrieval, not an embedding service", () => {
    // §44: retrieval v1 is a search index over the account's own rows. No
    // embedding API, no vector database, so no third party sees a knowledge
    // file for indexing. Copy that said otherwise would describe a transfer
    // that does not happen -- and would pre-announce one that needs its own
    // privacy, cost and eval approval before it could.
    const FORBIDDEN = {
        ko: ["임베딩", "벡터"],
        en: ["embedding", "vector"],
        zh: ["嵌入", "向量"],
        fr: ["embedding", "vecteur"],
        de: ["einbettung", "vektor"],
        es: ["embedding", "vector"],
        pt: ["embedding", "vetor"],
    };
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.assistantProfiles.toLowerCase();
        for (const forbidden of FORBIDDEN[name]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not describe an embedding or vector service (§44)`
            );
        }
    }
});

test("the copy does not promise stored files vanish instantly", () => {
    // Deletion is DB-first: the rows and the profile's use of the file go in
    // one transaction, and the stored bytes are erased by a later sweep. A
    // notice promising an instant erase would be describing a guarantee the
    // storage layer does not make.
    const FORBIDDEN = {
        ko: ["즉시", "즉각"],
        en: ["immediately", "instantly"],
        zh: ["立即", "立刻"],
        fr: ["immédiatement", "instantané"],
        de: ["sofort", "unverzüglich"],
        es: ["inmediatamente", "al instante"],
        pt: ["imediatamente", "instantaneamente"],
    };
    for (const [name, bundle] of Object.entries(LOCALES)) {
        const body = bundle.privacyPolicy.assistantProfiles.toLowerCase();
        for (const forbidden of FORBIDDEN[name]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not promise instant erasure of stored files`
            );
        }
    }
});

test("the copy makes no claim §17 forbids", () => {
    // §17 marketing boundary: a profile is instructions and reference files,
    // not a copy of a person and not a clone of another provider's assistant.
    // Legal copy is held to the same line as marketing copy.
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
        const body = bundle.privacyPolicy.assistantProfiles.toLowerCase();
        for (const forbidden of FORBIDDEN[name]) {
            assert.ok(
                !body.includes(forbidden),
                `${name} must not claim a profile replicates anything (§17)`
            );
        }
    }
});
