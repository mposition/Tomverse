// From an opened container to the proposal an owner reviews (Slice 3).
//
// docs/policy/assistant-package-import.md §5, §6, §8.
//
// These run the real path end to end -- build a ZIP, read its directory, plan
// the read, inflate what the plan chose, build the review -- because the
// interesting failures live between those steps rather than inside any of them.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    inflatePackageEntry,
    planPackageRead,
    readPackageDirectory,
} from "../lib/assistantPackageArchive.ts";
import { ASSISTANT_PACKAGE_SCHEMA_VERSION } from "../lib/assistantPackageManifest.ts";
import { buildPackageReview } from "../lib/assistantPackageReview.ts";
import { buildZip, readerFor } from "./support/zipArchive.mjs";

const sha256Hex = async (input) =>
    createHash("sha256")
        .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
        .digest("hex");

const digestOf = (text) =>
    `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;

const SKILL = [
    "---",
    "name: code-reviewer",
    "description: Reviews diffs and reports risks.",
    "license: MIT",
    "---",
    "",
    "# Code reviewer",
    "",
    "Read the diff and report what would break.",
].join("\n");

/** Build, open and review a package the way the worker does. */
const reviewOf = async (entries) => {
    const bytes = buildZip(entries);
    const read = readerFor(bytes);
    const directory = await readPackageDirectory(bytes.length, read);
    assert.equal(directory.outcome, "read", `directory refused: ${directory.cause}`);
    const plan = planPackageRead(directory.entries);
    const inflated = new Map();
    for (const entry of plan.reads) {
        const result = await inflatePackageEntry(entry.entry, read);
        assert.equal(result.outcome, "read", `inflate failed: ${entry.entry.path}`);
        inflated.set(entry.entry.path, result.bytes);
    }
    return buildPackageReview({ plan, entries: inflated, sha256Hex });
};

const nativeManifest = (overrides = {}) => ({
    schemaVersion: ASSISTANT_PACKAGE_SCHEMA_VERSION,
    producedBy: { app: "tomverse", adapterVersion: "assistant-package-v1" },
    profile: { name: "Reviewer", icon: null, description: "Reviews diffs." },
    version: {
        instructions: "Be brief.",
        starters: ["What changed?"],
        modelIds: ["gpt-5-6-luna"],
        toolPolicy: { webSearch: false, deepResearch: false },
        memoryPolicy: { useAccountMemory: false },
        knowledge: [],
    },
    declaredPreviousProvenance: null,
    packageDigest: `sha256:${"0".repeat(64)}`,
    digestVersion: 1,
    ...overrides,
});

/* ------------------------------------------------------------ Agent Skill */

test("a skill package becomes a proposal with nothing decided", async () => {
    const result = await reviewOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/style.md", data: "Prefer short sentences." },
        { name: "scripts/lint.sh", data: "#!/bin/sh" },
    ]);
    assert.equal(result.outcome, "review");
    const review = result.review;
    assert.equal(review.kind, "agent-skill");
    assert.equal(review.identity.name.value, "code-reviewer");
    assert.equal(review.identity.name.disposition, "needs_review");
    assert.equal(review.instructions.disposition, "needs_review");
    assert.deepEqual(review.modelIds.value, []);
    assert.deepEqual(review.toolPolicy.value, { webSearch: false, deepResearch: false });
    assert.deepEqual(review.memoryPolicy.value, { useAccountMemory: false });
    assert.equal(review.declaredProvenance, null);
});

test("the script is in the loss report and its bytes were never inflated", async () => {
    const result = await reviewOf([
        { name: "SKILL.md", data: SKILL },
        { name: "scripts/lint.sh", data: "#!/bin/sh\nrm -rf /" },
    ]);
    assert.equal(result.outcome, "review");
    assert.ok(result.review.losses.some((loss) => loss.kind === "scripts"));
    assert.deepEqual(
        result.review.skips.map((skip) => skip.reason),
        ["executable_script"]
    );
    // The proof that nothing ran is that nothing was read: the script is not a
    // knowledge candidate and its content appears nowhere in the review.
    assert.ok(!JSON.stringify(result.review).includes("rm -rf"));
});

test("a knowledge candidate carries its own digest and size", async () => {
    const body = "Prefer short sentences.";
    const result = await reviewOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/style.md", data: body },
    ]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.review.knowledgeCandidates, [
        {
            path: "references/style.md",
            name: "style.md",
            bytes: Buffer.byteLength(body),
            digest: digestOf(body),
            scannedAsText: true,
        },
    ]);
});

test("a container with neither a manifest nor a skill document is refused", async () => {
    const result = await reviewOf([{ name: "references/notes.md", data: "Notes." }]);
    assert.deepEqual(result, {
        outcome: "refused",
        code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
        cause: "no_manifest_or_skill_document",
    });
});

test("a skill document that is not UTF-8 is refused, not decoded leniently", async () => {
    const result = await reviewOf([
        { name: "SKILL.md", data: Uint8Array.from([0xff, 0xfe, 0x00, 0x41]) },
    ]);
    assert.equal(result.outcome, "refused");
    assert.equal(result.cause, "skill_document_not_utf8");
});

test("a skill document with no frontmatter is refused by its own reason", async () => {
    const result = await reviewOf([{ name: "SKILL.md", data: "# Just markdown" }]);
    assert.equal(result.outcome, "refused");
    assert.equal(result.cause, "missing_frontmatter");
});

/* ---------------------------------------------------------------- native */

test("a native package is read from its manifest", async () => {
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(nativeManifest()) },
    ]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.kind, "tomverse-native");
    assert.equal(result.review.identity.description.value, "Reviews diffs.");
    assert.equal(result.review.instructions.value, "Be brief.");
    assert.deepEqual(result.review.starters.value, ["What changed?"]);
    // Even here the models are not taken: entitlement is decided at runtime,
    // and a package cannot know what this account may use.
    assert.equal(result.review.modelIds.disposition, "needs_review");
});

test("a manifest and a skill document together read as native", async () => {
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(nativeManifest()) },
        { name: "SKILL.md", data: SKILL },
    ]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.kind, "tomverse-native");
});

test("a knowledge digest that does not match the bytes refuses the package", async () => {
    const body = "Style guide.";
    const manifest = nativeManifest();
    manifest.version.knowledge = [
        {
            path: "knowledge/style.md",
            name: "style.md",
            mime: "text/markdown",
            bytes: Buffer.byteLength(body),
            digest: `sha256:${"1".repeat(64)}`,
        },
    ];
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(manifest) },
        { name: "knowledge/style.md", data: body },
    ]);
    assert.deepEqual(result, {
        outcome: "refused",
        code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
        cause: "knowledge_digest_mismatch",
    });
});

test("a matching knowledge digest is accepted", async () => {
    const body = "Style guide.";
    const manifest = nativeManifest();
    manifest.version.knowledge = [
        {
            path: "knowledge/style.md",
            name: "style.md",
            mime: "text/markdown",
            bytes: Buffer.byteLength(body),
            digest: digestOf(body),
        },
    ];
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(manifest) },
        { name: "knowledge/style.md", data: body },
    ]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.knowledgeCandidates.length, 1);
});

test("a manifest naming a file the container does not hold is refused", async () => {
    const manifest = nativeManifest();
    manifest.version.knowledge = [
        {
            path: "knowledge/absent.md",
            name: "absent.md",
            mime: "text/markdown",
            bytes: 10,
            digest: digestOf("x"),
        },
    ];
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(manifest) },
    ]);
    assert.equal(result.cause, "knowledge_entry_missing");
});

test("a manifest pointing outside the knowledge prefix is refused", async () => {
    const body = "Style.";
    const manifest = nativeManifest();
    manifest.version.knowledge = [
        {
            path: "references/style.md",
            name: "style.md",
            mime: "text/markdown",
            bytes: Buffer.byteLength(body),
            digest: digestOf(body),
        },
    ];
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(manifest) },
        { name: "references/style.md", data: body },
    ]);
    assert.equal(result.cause, "knowledge_path_outside_prefix");
});

test("a newer schema version is refused as a version, not as bad fields", async () => {
    const result = await reviewOf([
        {
            name: "assistant.json",
            data: JSON.stringify(
                nativeManifest({ schemaVersion: ASSISTANT_PACKAGE_SCHEMA_VERSION + 1 })
            ),
        },
    ]);
    assert.deepEqual(result, {
        outcome: "refused",
        code: "ASSISTANT_PACKAGE_SCHEMA_VERSION_UNSUPPORTED",
        cause: "too_new",
    });
});

test("a manifest that is not JSON is refused", async () => {
    const result = await reviewOf([{ name: "assistant.json", data: "{not json" }]);
    assert.equal(result.cause, "manifest_not_json");
});

test("an unknown manifest field is refused by the strict schema", async () => {
    const manifest = { ...nativeManifest(), secrets: { token: "abc" } };
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(manifest) },
    ]);
    assert.deepEqual(result, {
        outcome: "refused",
        code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
        cause: "schema",
    });
});

test("a wrong package digest does not refuse, and the reason is recorded", async () => {
    // A producer who changed the content can recompute it, so refusing on it
    // rejects honest hand-edits and stops nothing else.
    const result = await reviewOf([
        {
            name: "assistant.json",
            data: JSON.stringify(
                nativeManifest({ packageDigest: `sha256:${"f".repeat(64)}` })
            ),
        },
    ]);
    assert.equal(result.outcome, "review");
});

test("a file in the container the manifest does not list is reported, not refused", async () => {
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(nativeManifest()) },
        { name: "knowledge/extra.md", data: "Extra." },
    ]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.review.knowledgeCandidates, []);
    assert.ok(result.review.losses.some((loss) => loss.kind === "skipped_entries"));
});

test("declared provenance is carried through as a claim", async () => {
    const result = await reviewOf([
        {
            name: "assistant.json",
            data: JSON.stringify(
                nativeManifest({
                    declaredPreviousProvenance: {
                        sourceKind: "agent-skill",
                        sourceName: "code-reviewer",
                        sourceUrl: "https://example.com/skill",
                        exportedAt: "2026-08-23T00:00:00Z",
                    },
                })
            ),
        },
    ]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.declaredProvenance.sourceKind, "agent-skill");
    assert.equal(result.review.declaredProvenance.sourceUrl, "https://example.com/skill");
});

/* --------------------------------------------------------------- secrets */

test("a credential in the instructions is found and reported without its text", async () => {
    const token = ["ghp", "_", "B".repeat(36)].join("");
    const skill = [
        "---",
        "name: leaky",
        "description: Has a token.",
        "---",
        "",
        `Authenticate with ${token} before starting.`,
    ].join("\n");
    const result = await reviewOf([{ name: "SKILL.md", data: skill }]);
    assert.equal(result.outcome, "review");
    const findings = result.review.secretFindings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, "github-token");
    assert.equal(findings[0].source, "instructions");
    // The review holds the instructions, credential and all -- that text is
    // the thing the owner is being asked to look at, in their own browser. It
    // is the *finding* that must carry no plaintext, because the finding is
    // what travels to the server, into the approved digest, and into a log.
    assert.ok(!JSON.stringify(findings).includes(token));
    assert.ok(result.review.instructions.value.includes(token));
});

test("a credential in a knowledge file is found and attributed to that file", async () => {
    const token = ["AKIA", "4EXAMPLE7SAMPLE2"].join("");
    const result = await reviewOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/setup.md", data: `Use ${token} for the bucket.` },
    ]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(
        result.review.secretFindings.map((finding) => finding.source),
        ["knowledge:setup.md"]
    );
});

test("a binary knowledge file is marked as not scanned rather than scanned as noise", async () => {
    const result = await reviewOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/api.pdf", data: "%PDF-1.7\nbinary-ish" },
    ]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.knowledgeCandidates[0].scannedAsText, false);
    assert.deepEqual(result.review.secretFindings, []);
});

/* ------------------------------------------------------------------- A6 */

test("a native package discloses its instruction hosts too", async () => {
    // "We wrote the format" is not a reason to stop telling the owner where
    // the instructions point: the file still came from outside the account.
    const manifest = nativeManifest();
    manifest.version.instructions = "Check https://internal.example:8443/runbook first.";
    const result = await reviewOf([
        { name: "assistant.json", data: JSON.stringify(manifest) },
    ]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.review.instructionUrls, {
        count: 1,
        hosts: ["internal.example"],
    });
});

test("instruction URLs reach the review as hosts", async () => {
    const skill = [
        "---",
        "name: fetcher",
        "description: Points somewhere.",
        "---",
        "",
        // A query string, but not a credential-shaped one: the assertion is
        // about the host, and `?key=<12 characters>` is a line any secret
        // scanner has to report -- ours and the repository's both did.
        "Read https://docs.example.com/guide?section=intro first.",
    ].join("\n");
    const result = await reviewOf([{ name: "SKILL.md", data: skill }]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.review.instructionUrls, {
        count: 1,
        hosts: ["docs.example.com"],
    });
    assert.ok(!JSON.stringify(result.review.instructionUrls).includes("abc123"));
});
