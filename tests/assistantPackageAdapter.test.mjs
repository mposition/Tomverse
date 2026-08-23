// The Agent Skill adapter, and the loss report that is its real output.
//
// docs/policy/assistant-package-import.md §5.
//
// The conversion assertions are the easy half. What these mostly pin is the
// half a reviewer cannot see by reading the happy path: that a malformed
// package is refused rather than half-read, that nothing is chosen on the
// owner's behalf, and that every field the target cannot hold appears in the
// loss report by name.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ASSISTANT_PACKAGE_ADAPTER_VERSION,
    convertSkillPackage,
    looksLikeKnowledgeCandidate,
    parseSkillDocument,
} from "../lib/assistantPackageAdapter.ts";
import { ASSISTANT_PACKAGE_LIMITS } from "../lib/assistantPackageLimits.ts";

const EMPTY_INVENTORY = {
    skillDocument: "SKILL.md",
    knowledgeCandidates: [],
    scriptPaths: [],
    skippedCount: 0,
};

const parsed = (source) => {
    const result = parseSkillDocument(source);
    assert.equal(result.outcome, "parsed", `expected a parse, got ${result.reason}`);
    return result;
};

const lossKinds = (conversion) => conversion.losses.map((loss) => loss.kind);

/* ------------------------------------------------------------ the happy path */

test("a minimal SKILL.md yields a frontmatter and a body", () => {
    const result = parsed(
        ["---", "name: my-reviewer", "description: Reviews diffs.", "---", "", "# Reviewer", "", "Be brief."].join("\n")
    );
    assert.equal(result.frontmatter.name, "my-reviewer");
    assert.equal(result.frontmatter.description, "Reviews diffs.");
    assert.equal(result.frontmatter.license, null);
    assert.deepEqual(result.frontmatter.unknownKeys, []);
    assert.equal(result.body, "# Reviewer\n\nBe brief.");
});

test("CRLF and a byte order mark do not change what is parsed", () => {
    const withBom = "﻿---\r\nname: a\r\ndescription: b\r\n---\r\n\r\nBody.\r\n";
    const result = parsed(withBom);
    assert.equal(result.frontmatter.name, "a");
    assert.equal(result.body, "Body.");
});

test("a body containing a dashed line keeps it", () => {
    // The body is Markdown, and `---` is a horizontal rule. Only the first
    // block is frontmatter; the parser must not treat a later one as one.
    const result = parsed(
        ["---", "name: a", "description: b", "---", "", "One.", "", "---", "", "Two."].join("\n")
    );
    assert.match(result.body, /^One\./);
    assert.match(result.body, /Two\.$/);
});

/* ---------------------------------------------------------------- refusals */

test("a file with no frontmatter is refused, not read as a body", () => {
    const result = parseSkillDocument("# Just markdown\n\nNo frontmatter here.");
    assert.equal(result.outcome, "invalid");
    assert.equal(result.reason, "missing_frontmatter");
});

test("an unterminated frontmatter block is refused", () => {
    const result = parseSkillDocument("---\nname: a\ndescription: b\n\nBody without a close.");
    assert.equal(result.outcome, "invalid");
    assert.equal(result.reason, "missing_frontmatter");
});

test("malformed YAML is refused rather than partially recovered", () => {
    const result = parseSkillDocument(["---", "name: [unclosed", "---", "", "Body."].join("\n"));
    assert.equal(result.outcome, "invalid");
    assert.equal(result.reason, "malformed_yaml");
});

test("frontmatter that is not a mapping is refused", () => {
    const result = parseSkillDocument(["---", "- one", "- two", "---", "", "Body."].join("\n"));
    assert.equal(result.outcome, "invalid");
    assert.equal(result.reason, "frontmatter_not_a_map");
});

test("an instruction body over the limit is refused and never truncated", () => {
    const body = "x".repeat(ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters + 1);
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body,
        inventory: EMPTY_INVENTORY,
    });
    assert.equal(conversion.refusals.length, 1);
    assert.equal(conversion.refusals[0].code, "ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG");
    assert.equal(conversion.refusals[0].limit, ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters);
    assert.equal(conversion.refusals[0].characters, body.length);
    // The refusal is the point, but so is this: the value still carries the
    // whole body, so nothing downstream can mistake a shortened string for
    // what the package said.
    assert.equal(conversion.instructions.value.length, body.length);
});

test("a body exactly at the limit is accepted", () => {
    const body = "x".repeat(ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters);
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body,
        inventory: EMPTY_INVENTORY,
    });
    assert.deepEqual(conversion.refusals, []);
});

/* ------------------------------------------------------- nothing is decided */

test("no model is ever chosen for the owner", () => {
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "Use gpt-4o for this task.",
        inventory: EMPTY_INVENTORY,
    });
    assert.deepEqual(conversion.modelIds.value, []);
    assert.equal(conversion.modelIds.disposition, "needs_review");
    assert.ok(lossKinds(conversion).includes("model"));
});

test("tools and memory start off and are not requested by the package", () => {
    const conversion = convertSkillPackage({
        frontmatter: {
            name: "a",
            description: null,
            license: null,
            allowedTools: "Bash Read Write",
            unknownKeys: [],
        },
        body: "Body.",
        inventory: EMPTY_INVENTORY,
    });
    assert.deepEqual(conversion.toolPolicy.value, { webSearch: false, deepResearch: false });
    assert.deepEqual(conversion.memoryPolicy.value, { useAccountMemory: false });
    assert.ok(lossKinds(conversion).includes("allowed_tools"));
});

