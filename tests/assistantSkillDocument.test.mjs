// Importing and exporting an assistant as SKILL.md.
//
// docs/policy/assistant-package-import.md §1, §5, §6.
//
// The reading half (a SKILL.md inside a package) is covered by
// assistantPackageAdapter / assistantPackageReview. This file covers what the
// SKILL.md work added: a SKILL.md chosen on its own, a skill folder zipped as
// `name/SKILL.md`, the writer, and the two together as a round trip.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSkillDocument } from "../lib/assistantPackageAdapter.ts";
import {
    inflatePackageEntry,
    planPackageRead,
    readPackageDirectory,
} from "../lib/assistantPackageArchive.ts";
import {
    PROFILE_INSTRUCTION_RULES,
    buildProfileInstructionPrompt,
    buildProfileSystemPrompt,
} from "../lib/assistantProfilePrompt.ts";
import { estimatePromptTokens } from "../lib/chatTokenEstimate.ts";
import { ASSISTANT_PACKAGE_LIMITS } from "../lib/assistantPackageLimits.ts";
import {
    buildBareSkillReview,
    buildPackageReview,
    isBareSkillDocumentName,
} from "../lib/assistantPackageReview.ts";
import {
    SKILL_DOCUMENT_LIMITS,
    buildSkillDocument,
    skillNameFromProfileName,
} from "../lib/assistantSkillDocument.ts";
import { buildZip, readerFor } from "./support/zipArchive.mjs";

const sha256Hex = async (input) =>
    createHash("sha256")
        .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
        .digest("hex");

const encode = (text) => new TextEncoder().encode(text);

const bare = (text) => buildBareSkillReview({ bytes: encode(text), sha256Hex });

const SPEC_EXAMPLE = readFileSync(
    fileURLToPath(
        new URL(
            "./fixtures/assistantPackages/agentskills-spec-pdf-processing.SKILL.md",
            import.meta.url
        )
    ),
    "utf8"
);

const reviewZip = async (entries) => {
    const bytes = buildZip(entries);
    const read = readerFor(bytes);
    const directory = await readPackageDirectory(bytes.length, read);
    assert.equal(directory.outcome, "read");
    const plan = planPackageRead(directory.entries);
    const inflated = new Map();
    for (const item of plan.reads) {
        const result = await inflatePackageEntry(item.entry, read);
        assert.equal(result.outcome, "read");
        inflated.set(item.entry.path, result.bytes);
    }
    return { plan, result: await buildPackageReview({ plan, entries: inflated, sha256Hex }) };
};

const lossKinds = (review) => review.losses.map((loss) => loss.kind);

/* -------------------------------------------------- a bare SKILL.md */

test("names ending in .md or .markdown are read as a bare skill document", () => {
    assert.equal(isBareSkillDocumentName("SKILL.md"), true);
    assert.equal(isBareSkillDocumentName("my-skill.MARKDOWN"), true);
    assert.equal(isBareSkillDocumentName("pack.zip"), false);
    assert.equal(isBareSkillDocumentName("assistant.json"), false);
});

test("the specification's own example imports as a proposal", async () => {
    const result = await bare(SPEC_EXAMPLE);
    assert.equal(result.outcome, "review");
    const { review } = result;
    assert.equal(review.kind, "agent-skill");
    assert.equal(review.identity.name.value, "pdf-processing");
    assert.equal(
        review.identity.description.value,
        "Extract PDF text, fill forms, merge files. Use when handling PDFs."
    );
    assert.match(review.instructions.value, /^See \[the reference guide\]/);
    // Nothing is decided for the owner.
    assert.equal(review.instructions.disposition, "needs_review");
    assert.deepEqual(review.knowledgeCandidates, []);
    assert.deepEqual(review.modelIds.value, []);
    assert.deepEqual(review.toolPolicy.value, { webSearch: false, deepResearch: false });
});

