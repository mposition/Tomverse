// Export a profile, read the package back, and check nothing was lost (Slice 6).
//
// docs/policy/assistant-package-import.md §6.4.
//
// The contract this pins is one sentence: a package exported from a version
// and re-imported produces a `PortableProfile` equal to that version's. It is
// checked by actually running both halves -- the writer's bytes go straight
// into the reader -- because the interesting failures live between them. A
// path the writer chose and the reader refuses, an extension the reader does
// not recognise as a document, a name mangled on the way out: every one of
// those passes a test of either half alone.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    inflatePackageEntry,
    planPackageRead,
    readPackageDirectory,
} from "../lib/assistantPackageArchive.ts";
import {
    ASSISTANT_PACKAGE_DIGEST_VERSION,
    ASSISTANT_PACKAGE_PRODUCER,
    assistantPackageFilename,
    buildAssistantPackage,
    exportKnowledgePath,
} from "../lib/assistantPackageExport.ts";
import { ASSISTANT_PACKAGE_LIMITS } from "../lib/assistantPackageLimits.ts";
import {
    ASSISTANT_PACKAGE_SCHEMA_VERSION,
    portableProfileEquals,
} from "../lib/assistantPackageManifest.ts";
import { buildPackageReview } from "../lib/assistantPackageReview.ts";

const sha256Hex = async (input) =>
    createHash("sha256")
        .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
        .digest("hex");

const encode = (text) => new TextEncoder().encode(text);

