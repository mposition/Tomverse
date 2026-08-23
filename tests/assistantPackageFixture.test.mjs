// The parser against a package somebody actually published (Slice 3).
//
// docs/policy/assistant-package-import.md §5.
// Provenance and the answer key: tests/fixtures/assistantPackages/README.md.
//
// Everything else in this suite builds its own archives, which proves the
// parser agrees with the writer next to it. This one does not: the container
// was produced by a real toolchain from a real skill, and the expectations are
// checked against a hand-computed answer key rather than against the parser's
// own output.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
    inflatePackageEntry,
    planPackageRead,
    readPackageDirectory,
} from "../lib/assistantPackageArchive.ts";
import { buildPackageReview } from "../lib/assistantPackageReview.ts";

const fixture = (name) =>
    new Uint8Array(
        readFileSync(fileURLToPath(new URL(`./fixtures/assistantPackages/${name}`, import.meta.url)))
    );

const expected = JSON.parse(
    readFileSync(
        fileURLToPath(
            new URL("./fixtures/assistantPackages/webapp-testing.expected.json", import.meta.url)
        ),
        "utf8"
    )
);

const sha256Hex = async (input) =>
    createHash("sha256")
        .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
        .digest("hex");

const open = async (bytes) => {
    const read = async (start, end) =>
        bytes.subarray(Math.max(0, start), Math.min(bytes.length, end));
    const directory = await readPackageDirectory(bytes.length, read);
    assert.equal(directory.outcome, "read");
    const plan = planPackageRead(directory.entries);
    const entries = new Map();
    for (const item of plan.reads) {
        const result = await inflatePackageEntry(item.entry, read);
        assert.equal(result.outcome, "read");
        entries.set(item.entry.path, result.bytes);
    }
    return { plan, entries, review: await buildPackageReview({ plan, entries, sha256Hex }) };
};

const PACKAGE = "webapp-testing.skill.zip";

test("the fixture is the archive the provenance record names", () => {
    // A fixture whose bytes drifted from its record is a fixture that proves
    // something about a package nobody can identify.
    assert.equal(
        createHash("sha256").update(fixture(PACKAGE)).digest("hex"),
        "ab7dfc8c202805bdd277225e4704b760bdfde2e5a9011fb89a0ad0d09e27216f"
    );
});

test("a published Agent Skill converts to the reviewed proposal in the answer key", async () => {
    const { review: result } = await open(fixture(PACKAGE));
    assert.equal(result.outcome, "review");
    const review = result.review;

    assert.equal(review.kind, expected.kind);
    assert.equal(review.identity.name.value, expected.name);
    assert.equal(review.identity.description.value, expected.description);
    assert.equal(review.instructions.value.length, expected.instructionsLength);
    assert.ok(review.instructions.value.startsWith(expected.instructionsHead));
    assert.deepEqual(review.modelIds.value, expected.modelIds);
    assert.deepEqual(review.toolPolicy.value, expected.toolPolicy);
    assert.deepEqual(review.memoryPolicy.value, expected.memoryPolicy);
    assert.deepEqual(review.knowledgeCandidates, expected.knowledgeCandidates);
    assert.deepEqual(review.skips, expected.skips);
    assert.deepEqual(review.instructionUrls, expected.instructionUrls);
    assert.deepEqual(review.secretFindings, expected.secretFindings);
    assert.deepEqual(
        review.losses.map((loss) => loss.kind),
        expected.losses.map((loss) => loss.kind)
    );
});

test("its scripts are never inflated", async () => {
    const { plan, entries } = await open(fixture(PACKAGE));
    const scripts = plan.skips.filter((skip) => skip.reason === "executable_script");
    assert.equal(scripts.length, 4);
    for (const script of scripts) {
        assert.ok(script.path.endsWith(".py"));
        // Not "read and discarded": the bytes were never decompressed, so
        // there is nothing in the map to discard.
        assert.equal(entries.has(script.path), false);
    }
});

test("no loss is reported twice under two headings", async () => {
    // The scripts line already names those four files; a second line counting
    // them again as "files this import does not use" would read as eight.
    const { review: result } = await open(fixture(PACKAGE));
    assert.equal(result.outcome, "review");
    assert.equal(
        result.review.losses.filter((loss) => loss.kind === "skipped_entries").length,
        0
    );
});
