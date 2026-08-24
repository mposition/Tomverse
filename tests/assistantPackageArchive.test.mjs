// Reading a package container: what is refused, what is skipped, and what is
// actually inflated (Slice 3).
//
// docs/policy/assistant-package-import.md §4, §5.2, §8.
//
// The archives here are written byte by byte because the interesting cases are
// the ones no ordinary ZIP writer produces. A test that can only build valid
// archives can only test the happy path, and the happy path is not where this
// module earns its place.

import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyPackageEntry,
    inflatePackageEntry,
    planPackageRead,
    readPackageDirectory,
} from "../lib/assistantPackageArchive.ts";
import { ASSISTANT_PACKAGE_LIMITS } from "../lib/assistantPackageLimits.ts";
import { buildZip, readerFor } from "./support/zipArchive.mjs";

const SKILL = ["---", "name: reviewer", "description: Reviews diffs.", "---", "", "Be brief."].join(
    "\n"
);

const directoryOf = async (entries) => {
    const bytes = buildZip(entries);
    const result = await readPackageDirectory(bytes.length, readerFor(bytes));
    return { bytes, result };
};

const planOf = async (entries) => {
    const { bytes, result } = await directoryOf(entries);
    assert.equal(result.outcome, "read", `directory refused: ${result.cause}`);
    return { bytes, plan: planPackageRead(result.entries) };
};

const refusalReasons = (plan) => plan.refusals.map((refusal) => refusal.reason);
const skipReasons = (plan) => plan.skips.map((skip) => skip.reason);
const readPaths = (plan) => plan.reads.map((read) => read.entry.path);

/* ------------------------------------------------------------- the reader */

test("the directory names every entry, in order, with its true sizes", async () => {
    const { result } = await directoryOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/style.md", data: "x".repeat(500) },
    ]);
    assert.equal(result.outcome, "read");
    assert.deepEqual(
        result.entries.map((entry) => entry.path),
        ["SKILL.md", "references/style.md"]
    );
    assert.equal(result.entries[0].uncompressedBytes, SKILL.length);
    assert.equal(result.entries[1].uncompressedBytes, 500);
    // The whole point of reading the directory: the compressed size is known
    // before a byte is inflated, so the ratio guard can bind.
    assert.ok(result.entries[1].compressedBytes < 500);
});

test("a container over the size limit is refused before it is opened", async () => {
    const bytes = buildZip([{ name: "SKILL.md", data: SKILL }]);
    const result = await readPackageDirectory(
        ASSISTANT_PACKAGE_LIMITS.maxContainerBytes + 1,
        readerFor(bytes)
    );
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_TOO_LARGE");
});

test("a container with no end record is refused, never guessed at", async () => {
    const bytes = buildZip([{ name: "SKILL.md", data: SKILL }]);
    const truncated = bytes.subarray(0, bytes.length - 22);
    const result = await readPackageDirectory(truncated.length, readerFor(truncated));
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED");
});

test("a directory that cannot be read does not fall back to local headers", async () => {
    // The conversation import's reader falls back here, on purpose. This one
    // must not: a package we cannot enumerate is a package we cannot report on.
    const bytes = buildZip([{ name: "SKILL.md", data: SKILL }]);
    const corrupted = Uint8Array.from(bytes);
    // Break the first central-directory signature.
    const eocdAt = corrupted.length - 22;
    const view = new DataView(corrupted.buffer);
    const directoryAt = view.getUint32(eocdAt + 16, true);
    corrupted[directoryAt] = 0x00;
    const result = await readPackageDirectory(corrupted.length, readerFor(corrupted));
    assert.equal(result.outcome, "refused");
    assert.equal(result.cause, "central_entry_signature");
});

test("a refusal names a cause and never an entry path", async () => {
    const bytes = buildZip([{ name: "secret-project/plan.md", data: "x" }]);
    const truncated = bytes.subarray(0, 10);
    const result = await readPackageDirectory(truncated.length, readerFor(truncated));
    assert.equal(result.outcome, "refused");
    assert.ok(!JSON.stringify(result).includes("secret-project"));
});