test("the name and the instructions always need a look", () => {
    const conversion = convertSkillPackage({
        frontmatter: { name: "short", description: "fine", license: null, allowedTools: null, unknownKeys: [] },
        body: "Body.",
        inventory: EMPTY_INVENTORY,
    });
    assert.equal(conversion.identity.name.disposition, "needs_review");
    assert.equal(conversion.instructions.disposition, "needs_review");
});

/* ------------------------------------------------------------- loss report */

test("scripts are named in the loss report and never treated as knowledge", () => {
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "Body.",
        inventory: {
            ...EMPTY_INVENTORY,
            scriptPaths: ["scripts/lint.py", "scripts/fetch.sh"],
        },
    });
    const scripts = conversion.losses.find((loss) => loss.kind === "scripts");
    assert.ok(scripts);
    // Data, not a sentence: the sentence is in the locales, and a loss that
    // carried English prose is a loss somebody renders untranslated.
    assert.equal(scripts.count, 2);
    assert.deepEqual(scripts.items, ["scripts/lint.py", "scripts/fetch.sh"]);
    assert.deepEqual(conversion.knowledgeCandidates, []);
});

test("a stated licence and a missing one are different things to say", () => {
    // One kind with two meanings would force every reader to look inside the
    // message to find out which it got.
    const absent = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "Body.",
        inventory: EMPTY_INVENTORY,
    });
    assert.deepEqual(absent.refusals, []);
    assert.ok(lossKinds(absent).includes("license_absent"));

    const stated = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: "MIT", allowedTools: null, unknownKeys: [] },
        body: "Body.",
        inventory: EMPTY_INVENTORY,
    });
    const licence = stated.losses.find((loss) => loss.kind === "license_stated");
    assert.ok(licence);
    assert.deepEqual(licence.items, ["MIT"]);
});

test("unrecognised frontmatter keys are counted and named, not dropped", () => {
    const result = parsed(
        ["---", "name: a", "description: b", "compatibility: node>=20", "wat: 1", "zzz: 2", "---", "", "Body."].join("\n")
    );
    assert.deepEqual(result.frontmatter.unknownKeys, ["wat", "zzz"]);
    const conversion = convertSkillPackage({
        frontmatter: result.frontmatter,
        body: result.body,
        inventory: EMPTY_INVENTORY,
    });
    const unknown = conversion.losses.find((loss) => loss.kind === "unknown_frontmatter");
    assert.ok(unknown);
    assert.equal(unknown.count, 2);
    assert.deepEqual(unknown.items, ["wat", "zzz"]);
});

test("knowledge candidates past the limit are reported rather than silently cut", () => {
    const candidates = Array.from(
        { length: ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles + 3 },
        (_, index) => ({ path: `references/${index}.md`, name: `${index}.md` })
    );
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "Body.",
        inventory: { ...EMPTY_INVENTORY, knowledgeCandidates: candidates },
    });
    assert.equal(
        conversion.knowledgeCandidates.length,
        ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles
    );
    assert.ok(lossKinds(conversion).includes("knowledge_over_limit"));
});

test("relative links in the body are called out", () => {
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "See [the forms guide](FORMS.md) for details.",
        inventory: EMPTY_INVENTORY,
    });
    assert.ok(lossKinds(conversion).includes("relative_links"));
});

test("an absolute link is not mistaken for a package-relative one", () => {
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "See [the docs](https://example.com/guide) for details.",
        inventory: EMPTY_INVENTORY,
    });
    assert.ok(!lossKinds(conversion).includes("relative_links"));
});

/* ---------------------------------------------------------------- A6: URLs */

test("instruction URLs are disclosed by host, without their paths", () => {
    const conversion = convertSkillPackage({
        frontmatter: { name: "a", description: null, license: null, allowedTools: null, unknownKeys: [] },
        body: "Fetch https://example.com/a?token=abc123 and https://example.com/b and http://other.test/x",
        inventory: EMPTY_INVENTORY,
    });
    assert.equal(conversion.instructionUrls.count, 3);
    assert.deepEqual(conversion.instructionUrls.hosts, ["example.com", "other.test"]);
    // The disclosure must not reproduce the query string that carried a token.
    assert.ok(!conversion.instructionUrls.hosts.some((host) => host.includes("token")));
});

/* -------------------------------------------------------------- extensions */

test("knowledge candidacy is decided by the allowlist, not by having a dot", () => {
    assert.equal(looksLikeKnowledgeCandidate("references/style.md"), true);
    assert.equal(looksLikeKnowledgeCandidate("references/api.pdf"), true);
    assert.equal(looksLikeKnowledgeCandidate("scripts/run.py"), false);
    assert.equal(looksLikeKnowledgeCandidate("assets/logo.png"), false);
    assert.equal(looksLikeKnowledgeCandidate("LICENSE"), false);
});

test("the adapter records its own version", () => {
    assert.equal(typeof ASSISTANT_PACKAGE_ADAPTER_VERSION, "string");
    assert.ok(ASSISTANT_PACKAGE_ADAPTER_VERSION.length > 0);
});
