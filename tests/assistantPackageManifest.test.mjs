// The native package manifest, and what "the same profile" means (Slice 2).
//
// docs/policy/assistant-package-import.md §6.
//
// Two things are pinned here. The schema's refusals, because §6.2 relies on
// `.strict()` to keep credential-shaped fields out of the format rather than on
// anyone remembering not to add one. And `portableProfileEquals()`, because §6.4
// makes it the round-trip contract: a field the schema can hold but the
// comparison ignores is a field the format does not really carry.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ASSISTANT_PACKAGE_SCHEMA_VERSION,
    assistantPackageManifestSchema,
    judgeManifestVersion,
    manifestToPortableProfile,
    normalizePortableProfile,
    packageDigestPayload,
    portableProfileEquals,
} from "../lib/assistantPackageManifest.ts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const manifest = (overrides = {}) => ({
    schemaVersion: ASSISTANT_PACKAGE_SCHEMA_VERSION,
    producedBy: { app: "tomverse", adapterVersion: "assistant-package-v1" },
    profile: { name: "Reviewer", icon: null, description: null },
    version: {
        instructions: "Be brief.",
        starters: [],
        modelIds: [],
        toolPolicy: { webSearch: false, deepResearch: false },
        memoryPolicy: { useAccountMemory: false },
        knowledge: [],
    },
    declaredPreviousProvenance: null,
    packageDigest: DIGEST_A,
    digestVersion: 1,
    ...overrides,
});

const profile = (overrides = {}) => ({
    name: "Reviewer",
    icon: null,
    description: null,
    instructions: "Be brief.",
    modelIds: [],
    starters: [],
    toolPolicy: { webSearch: false, deepResearch: false },
    memoryPolicy: { useAccountMemory: false },
    knowledge: [],
    ...overrides,
});

// The digest covers everything but itself, so the payload helper takes a
// manifest with that one field removed.
const withoutDigest = (source) => {
    const copy = { ...source };
    delete copy.packageDigest;
    return copy;
};

/* ------------------------------------------------------------------ schema */

test("a well formed manifest parses", () => {
    const result = assistantPackageManifestSchema.safeParse(manifest());
    assert.equal(result.success, true);
});

test("an unknown top level key is refused, not ignored", () => {
    const result = assistantPackageManifestSchema.safeParse({
        ...manifest(),
        secrets: { apiKey: "whatever" },
    });
    assert.equal(result.success, false);
});

test("an unknown key inside version is refused", () => {
    const base = manifest();
    const result = assistantPackageManifestSchema.safeParse({
        ...base,
        version: { ...base.version, headers: { Authorization: "x" } },
    });
    assert.equal(result.success, false);
});

test("an unknown key inside toolPolicy is refused", () => {
    const base = manifest();
    const result = assistantPackageManifestSchema.safeParse({
        ...base,
        version: {
            ...base.version,
            toolPolicy: { webSearch: false, deepResearch: false, shell: true },
        },
    });
    assert.equal(result.success, false);
});

test("instructions must be one string, never an array", () => {
    const base = manifest();
    const result = assistantPackageManifestSchema.safeParse({
        ...base,
        version: { ...base.version, instructions: ["a", "b"] },
    });
    assert.equal(result.success, false);
});

test("a knowledge digest must be sha256 hex", () => {
    const base = manifest();
    const entry = {
        path: "knowledge/a.md",
        name: "a.md",
        mime: "text/markdown",
        bytes: 10,
        digest: "md5:abc",
    };
    const result = assistantPackageManifestSchema.safeParse({
        ...base,
        version: { ...base.version, knowledge: [entry] },
    });
    assert.equal(result.success, false);
});

test("more knowledge entries than the limit is refused", () => {
    const base = manifest();
    const entries = Array.from({ length: 11 }, (_, index) => ({
        path: `knowledge/${index}.md`,
        name: `${index}.md`,
        mime: "text/markdown",
        bytes: 10,
        digest: DIGEST_A,
    }));
    const result = assistantPackageManifestSchema.safeParse({
        ...base,
        version: { ...base.version, knowledge: entries },
    });
    assert.equal(result.success, false);
});

test("declared provenance is nullable and carries no fetchable promise", () => {
    const result = assistantPackageManifestSchema.safeParse(
        manifest({
            declaredPreviousProvenance: {
                sourceKind: "agent-skill",
                sourceName: "code-reviewer",
                sourceUrl: "https://example.com/pkg",
                exportedAt: "2026-08-23T00:00:00Z",
            },
        })
    );
    assert.equal(result.success, true);
    // Nothing in the shape is a handle: the fields are strings for display,
    // and §1.1 forbids visiting the URL rather than merely omitting the code.
    assert.deepEqual(
        Object.keys(result.data.declaredPreviousProvenance).sort(),
        ["exportedAt", "sourceKind", "sourceName", "sourceUrl"]
    );
});

test("an unrecognised declared source kind is refused", () => {
    const result = assistantPackageManifestSchema.safeParse(
        manifest({
            declaredPreviousProvenance: {
                sourceKind: "chatgpt-gpt",
                sourceName: null,
                sourceUrl: null,
                exportedAt: null,
            },
        })
    );
    assert.equal(result.success, false);
});

/* ---------------------------------------------------------- version verdict */

test("the current version is accepted", () => {
    assert.deepEqual(judgeManifestVersion({ schemaVersion: ASSISTANT_PACKAGE_SCHEMA_VERSION }), {
        outcome: "accept",
        migratedFrom: null,
    });
});

test("a newer version is refused rather than partially read", () => {
    const verdict = judgeManifestVersion({
        schemaVersion: ASSISTANT_PACKAGE_SCHEMA_VERSION + 1,
    });
    assert.deepEqual(verdict, { outcome: "refuse", reason: "too_new" });
});

