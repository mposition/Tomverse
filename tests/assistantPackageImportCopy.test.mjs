// Every sentence the import wizard can show exists, in every locale (Slice 4).
//
// docs/policy/assistant-package-import.md §5.
//
// The wizard renders locale keys out of `Record`s keyed by unions, so a new
// refusal code or loss kind is a type error until it is mapped. What the type
// system cannot check is the other half: that the key a map names is a key the
// locales actually carry. A map pointing at a missing key compiles, renders
// nothing, and leaves a blank line where a refusal was supposed to be.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONVERSION_LOSS_KINDS, IMPORT_FIELD_NOTES } from "../lib/assistantPackageAdapter.ts";
import {
    ASSISTANT_PACKAGE_REFUSAL_CODES,
    ASSISTANT_PACKAGE_SKIP_REASONS,
} from "../lib/assistantPackageLimits.ts";
import {
    ASSISTANT_PACKAGE_IMPORT_STEPS,
    IMPORT_FIELDS,
} from "../lib/assistantPackageImportWizard.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

const LOCALES = { ko, en, zh, fr, de, es, pt };

const WIZARD_SOURCE = readFileSync(
    new URL(
        "../components/assistants/import/AssistantPackageImportWizard.tsx",
        import.meta.url
    ),
    "utf8"
);

/** Every `assistantPackageImport.*` key the component names. */
const referenced = new Set(
    [...WIZARD_SOURCE.matchAll(/"assistantPackageImport\.([A-Za-z0-9_]+)"/g)].map(
        (match) => match[1]
    )
);

const copy = (locale) => LOCALES[locale].assistantPackageImport;

test("every key the wizard names exists in the copy", () => {
    assert.ok(referenced.size > 50, "the source scan found suspiciously few keys");
    for (const key of referenced) {
        assert.ok(key in copy("en"), `assistantPackageImport.${key} is not in the copy`);
    }
});

test("every string in the copy is actually reachable", () => {
    // The other direction, so retired copy does not accumulate: a string
    // nothing renders is a string a translator maintains for nothing.
    for (const key of Object.keys(copy("en"))) {
        assert.ok(referenced.has(key), `assistantPackageImport.${key} is never rendered`);
    }
});

test("every locale carries every string, and none is empty", () => {
    for (const [locale, bundle] of Object.entries(LOCALES)) {
        const strings = bundle.assistantPackageImport;
        assert.deepEqual(
            Object.keys(strings).sort(),
            Object.keys(copy("en")).sort(),
            `${locale} does not carry the same keys as English`
        );
        for (const [key, value] of Object.entries(strings)) {
            assert.equal(typeof value, "string", `${locale}.${key}`);
            assert.notEqual(value.trim(), "", `${locale}.${key} is empty`);
        }
    }
});

/* ------------------------------------------------- the enumerations render */

/**
 * `KEY: "assistantPackageImport.x"` allowing the line break the formatter puts
 * after a long key. Matching the literal would pass for the short names and
 * quietly skip the long ones, which are exactly the ones nobody re-reads.
 */
const mapsToCopy = (member) =>
    new RegExp(`${member}:\\s*"assistantPackageImport\\.`).test(WIZARD_SOURCE);

test("every refusal code has a sentence", () => {
    // A refusal with no sentence is a screen that refuses and says nothing,
    // which is the one thing a refusal must not do.
    for (const code of ASSISTANT_PACKAGE_REFUSAL_CODES) {
        assert.ok(mapsToCopy(code), `${code} is not mapped to a copy key`);
    }
});

test("every skip reason, loss kind and field note has a sentence", () => {
    for (const reason of ASSISTANT_PACKAGE_SKIP_REASONS) {
        assert.ok(mapsToCopy(reason), `skip reason ${reason} is not mapped`);
    }
    for (const kind of CONVERSION_LOSS_KINDS) {
        assert.ok(mapsToCopy(kind), `loss kind ${kind} is not mapped`);
    }
    for (const note of IMPORT_FIELD_NOTES) {
        assert.ok(mapsToCopy(note), `field note ${note} is not mapped`);
    }
});

test("every step and every field is named", () => {
    for (const step of ASSISTANT_PACKAGE_IMPORT_STEPS) {
        assert.ok(
            new RegExp(`${step}:\\s*"assistantPackageImport\\.step`).test(WIZARD_SOURCE),
            `step ${step} has no label`
        );
    }
    for (const field of IMPORT_FIELDS) {
        assert.ok(
            new RegExp(`${field.key}:\\s*"assistantPackageImport\\.field`).test(
                WIZARD_SOURCE
            ),
            `field ${field.key} has no label`
        );
    }
});

/* ----------------------------------------------------------- product rules */

/**
 * The body of one step renderer.
 *
 * Copy existing and copy being shown are different facts, and the ones below
 * are only worth anything on the screen where the decision is made: a warning
 * about storage that renders two steps later has already been walked past.
 */
const stepBody = (name) => {
    const start = WIZARD_SOURCE.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is not in the wizard`);
    const next = WIZARD_SOURCE.indexOf("\nfunction ", start + 1);
    return WIZARD_SOURCE.slice(start, next === -1 ? undefined : next);
};

test("the reason there is no address box is stated where the field would be", () => {
    // §1.1 makes fetching a remote package a prohibition rather than an
    // omission, and this sentence is the only place a person ever sees that.
    // On any other step it would be an explanation of a field they are no
    // longer looking for.
    assert.match(stepBody("SourceStep"), /assistantPackageImport\.sourceNoRemote/);
    for (const [locale, bundle] of Object.entries(LOCALES)) {
        assert.ok(
            [...bundle.assistantPackageImport.sourceNoRemote].length > 8,
            `${locale}.sourceNoRemote is too short to say why`
        );
    }
});

test("the boundary between reading and storing is stated on the step before it", () => {
    // §5.2: the owner has to know where storing begins, or cancelling has no
    // meaning they can reason about. Step 6 is the last step where knowing it
    // still changes what they can do.
    const body = stepBody("TargetStep");
    for (const key of [
        "uploadBoundaryHeading",
        "uploadBoundaryBody",
        "uploadBoundaryAcknowledge",
    ]) {
        assert.match(body, new RegExp(`assistantPackageImport\\.${key}`));
        for (const [locale, bundle] of Object.entries(LOCALES)) {
            assert.ok(
                [...bundle.assistantPackageImport[key]].length > 4,
                `${locale}.${key} is empty in substance`
            );
        }
    }
});

test("the promise that nothing is run is made in every locale", () => {
    // Each locale says it in its own words, so this checks that each one has
    // room to say it rather than that they share a phrase. Length is counted
    // in code points: the same sentence is far shorter in Chinese, and a
    // character budget written for English would fail a correct translation.
    for (const [locale, bundle] of Object.entries(LOCALES)) {
        assert.ok(
            [...bundle.assistantPackageImport.subtitle].length > 15,
            `${locale}.subtitle does not have room to say what an import does`
        );
    }
});