/* ---------------------------------------------------------------- refusals */

test("a traversal path is refused", async () => {
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "../../etc/passwd", data: "x" },
    ]);
    assert.deepEqual(refusalReasons(plan), ["path_traversal"]);
    assert.equal(plan.packageRefusal.code, "ASSISTANT_PACKAGE_UNSAFE_ENTRY");
});

test("a backslash in a name is refused, whatever its segments say", async () => {
    // Legal on POSIX, a separator on Windows. One name, two paths.
    const { plan } = await planOf([{ name: "docs\\..\\..\\evil.md", data: "x" }]);
    assert.deepEqual(refusalReasons(plan), ["path_traversal"]);
});

test("an absolute path is refused", async () => {
    const { plan } = await planOf([{ name: "/etc/hosts", data: "x" }]);
    assert.deepEqual(refusalReasons(plan), ["absolute_path"]);
});

test("a Windows drive letter is an absolute path too", async () => {
    const { plan } = await planOf([{ name: "C:/Windows/notes.md", data: "x" }]);
    assert.deepEqual(refusalReasons(plan), ["absolute_path"]);
});

test("a symlink entry is refused rather than followed or skipped", async () => {
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "reference.md", data: "/etc/passwd", symlink: true },
    ]);
    assert.deepEqual(refusalReasons(plan), ["symlink"]);
});

test("an encrypted entry refuses the package even where it would be skipped", async () => {
    // A media file we would never inflate, but an encrypted entry means the
    // inventory cannot say what the package contains, and the inventory is
    // what the owner approves.
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "assets/logo.png", data: "binary", encrypted: true },
    ]);
    assert.deepEqual(refusalReasons(plan), ["encrypted"]);
});

test("two entries with the same path are refused", async () => {
    const { plan } = await planOf([
        { name: "references/a.md", data: "one" },
        { name: "references/a.md", data: "two" },
    ]);
    assert.deepEqual(refusalReasons(plan), ["duplicate_path"]);
});

test("two entries differing only in case are refused", async () => {
    const { plan } = await planOf([
        { name: "README.md", data: "one" },
        { name: "readme.md", data: "two" },
    ]);
    assert.deepEqual(refusalReasons(plan), ["case_collision"]);
});

test("every bad entry is reported, not just the first", async () => {
    const { plan } = await planOf([
        { name: "../escape.md", data: "x" },
        { name: "/absolute.md", data: "x" },
        { name: "link.md", data: "x", symlink: true },
    ]);
    assert.deepEqual(refusalReasons(plan), [
        "path_traversal",
        "absolute_path",
        "symlink",
    ]);
});

test("an entry over the per-entry ceiling is refused", async () => {
    const { plan } = await planOf([
        {
            name: "references/huge.md",
            data: "x",
            declaredUncompressedBytes: ASSISTANT_PACKAGE_LIMITS.maxEntryBytes + 1,
            declaredCompressedBytes: ASSISTANT_PACKAGE_LIMITS.maxEntryBytes,
        },
    ]);
    assert.deepEqual(refusalReasons(plan), ["entry_too_large"]);
});

test("an entry whose declared ratio is a bomb is refused", async () => {
    const { plan } = await planOf([
        {
            name: "references/bomb.md",
            data: "x",
            declaredUncompressedBytes: 1_000_000,
            declaredCompressedBytes: 100,
        },
    ]);
    assert.deepEqual(refusalReasons(plan), ["suspicious_compression_ratio"]);
});

test("a large entry nothing would inflate does not refuse the package", async () => {
    // The video was never going to be read, so refusing here would be a
    // refusal the owner has no way to act on.
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        {
            name: "assets/demo.mp4",
            data: "x",
            declaredUncompressedBytes: ASSISTANT_PACKAGE_LIMITS.maxEntryBytes * 2,
            declaredCompressedBytes: ASSISTANT_PACKAGE_LIMITS.maxEntryBytes,
        },
    ]);
    assert.deepEqual(refusalReasons(plan), []);
    assert.deepEqual(skipReasons(plan), ["media"]);
});

