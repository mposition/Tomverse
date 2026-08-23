import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
    ASSISTANT_PROFILE_ERROR_COPY_KEYS,
    assistantProfileErrorCopyKey,
} from "../lib/assistantProfileErrorCopy.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

/**
 * The assistant screens used to print the server's own `error` string.
 *
 * Those strings are written for operators and only exist in English, so a
 * Korean user unticking their last model read `Invalid request payload.` --
 * the wrong language, no field named, no next step. These assertions are what
 * stops the next refusal code shipping without a sentence, in any locale.
 */

const locales = { en, ko, zh, fr, de, es, pt };

const lookup = (dictionary, key) =>
    key.split(".").reduce((node, part) => (node ? node[part] : undefined), dictionary);

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) =>
    readFileSync(resolve(ROOT, relativePath), "utf8");

test("every mapped code resolves to a key every locale answers", () => {
    for (const [code, key] of Object.entries(ASSISTANT_PROFILE_ERROR_COPY_KEYS)) {
        for (const [language, dictionary] of Object.entries(locales)) {
            const value = lookup(dictionary, key);
            assert.equal(
                typeof value,
                "string",
                `${language} has no string for ${key} (code ${code})`
            );
            assert.ok(value.trim().length > 0, `${language}.${key} is empty`);
        }
    }
});

test("every refusal these routes can raise has copy", () => {
    // Read from the sources rather than a list kept here: a hand-maintained
    // copy of "what the server can answer" is the thing that goes stale, and
    // its staleness is invisible -- the untranslated string only shows up in
    // front of a user.
    const sources = [
        "app/api/assistant-profiles/route.ts",
        "app/api/assistant-profiles/[profileId]/route.ts",
        "app/api/assistant-profiles/[profileId]/versions/route.ts",
        "app/api/assistant-profiles/[profileId]/knowledge/route.ts",
        "lib/assistantProfileService.ts",
        "lib/assistantProfileVersioning.ts",
    ];
    const raised = new Set();
    for (const source of sources) {
        for (const match of read(source).matchAll(/"(ASSISTANT_[A-Z_]+)"/g)) {
            raised.add(match[1]);
        }
    }
    // Sanity: a regex that stopped matching would make this test pass by
    // finding nothing at all, which is the failure mode of every scan.
    assert.ok(raised.size >= 6, `found only ${raised.size} codes`);

    // Two the scan cannot see, because they are constants imported by name
    // rather than literals at the throw site.
    raised.add("ASSISTANT_PROFILE_MODEL_UNAVAILABLE");
    raised.add("ASSISTANT_PROFILE_VERSION_STALE");

    // What these screens deliberately do not name. A forbidden upload key is
    // a client/server mismatch the reader did not cause and cannot act on, so
    // "could not add the file" is the honest sentence; the same holds for a
    // knowledge file id that resolves to nothing, which the panel only sends
    // for a row it just listed.
    const generic = new Set([
        "ASSISTANT_KNOWLEDGE_KEY_FORBIDDEN",
        "ASSISTANT_KNOWLEDGE_KEY_PREFIX",
        "ASSISTANT_KNOWLEDGE_FILE_NOT_FOUND",
        "ASSISTANT_KNOWLEDGE_NO_TEXT",
        "ASSISTANT_KNOWLEDGE_UNREADABLE",
        // Not refusals: limit and format tables that happen to share the
        // prefix.
        "ASSISTANT_KNOWLEDGE_LIMITS",
        "ASSISTANT_KNOWLEDGE_TYPES",
        "ASSISTANT_PROFILE_LIMITS",
        "ASSISTANT_PROMPT_FORMAT_VERSION",
        "ASSISTANT_RETRIEVAL_VERSION",
        // Runtime decisions on a chat turn, which this client never receives:
        // they refuse the profile mid-conversation, not a save.
        "ASSISTANT_PROFILE_NO_ACTIVE_VERSION",
        "ASSISTANT_PROFILE_FORMAT_UNSUPPORTED",
    ]);

    for (const code of raised) {
        if (generic.has(code)) continue;
        assert.ok(
            assistantProfileErrorCopyKey(code),
            `${code} has no copy key, so the screen would fall back to a generic message`
        );
    }
});

test("the shared refusals of the API edge are covered", () => {
    // Every one of these routes reads its body through `readLimitedJson` and
    // its budget through `consumeApiRateLimit`, so these four are reachable
    // on any save. `INVALID_REQUEST` is the one that produced the report this
    // map came from.
    for (const code of [
        "INVALID_REQUEST",
        "INVALID_JSON",
        "REQUEST_BODY_TOO_LARGE",
        "API_RATE_LIMITED",
    ]) {
        assert.ok(assistantProfileErrorCopyKey(code), `${code} has no copy key`);
    }
});

test("no screen prints the server's own message", () => {
    // The defect itself, pinned. Both screens read `code`; neither may read
    // `error` or keep a `detail` to fall back to.
    for (const source of [
        "components/assistants/AssistantProfileEditor.tsx",
        "components/assistants/KnowledgeFilesPanel.tsx",
    ]) {
        const text = read(source);
        assert.ok(
            !/\bdetail\s*:\s*(body|data)\?\.error\b/.test(text),
            `${source} still stores the server's message`
        );
        assert.ok(
            !/\{\s*(notice|upload)\.detail\b/.test(text),
            `${source} still renders the server's message`
        );
        assert.ok(
            text.includes("assistantProfileErrorCopyKey"),
            `${source} does not resolve refusals through the shared table`
        );
    }
});

test("an unknown or absent code resolves to nothing, so the caller can fall back", () => {
    assert.equal(assistantProfileErrorCopyKey(undefined), null);
    assert.equal(assistantProfileErrorCopyKey(null), null);
    assert.equal(assistantProfileErrorCopyKey(""), null);
    assert.equal(assistantProfileErrorCopyKey("SOMETHING_NEW"), null);
});