test("allowed-tools is reported as lost and never becomes a tool policy", async () => {
    const result = await bare(SPEC_EXAMPLE);
    assert.equal(result.outcome, "review");
    const lost = result.review.losses.find((loss) => loss.kind === "allowed_tools");
    assert.deepEqual(lost?.items, ["Bash(git:*) Bash(jq:*) Read"]);
    assert.deepEqual(result.review.toolPolicy.value, { webSearch: false, deepResearch: false });
    assert.deepEqual(result.review.memoryPolicy.value, { useAccountMemory: false });
});

test("the licence is stated and package-relative links are called out", async () => {
    const result = await bare(SPEC_EXAMPLE);
    assert.equal(result.outcome, "review");
    const kinds = lossKinds(result.review);
    assert.ok(kinds.includes("license_stated"));
    assert.ok(kinds.includes("relative_links"));
});

test("a bare document has no documents to bring across and no skipped entries", async () => {
    const result = await bare(SPEC_EXAMPLE);
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.review.skips, []);
    assert.ok(!lossKinds(result.review).includes("scripts"));
});

test("a file with no frontmatter is refused by its own reason", async () => {
    const result = await bare("# Just a heading\n\nSome notes.");
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED");
    assert.equal(result.cause, "missing_frontmatter");
});

test("malformed frontmatter is refused rather than half-read", async () => {
    const result = await bare("---\nname: [unclosed\n---\nBody");
    assert.equal(result.outcome, "refused");
    assert.equal(result.cause, "malformed_yaml");
});

test("a missing name comes back empty for the owner to fill, not invented", async () => {
    const result = await bare("---\ndescription: Does a thing.\n---\n\nDo the thing.");
    assert.equal(result.outcome, "review");
    assert.equal(result.review.identity.name.value, "");
    assert.equal(result.review.identity.name.disposition, "needs_review");
    assert.equal(result.review.identity.description.value, "Does a thing.");
});

test("a missing description comes back null, not invented", async () => {
    const result = await bare("---\nname: no-description\n---\n\nDo the thing.");
    assert.equal(result.outcome, "review");
    assert.equal(result.review.identity.name.value, "no-description");
    assert.equal(result.review.identity.description.value, null);
});

test("a body over the instruction limit is refused and never truncated", async () => {
    const limit = ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters;
    const result = await bare(`---\nname: big\ndescription: Too much.\n---\n\n${"a".repeat(limit + 1)}`);
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG");
});