test("more entries than the cap refuses the package", async () => {
    const entries = Array.from(
        { length: ASSISTANT_PACKAGE_LIMITS.maxEntries + 1 },
        (_, index) => ({ name: `references/${index}.md`, data: "x" })
    );
    const bytes = buildZip(entries);
    const result = await readPackageDirectory(bytes.length, readerFor(bytes));
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_TOO_MANY_ENTRIES");
});

test("a planned read over the total inflated budget refuses the package", async () => {
    const thirtyMegabytes = 30 * 1024 * 1024;
    const entries = Array.from({ length: 5 }, (_, index) => ({
        name: `references/${index}.md`,
        data: "x",
        declaredUncompressedBytes: thirtyMegabytes,
        declaredCompressedBytes: thirtyMegabytes / 2,
    }));
    const { plan } = await planOf(entries);
    assert.deepEqual(refusalReasons(plan), []);
    assert.equal(plan.packageRefusal.code, "ASSISTANT_PACKAGE_TOO_LARGE");
    assert.equal(plan.packageRefusal.cause, "total_inflated_bytes");
});

/* ------------------------------------------------------------------- skips */

test("scripts are skipped under their own reason and never planned for reading", async () => {
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "scripts/run.sh", data: "rm -rf /" },
        { name: "scripts/build.py", data: "import os" },
    ]);
    assert.deepEqual(skipReasons(plan), ["executable_script", "executable_script"]);
    assert.deepEqual(readPaths(plan), ["SKILL.md"]);
});

test("a nested archive is skipped as an archive, not as an unknown extension", async () => {
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "bundle.zip", data: "PK" },
    ]);
    assert.deepEqual(skipReasons(plan), ["nested_archive"]);
});

test("directories, media, empty files and unknown extensions each keep their reason", async () => {
    const { plan } = await planOf([
        { name: "references/", data: "" },
        { name: "assets/logo.png", data: "binary" },
        { name: "references/empty.md", data: "" },
        { name: "Makefile.mk", data: "all:" },
    ]);
    assert.deepEqual(skipReasons(plan), [
        "directory",
        "media",
        "empty",
        "unsupported_extension",
    ]);
});

/* ------------------------------------------------------------------- reads */

test("the manifest and the skill document are recognised by role", async () => {
    const { plan } = await planOf([
        { name: "assistant.json", data: "{}" },
        { name: "SKILL.md", data: SKILL },
    ]);
    assert.deepEqual(
        plan.reads.map((read) => read.role),
        ["manifest", "skill_document"]
    );
});

test("a manifest in a subdirectory is not the manifest", async () => {
    // Root or nothing: an `assistant.json` under `examples/` is a sample
    // someone shipped, and reading it as the manifest imports the example. It
    // is still an ordinary JSON document, so it stays a knowledge candidate --
    // what it loses is the authority the manifest role carries.
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "examples/assistant.json", data: "{}" },
    ]);
    assert.deepEqual(
        plan.reads.map((read) => read.role),
        ["skill_document", "knowledge"]
    );
    assert.deepEqual(skipReasons(plan), []);
});

test("documents the knowledge tables accept are planned as knowledge", async () => {
    const { plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/style.md", data: "Style." },
        { name: "references/api.pdf", data: "%PDF-" },
        { name: "references/rows.csv", data: "a,b" },
    ]);
    assert.deepEqual(readPaths(plan), [
        "SKILL.md",
        "references/style.md",
        "references/api.pdf",
        "references/rows.csv",
    ]);
    assert.equal(
        plan.plannedInflatedBytes,
        SKILL.length + "Style.".length + "%PDF-".length + "a,b".length
    );
});

/* -------------------------------------------------------------- inflation */

test("a deflated entry round-trips", async () => {
    const body = "Style guide.\n".repeat(200);
    const { bytes, plan } = await planOf([
        { name: "SKILL.md", data: SKILL },
        { name: "references/style.md", data: body },
    ]);
    const entry = plan.reads[1].entry;
    const result = await inflatePackageEntry(entry, readerFor(bytes));
    assert.equal(result.outcome, "read");
    assert.equal(new TextDecoder().decode(result.bytes), body);
});