test("an absent or non-numeric version means this is not our package", () => {
    assert.equal(judgeManifestVersion({}).reason, "absent");
    assert.equal(judgeManifestVersion({ schemaVersion: "1" }).reason, "absent");
    assert.equal(judgeManifestVersion({ schemaVersion: 1.5 }).reason, "absent");
    assert.equal(judgeManifestVersion({ schemaVersion: 0 }).reason, "absent");
    assert.equal(judgeManifestVersion(null).reason, "absent");
});

/* ----------------------------------------------------------- normalisation */

test("whitespace differences are not content differences", () => {
    const left = profile({ name: "  My   Reviewer ", instructions: "One.\r\nTwo.\n" });
    const right = profile({ name: "My Reviewer", instructions: "One.\nTwo." });
    assert.equal(portableProfileEquals(left, right), true);
});

test("an icon or description of only whitespace normalises to absent", () => {
    const normalized = normalizePortableProfile(profile({ icon: "   ", description: " " }));
    assert.equal(normalized.icon, null);
    assert.equal(normalized.description, null);
});

test("empty starters are dropped and the rest keep their order", () => {
    const normalized = normalizePortableProfile(
        profile({ starters: ["  Ask  me ", "   ", "Second"] })
    );
    assert.deepEqual(normalized.starters, ["Ask me", "Second"]);
});

test("model order is meaning, so a reordering is a difference", () => {
    const left = profile({ modelIds: ["gpt-5-6-luna", "claude-x"] });
    const right = profile({ modelIds: ["claude-x", "gpt-5-6-luna"] });
    assert.equal(portableProfileEquals(left, right), false);
});

/* ------------------------------------------------------------- round trip */

test("knowledge is compared as a multiset, so order is not a difference", () => {
    const left = profile({
        knowledge: [
            { name: "a.md", digest: DIGEST_A },
            { name: "b.md", digest: DIGEST_B },
        ],
    });
    const right = profile({
        knowledge: [
            { name: "b.md", digest: DIGEST_B },
            { name: "a.md", digest: DIGEST_A },
        ],
    });
    assert.equal(portableProfileEquals(left, right), true);
});

test("two files sharing a name are two entries, not one", () => {
    const twice = profile({
        knowledge: [
            { name: "a.md", digest: DIGEST_A },
            { name: "a.md", digest: DIGEST_A },
        ],
    });
    const once = profile({ knowledge: [{ name: "a.md", digest: DIGEST_A }] });
    assert.equal(portableProfileEquals(twice, once), false);
});

test("the same name with different bytes is a difference", () => {
    const left = profile({ knowledge: [{ name: "a.md", digest: DIGEST_A }] });
    const right = profile({ knowledge: [{ name: "a.md", digest: DIGEST_B }] });
    assert.equal(portableProfileEquals(left, right), false);
});

test("every field the schema carries can make the comparison fail", () => {
    // The point of the loop: a field the format holds but the comparison
    // ignores is a field that does not round-trip, and nobody would notice.
    const variants = [
        profile({ name: "Other" }),
        profile({ icon: "?" }),
        profile({ description: "Something" }),
        profile({ instructions: "Be long." }),
        profile({ modelIds: ["gpt-5-6-luna"] }),
        profile({ starters: ["Ask me"] }),
        profile({ toolPolicy: { webSearch: true, deepResearch: false } }),
        profile({ toolPolicy: { webSearch: false, deepResearch: true } }),
        profile({ memoryPolicy: { useAccountMemory: true } }),
        profile({ knowledge: [{ name: "a.md", digest: DIGEST_A }] }),
    ];
    for (const variant of variants) {
        assert.equal(
            portableProfileEquals(profile(), variant),
            false,
            `expected a difference for ${JSON.stringify(variant)}`
        );
    }
});

test("a manifest read as a portable profile round-trips against itself", () => {
    const parsed = assistantPackageManifestSchema.parse(
        manifest({
            profile: { name: "Reviewer", icon: null, description: "Reviews diffs." },
        })
    );
    assert.equal(
        portableProfileEquals(
            manifestToPortableProfile(parsed),
            manifestToPortableProfile(parsed)
        ),
        true
    );
});

/* ----------------------------------------------------------------- digest */

test("the digest payload does not depend on key insertion order", () => {
    const base = withoutDigest(manifest());
    const reordered = {
        digestVersion: base.digestVersion,
        declaredPreviousProvenance: base.declaredPreviousProvenance,
        version: {
            knowledge: base.version.knowledge,
            memoryPolicy: base.version.memoryPolicy,
            toolPolicy: base.version.toolPolicy,
            modelIds: base.version.modelIds,
            starters: base.version.starters,
            instructions: base.version.instructions,
        },
        profile: base.profile,
        producedBy: base.producedBy,
        schemaVersion: base.schemaVersion,
    };
    assert.equal(packageDigestPayload(base), packageDigestPayload(reordered));
});

test("the digest payload does not depend on knowledge order", () => {
    const build = (knowledge) => {
        const base = withoutDigest(manifest());
        return packageDigestPayload({
            ...base,
            version: { ...base.version, knowledge },
        });
    };
    const a = {
        path: "knowledge/a.md",
        name: "a.md",
        mime: "text/markdown",
        bytes: 10,
        digest: DIGEST_A,
    };
    const b = { ...a, path: "knowledge/b.md", name: "b.md", digest: DIGEST_B };
    assert.equal(build([a, b]), build([b, a]));
});

test("a content change changes the digest payload", () => {
    const build = (instructions) => {
        const base = withoutDigest(manifest());
        return packageDigestPayload({
            ...base,
            version: { ...base.version, instructions },
        });
    };
    assert.notEqual(build("Be brief."), build("Be verbose."));
});
