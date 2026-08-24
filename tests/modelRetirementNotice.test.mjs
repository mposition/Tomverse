import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
    MODEL_NOTICE_COPY_KEYS,
    modelNotice,
    modelNoticeFallbackText,
} from "../lib/modelRetirementNotice.ts";

// The in-app retirement notice, in the reader's language (EM-15).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md EM-15.
//
// The gap this closes: the retirement *email* for one event is written in seven
// languages while the in-app notice about the same event was one stored English
// sentence. Two notices about one fact, disagreeing about what language the
// reader speaks.

const LOCALES = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("a retirement with a replacement names it, and the words are not stored", () => {
    assert.deepEqual(
        modelNotice({
            replacementModelName: "Grok 4.5",
            unavailable: true,
        }),
        {
            source: "localised",
            kind: "retired_replaced",
            copyKey: "chat.modelRetiredWithReplacement",
            replacementModelName: "Grok 4.5",
        }
    );
});

test("an unavailable model with no replacement is not called retired", () => {
    // A model can be unavailable for an outage, a provider incident or an admin
    // switch. Telling somebody their model is gone when it is coming back is
    // the more expensive of the two mistakes.
    assert.deepEqual(modelNotice({ unavailable: true }), {
        source: "localised",
        kind: "unavailable",
        copyKey: "chat.modelTemporarilyUnavailable",
    });
});

test("a working model with nothing to say says nothing", () => {
    // The availability check used to return userVisibleNote on the allowed path
    // too, so a note left on a model that was later re-enabled kept appearing
    // beside answers it no longer described.
    assert.equal(
        modelNotice({ unavailable: false, replacementModelName: "Grok 4.5" }),
        null
    );
});

test("an operator's own sentence wins and is marked as theirs", () => {
    // Codestral's note says something no field holds: that the model left one
    // *product* while still existing. That is worth an operator's words -- and
    // they cannot be translated, so the shape says so instead of letting a
    // caller assume the sentence is in the reader's language.
    assert.deepEqual(
        modelNotice({
            userVisibleNote:
                "This model is no longer available in Tomverse Review. Use Mistral Medium 3.5 instead.",
            replacementModelName: "Mistral Medium 3.5",
            unavailable: true,
        }),
        {
            source: "operator",
            text: "This model is no longer available in Tomverse Review. Use Mistral Medium 3.5 instead.",
        }
    );
});

test("a blank note is not a note", () => {
    assert.equal(modelNotice({ userVisibleNote: "   ", unavailable: false }), null);
    assert.equal(
        modelNotice({ userVisibleNote: "", unavailable: true }).source,
        "localised"
    );
});

test("the fallback text exists for callers with no locale", () => {
    // Logs, operator tooling, and the `message` field a client that has not
    // learned the copy key still reads. Never the primary path.
    assert.match(
        modelNoticeFallbackText(
            modelNotice({ replacementModelName: "Grok 4.5", unavailable: true })
        ),
        /Grok 4\.5/
    );
    assert.equal(modelNoticeFallbackText(null), "");
    assert.equal(
        modelNoticeFallbackText({ source: "operator", text: "Gone." }),
        "Gone."
    );
});

test("every copy key exists in all seven locales", () => {
    // A key with no sentence renders as the key. The email side already carries
    // seven languages for this event; the point of EM-15 is that the in-app
    // notice does too.
    for (const locale of LOCALES) {
        const source = readFileSync(`locales/${locale}.ts`, "utf8");
        for (const key of Object.values(MODEL_NOTICE_COPY_KEYS)) {
            const leaf = key.slice("chat.".length);
            assert.match(
                source,
                new RegExp(`\\n\\s*${leaf}:\\s*"`),
                `${locale} is missing ${key}`
            );
        }
    }
});

test("the replacement placeholder survives translation", () => {
    // The model name is a brand, so it is interpolated rather than translated.
    // A locale that drops `{model}` produces a sentence that promises to name
    // the replacement and then does not.
    for (const locale of LOCALES) {
        const source = readFileSync(`locales/${locale}.ts`, "utf8");
        const line = source
            .split("\n")
            .find((entry) => entry.includes("modelRetiredWithReplacement:"));
        assert.ok(line, `${locale} is missing modelRetiredWithReplacement`);
        assert.ok(line.includes("{model}"), `${locale} dropped {model}`);
    }
});

test("no model in the static catalogue restates its own replacement in English", () => {
    // The regression this exists for: nine of the ten stored notes said exactly
    // what replacementModelId already says, in English, to every reader. A new
    // retirement that adds one back would reintroduce the whole defect.
    const source = readFileSync("lib/models.ts", "utf8");
    const offenders = source
        .split("\n")
        .filter((line) => /userVisibleNote: "This model was retired/.test(line));
    assert.deepEqual(
        offenders,
        [],
        "derive the sentence from replacementModelId instead; see lib/modelRetirementNotice.ts"
    );
});