test("a stored entry round-trips", async () => {
    const { bytes, plan } = await planOf([
        { name: "SKILL.md", data: SKILL, method: "store" },
    ]);
    const result = await inflatePackageEntry(plan.reads[0].entry, readerFor(bytes));
    assert.equal(result.outcome, "read");
    assert.equal(new TextDecoder().decode(result.bytes), SKILL);
});

test("an entry that inflates to more than it promised is refused, not truncated", async () => {
    // The failure this pins: fflate fills the output buffer it is handed and
    // stops rather than throwing, so a buffer sized at the promised length
    // would return exactly the promised length and pass a naive check --
    // accepted, and silently cut. Every budget was computed from that promise.
    const { bytes, plan } = await planOf([
        {
            name: "references/liar.md",
            data: "x".repeat(1000),
            declaredUncompressedBytes: 900,
        },
    ]);
    const result = await inflatePackageEntry(plan.reads[0].entry, readerFor(bytes));
    assert.deepEqual(result, {
        outcome: "refused",
        reason: "suspicious_compression_ratio",
    });
});

test("an entry that inflates to less than it promised is refused too", async () => {
    // Most of these never reach inflation: a declared size far above the
    // compressed one is refused by the ratio guard while planning. This is the
    // one that gets through it, and it must still not be accepted short.
    const { bytes, plan } = await planOf([
        {
            name: "references/short.md",
            data: "x".repeat(200),
            declaredUncompressedBytes: 500,
        },
    ]);
    const result = await inflatePackageEntry(plan.reads[0].entry, readerFor(bytes));
    assert.deepEqual(result, {
        outcome: "refused",
        reason: "suspicious_compression_ratio",
    });
});

test("a compression method this parser does not read is declined, not attempted", async () => {
    const { bytes, result } = await directoryOf([
        { name: "references/lzma.md", data: "x".repeat(100), method: 14 },
    ]);
    assert.equal(result.outcome, "read");
    const outcome = await inflatePackageEntry(result.entries[0], readerFor(bytes));
    assert.deepEqual(outcome, { outcome: "unreadable", cause: "compression_method" });
});

test("an entry promising nothing inflates to nothing", async () => {
    const { bytes, result } = await directoryOf([
        { name: "assistant.json", data: "" },
    ]);
    assert.equal(result.outcome, "read");
    const outcome = await inflatePackageEntry(result.entries[0], readerFor(bytes));
    assert.equal(outcome.outcome, "read");
    assert.equal(outcome.bytes.length, 0);
});

test("the entry ceiling binds at inflation as well as at planning", async () => {
    // Planning is where this is normally caught. Checking it again here means
    // a future caller that inflates an entry it did not plan cannot bypass it.
    const outcome = await inflatePackageEntry(
        {
            path: "references/huge.md",
            uncompressedBytes: ASSISTANT_PACKAGE_LIMITS.maxEntryBytes + 1,
            compressedBytes: 10,
            compressionMethod: 8,
            encrypted: false,
            symlink: false,
            directory: false,
            localHeaderOffset: 0,
        },
        readerFor(new Uint8Array(0))
    );
    assert.deepEqual(outcome, { outcome: "refused", reason: "entry_too_large" });
});

/* ------------------------------------------------------------ the verdicts */

test("classification is decided from the directory record alone", async () => {
    const seen = { paths: new Set(), lowered: new Set() };
    const entry = {
        path: "references/style.md",
        uncompressedBytes: 10,
        compressedBytes: 5,
        compressionMethod: 8,
        encrypted: false,
        symlink: false,
        directory: false,
        localHeaderOffset: 0,
    };
    assert.deepEqual(classifyPackageEntry(entry, seen), {
        disposition: "read",
        role: "knowledge",
    });
    assert.deepEqual(classifyPackageEntry({ ...entry, encrypted: true }, seen), {
        disposition: "refuse",
        reason: "encrypted",
    });
});