const digestOf = (text) =>
    `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;

const document = (name, text, mime = "text/markdown") => ({
    name,
    mime,
    bytes: encode(text),
    digest: digestOf(text),
});

const profileInput = (overrides = {}) => ({
    identity: { name: "Reviewer", icon: "R", description: "Reviews diffs." },
    version: {
        instructions: "Read the diff and say what would break.",
        starters: ["What changed?", "Any risks?"],
        modelIds: ["gpt-5-6-luna", "claude-x"],
        toolPolicy: { webSearch: true, deepResearch: false },
        memoryPolicy: { useAccountMemory: false },
    },
    knowledge: [],
    declaredPreviousProvenance: null,
    sha256Hex,
    ...overrides,
});

/** What the version being exported says, as a portable profile. */
const portableFrom = (input) => ({
    name: input.identity.name,
    icon: input.identity.icon,
    description: input.identity.description,
    instructions: input.version.instructions,
    modelIds: input.version.modelIds,
    starters: input.version.starters,
    toolPolicy: input.version.toolPolicy,
    memoryPolicy: input.version.memoryPolicy,
    knowledge: input.knowledge.map((entry) => ({
        name: entry.name,
        digest: entry.digest,
    })),
});

/** The package, opened exactly as the import path opens one. */
const reimport = async (zip) => {
    const read = async (start, end) =>
        zip.subarray(Math.max(0, start), Math.min(zip.length, end));
    const directory = await readPackageDirectory(zip.length, read);
    assert.equal(directory.outcome, "read", `directory refused: ${directory.cause}`);
    const plan = planPackageRead(directory.entries);
    assert.equal(plan.packageRefusal, null, JSON.stringify(plan.refusals));
    const entries = new Map();
    for (const item of plan.reads) {
        const inflated = await inflatePackageEntry(item.entry, read);
        assert.equal(inflated.outcome, "read", item.entry.path);
        entries.set(item.entry.path, inflated.bytes);
    }
    const result = await buildPackageReview({ plan, entries, sha256Hex });
    assert.equal(result.outcome, "review", `review refused: ${result.cause}`);
    return result.review;
};

/** The re-imported package, as a portable profile. */
const portableFromReview = (review) => ({
    name: review.identity.name.value,
    icon: review.identity.icon.value,
    description: review.identity.description.value,
    instructions: review.instructions.value,
    modelIds: review.modelIds.value,
    starters: review.starters.value,
    toolPolicy: review.toolPolicy.value,
    memoryPolicy: review.memoryPolicy.value,
    knowledge: review.knowledgeCandidates.map((candidate) => ({
        name: candidate.name,
        digest: candidate.digest,
    })),
});

const roundTrip = async (input) => {
    const built = await buildAssistantPackage(input);
    assert.equal(built.outcome, "built", `build refused: ${built.reason}`);
    return { built, review: await reimport(built.zip) };
};

/* ------------------------------------------------------- the contract */

test("a profile with no documents survives the round trip", async () => {
    const input = profileInput();
    const { review } = await roundTrip(input);
    assert.equal(review.kind, "tomverse-native");
    assert.equal(
        portableProfileEquals(portableFrom(input), portableFromReview(review)),
        true
    );
});

test("a profile with documents survives the round trip", async () => {
    const input = profileInput({
        knowledge: [
            document("style.md", "Prefer short sentences."),
            document("api.md", "The endpoint is /v1/things."),
        ],
    });
    const { review } = await roundTrip(input);
    assert.equal(review.knowledgeCandidates.length, 2);
    assert.equal(
        portableProfileEquals(portableFrom(input), portableFromReview(review)),
        true
    );
});

test("two documents sharing a name both come back", async () => {
    // Ordinary, and the reader refuses duplicate and case-colliding paths --
    // so uniqueness has to be a property of how the writer builds a path
    // rather than something anyone checks afterwards.
    const input = profileInput({
        knowledge: [
            document("notes.md", "First."),
            document("notes.md", "Second."),
            document("NOTES.md", "Third."),
        ],
    });
    const { review } = await roundTrip(input);
    assert.equal(review.knowledgeCandidates.length, 3);
    assert.equal(
        portableProfileEquals(portableFrom(input), portableFromReview(review)),
        true
    );
});

test("a name that cannot be a path keeps its name in the manifest", async () => {
    // The path is reduced to characters a path can hold; the name is not,
    // because the name is what the owner called it and the comparison is on
    // the name.
    const input = profileInput({ knowledge: [document("스타일 가이드.md", "짧게.")] });
    const { built, review } = await roundTrip(input);
    assert.equal(review.knowledgeCandidates[0].name, "스타일 가이드.md");
    assert.match(built.manifest.version.knowledge[0].path, /^knowledge\/1-document\.md$/);
    assert.equal(
        portableProfileEquals(portableFrom(input), portableFromReview(review)),
        true
    );
});

test("the owner's extension is kept when the media type accepts it", async () => {
    // `notes.log` coming back as `notes.txt` would be a rename nobody asked
    // for, and the reader decides what may be a document by extension.
    const input = profileInput({
        knowledge: [document("server.log", "started", "text/plain")],
    });
    const { built, review } = await roundTrip(input);
    assert.match(built.manifest.version.knowledge[0].path, /\.log$/);
    assert.equal(review.knowledgeCandidates.length, 1);
});

test("an extension the media type does not accept is replaced, not trusted", async () => {
    const path = exportKnowledgePath(0, { name: "notes.md", mime: "application/pdf" });
    assert.match(path, /^knowledge\/1-notes\.pdf$/);
});

/* ----------------------------------------------------- what it carries */

test("the manifest names this app and the current format", async () => {
    const { built } = await roundTrip(profileInput());
    assert.equal(built.manifest.schemaVersion, ASSISTANT_PACKAGE_SCHEMA_VERSION);
    assert.equal(built.manifest.producedBy.app, ASSISTANT_PACKAGE_PRODUCER);
    assert.equal(built.manifest.digestVersion, ASSISTANT_PACKAGE_DIGEST_VERSION);
    assert.match(built.manifest.packageDigest, /^sha256:[0-9a-f]{64}$/);
});

test("nothing in the package names a storage location", async () => {
    // §6.2: a document leaves as its bytes, not as a place to fetch it from.
    const input = profileInput({ knowledge: [document("style.md", "Short.")] });
    const { built } = await roundTrip(input);
    const json = JSON.stringify(built.manifest);
    for (const forbidden of ["r2Key", "objectKey", "signedUrl", "https://", "secrets"]) {
        assert.ok(!json.includes(forbidden), `the manifest names ${forbidden}`);
    }
});

test("a claim about where the profile came from travels as a claim", async () => {
    const input = profileInput({
        declaredPreviousProvenance: {
            sourceKind: "agent-skill",
            sourceName: "code-reviewer",
            sourceUrl: null,
            exportedAt: null,
        },
    });
    const { review } = await roundTrip(input);
    assert.equal(review.declaredProvenance.sourceKind, "agent-skill");
    assert.equal(review.declaredProvenance.sourceName, "code-reviewer");
});

test("the same profile exported twice produces the same bytes", async () => {
    // Which is what lets a digest of the archive mean anything, and what keeps
    // a re-export out of a diff when nothing changed.
    const input = profileInput({ knowledge: [document("style.md", "Short.")] });
    const first = await buildAssistantPackage(input);
    const second = await buildAssistantPackage(input);
    assert.deepEqual(first.zip, second.zip);
});

test("more bytes than the reader would accept are refused rather than written", async () => {
    const oversized = {
        name: "big.md",
        mime: "text/markdown",
        bytes: new Uint8Array(ASSISTANT_PACKAGE_LIMITS.maxTotalInflatedBytes + 1),
        digest: `sha256:${"0".repeat(64)}`,
    };
    const built = await buildAssistantPackage(profileInput({ knowledge: [oversized] }));
    assert.deepEqual(built, { outcome: "refused", reason: "too_large" });
});

/* ------------------------------------------------------------ filename */

test("the download's filename cannot carry a quote or a path", () => {
    // This string goes into a Content-Disposition header, where a quote or a
    // newline is not a cosmetic problem. Asserted as properties rather than as
    // one expected string, because what matters is what cannot be in it.
    const filename = assistantPackageFilename('My "Reviewer"\n/../x');
    for (const forbidden of ['"', "/", "\\", "\n", "\r", ".."]) {
        assert.ok(!filename.includes(forbidden), `filename contains ${forbidden}`);
    }
    assert.ok(filename.endsWith(".tomverse-assistant.zip"));

    // A name in a script the reduction strips is still a file somebody can
    // save, rather than an empty filename.
    assert.equal(
        assistantPackageFilename("리뷰어"),
        "document.tomverse-assistant.zip"
    );
});