test("a file over the entry ceiling is refused before it is decoded", async () => {
    const result = await buildBareSkillReview({
        bytes: new Uint8Array(ASSISTANT_PACKAGE_LIMITS.maxEntryBytes + 1),
        sha256Hex,
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_TOO_LARGE");
});

test("a file that is not UTF-8 is refused, not decoded leniently", async () => {
    const result = await buildBareSkillReview({
        bytes: new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d]),
        sha256Hex,
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.cause, "skill_document_not_utf8");
});

test("a credential in the body is found without echoing it", async () => {
    const result = await bare(
        "---\nname: leaky\ndescription: Has a key.\n---\n\nUse sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH to call the API."
    );
    assert.equal(result.outcome, "review");
    assert.ok(result.review.secretFindings.length > 0);
    assert.ok(!JSON.stringify(result.review.secretFindings).includes("abcdefghijklmnopqrstuvwxyz0123456789"));
});

/* ------------------------------------------- a skill folder, zipped */

const FOLDER_SKILL = "---\nname: code-reviewer\ndescription: Reviews diffs.\n---\n\nRead the diff.";

test("a skill zipped as its folder opens as if the folder were the root", async () => {
    const { result } = await reviewZip([
        { name: "code-reviewer/SKILL.md", data: FOLDER_SKILL },
        { name: "code-reviewer/references/style.md", data: "Prefer short sentences." },
        { name: "code-reviewer/scripts/lint.sh", data: "#!/bin/sh\necho hi" },
    ]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.identity.name.value, "code-reviewer");
    assert.deepEqual(
        result.review.knowledgeCandidates.map((candidate) => candidate.path),
        ["references/style.md"]
    );
    const scripts = result.review.losses.find((loss) => loss.kind === "scripts");
    assert.deepEqual(scripts?.items, ["scripts/lint.sh"]);
});

test("scripts in a skill zip are never inflated", async () => {
    const { plan } = await reviewZip([
        { name: "code-reviewer/SKILL.md", data: FOLDER_SKILL },
        { name: "code-reviewer/scripts/run.py", data: "print('hi')" },
        { name: "code-reviewer/scripts/run.sh", data: "echo hi" },
    ]);
    assert.deepEqual(
        plan.reads.map((read) => read.entry.path),
        ["SKILL.md"]
    );
    assert.deepEqual(
        plan.skips.filter((skip) => skip.reason === "executable_script").map((skip) => skip.path).sort(),
        ["scripts/run.py", "scripts/run.sh"]
    );
});

test("a Finder-made zip with its __MACOSX mirror still opens", async () => {
    const { result } = await reviewZip([
        { name: "code-reviewer/SKILL.md", data: FOLDER_SKILL },
        { name: "__MACOSX/code-reviewer/._SKILL.md", data: "junk" },
    ]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(result.review.knowledgeCandidates, []);
});

test("a folder entry alongside the files does not break the root", async () => {
    const { result } = await reviewZip([
        { name: "code-reviewer/", data: "" },
        { name: "code-reviewer/SKILL.md", data: FOLDER_SKILL },
    ]);
    assert.equal(result.outcome, "review");
});

test("a root-level SKILL.md is still read exactly as before", async () => {
    const { result } = await reviewZip([
        { name: "SKILL.md", data: FOLDER_SKILL },
        { name: "references/style.md", data: "Prefer short sentences." },
    ]);
    assert.equal(result.outcome, "review");
    assert.deepEqual(
        result.review.knowledgeCandidates.map((candidate) => candidate.path),
        ["references/style.md"]
    );
});

test("two top-level folders are not collapsed into one", async () => {
    const { result } = await reviewZip([
        { name: "a/SKILL.md", data: FOLDER_SKILL },
        { name: "b/notes.md", data: "x" },
    ]);
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED");
});

test("a folder that holds no SKILL.md is not treated as a root", async () => {
    const { result } = await reviewZip([{ name: "docs/notes.md", data: "x" }]);
    assert.equal(result.outcome, "refused");
});

test("an escaping path under the skill folder still refuses the whole package", async () => {
    const { plan, result } = await reviewZip([
        { name: "code-reviewer/SKILL.md", data: FOLDER_SKILL },
        { name: "code-reviewer/../../evil.md", data: "x" },
    ]);
    assert.equal(plan.packageRefusal?.code, "ASSISTANT_PACKAGE_UNSAFE_ENTRY");
    assert.equal(plan.packageRefusal?.cause, "path_traversal");
    assert.equal(result.outcome, "refused");
});

test("an absolute or backslash path is refused even with a skill folder", async () => {
    for (const name of ["code-reviewer\\SKILL.md", "/code-reviewer/SKILL.md"]) {
        const bytes = buildZip([{ name, data: FOLDER_SKILL }]);
        const directory = await readPackageDirectory(bytes.length, readerFor(bytes));
        assert.equal(directory.outcome, "read");
        const plan = planPackageRead(directory.entries);
        assert.equal(plan.packageRefusal?.code, "ASSISTANT_PACKAGE_UNSAFE_ENTRY", name);
    }
});

/* -------------------------------------------------------- the writer */

test("skill names follow the specification", () => {
    assert.equal(skillNameFromProfileName("Code Reviewer"), "code-reviewer");
    assert.equal(skillNameFromProfileName("  --Café  Ünïcode!!  "), "cafe-unicode");
    assert.equal(skillNameFromProfileName("한국어 튜터"), "assistant");
    assert.equal(skillNameFromProfileName("!!!"), "assistant");
    const long = skillNameFromProfileName(`${"a".repeat(63)} b`);
    assert.ok(long.length <= SKILL_DOCUMENT_LIMITS.maxNameCharacters);
    assert.ok(!long.endsWith("-"));
    for (const name of ["Code Reviewer", "Tom's  helper #1", "x".repeat(200)]) {
        assert.match(skillNameFromProfileName(name), /^[a-z0-9]+(-[a-z0-9]+)*$/u);
    }
});

test("the exported frontmatter has the two required fields and nothing else", () => {
    const text = buildSkillDocument({
        name: "Code Reviewer",
        description: "Reviews diffs and reports risks.",
        instructions: "Read the diff.\n\nReport risks.",
    });
    const parsed = parseSkillDocument(text);
    assert.equal(parsed.outcome, "parsed");
    assert.equal(parsed.frontmatter.name, "code-reviewer");
    assert.equal(parsed.frontmatter.description, "Reviews diffs and reports risks.");
    assert.equal(parsed.frontmatter.license, null);
    assert.equal(parsed.frontmatter.allowedTools, null);
    assert.deepEqual(parsed.frontmatter.unknownKeys, []);
    assert.equal(parsed.body, "Read the diff.\n\nReport risks.");
    const header = text.split("\n---\n")[0].split("\n").slice(1);
    assert.deepEqual(
        header.map((line) => line.split(":")[0]),
        ["name", "description"]
    );
});

test("a missing description falls back to the display name", () => {
    const text = buildSkillDocument({ name: "Tutor", description: null, instructions: "Teach." });
    const parsed = parseSkillDocument(text);
    assert.equal(parsed.outcome, "parsed");
    assert.equal(parsed.frontmatter.description, "Tutor");
});

test("a description with YAML-significant characters survives the round trip", () => {
    const description = 'Use when: the user says "review" # not a comment, or asks about {braces}.';
    const text = buildSkillDocument({ name: "Quoter", description, instructions: "Body." });
    const parsed = parseSkillDocument(text);
    assert.equal(parsed.outcome, "parsed");
    assert.equal(parsed.frontmatter.description, description);
});

test("a body holding a line of dashes is not mistaken for the end of the frontmatter", () => {
    const instructions = "Intro\n\n---\n\nAfter the rule.";
    const parsed = parseSkillDocument(
        buildSkillDocument({ name: "Rule", description: "d", instructions })
    );
    assert.equal(parsed.outcome, "parsed");
    assert.equal(parsed.body, instructions);
});

test("an empty body is exported as a valid document", () => {
    const parsed = parseSkillDocument(
        buildSkillDocument({ name: "Preset", description: "A model preset.", instructions: "" })
    );
    assert.equal(parsed.outcome, "parsed");
    assert.equal(parsed.body, "");
});

test("an exported assistant imports back to the same instructions and description", async () => {
    const source = {
        name: "Code Reviewer",
        description: "Reviews diffs and reports risks. Use when asked to review code.",
        instructions: "# Reviewer\n\n- Read the diff.\n- Report what would break.\n\nSee https://example.com/style.",
    };
    const result = await bare(buildSkillDocument(source));
    assert.equal(result.outcome, "review");
    assert.equal(result.review.identity.name.value, "code-reviewer");
    assert.equal(result.review.identity.description.value, source.description);
    assert.equal(result.review.instructions.value, source.instructions);
    assert.deepEqual(result.review.instructionUrls.hosts, ["example.com"]);
});

test("a zipped export imports too", async () => {
    const text = buildSkillDocument({
        name: "Tutor",
        description: "Teaches.",
        instructions: "Be patient.",
    });
    const { result } = await reviewZip([{ name: "tutor/SKILL.md", data: text }]);
    assert.equal(result.outcome, "review");
    assert.equal(result.review.instructions.value, "Be patient.");
});

/* ------------------------------------------ the turn's system block */

test("an imported skill body reaches the system block and the prompt estimate", async () => {
    const result = await bare(SPEC_EXAMPLE);
    assert.equal(result.outcome, "review");
    const body = result.review.instructions.value;

    const instructions = buildProfileInstructionPrompt(body);
    assert.ok(instructions?.endsWith(body));
    // The owner's instructions sit under the two framing lines, as for any
    // assistant, and nothing about the skill widens what they may do.
    assert.ok(instructions?.startsWith(PROFILE_INSTRUCTION_RULES));

    const system = buildProfileSystemPrompt({ instructions, memory: null, knowledge: null });
    assert.equal(system, instructions);

    // The framing is priced with the body, which is what `profileTokens` sums.
    assert.ok(estimatePromptTokens(instructions) > estimatePromptTokens(body));
});
