import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyFile,
    policyDocumentsNamedIn,
    sectionsFromMarkdown,
} from "../scripts/check-policy-section-references-core.mjs";

/**
 * The gate behind `npm run check:policy-section-references`.
 *
 * It exists because Release C shipped 105 citations of sections that do not
 * exist — numbers 31, 32 and 42 to 46, carried over from a specification that
 * was never committed — and no check noticed, because every one of them sat
 * beside a document path that was perfectly correct.
 *
 * A checker nobody tests is the same class of thing. These are the cases it
 * has to get right: a valid citation passes, a missing one fails, and one
 * nobody can resolve is reported as such rather than guessed at.
 */

const IMPORT = "docs/policy/external-conversation-import-and-memory.md";
const IMAGE = "docs/policy/image-generation.md";

const sections = new Map([
    [IMPORT, sectionsFromMarkdown("## 9. Retrieval\n### 9.1 Prompt boundary\n## 14. Assistant Profile\n")],
    [IMAGE, sectionsFromMarkdown("## 9. Pricing\n## 16. Rollout\n")],
]);

const classify = (source, overrides = {}) =>
    classifyFile({ file: "lib/example.ts", source, sections, ...overrides });

/* ------------------------------------------------------------ valid */

test("an explicit citation of a section that exists passes", () => {
    const result = classify(`/** ${IMPORT} §14. */`);
    assert.deepEqual(result.missing, []);
    assert.equal(result.valid, 1);
});

test("an explicit list validates every section in it", () => {
    const result = classify(`/** ${IMPORT} §9.1, §14. */`);
    assert.deepEqual(result.missing, []);
    assert.equal(result.valid, 2);
});

test("a bare citation resolves against the document the file names", () => {
    const result = classify(`/** ${IMPORT} — the contract. */\n// §14 says so.`);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unscoped, []);
    // One citation: the first line names the document but cites nothing.
    assert.equal(result.valid, 1);
});

/* ---------------------------------------------------------- missing */

test("an explicit citation of a section its document lacks fails", () => {
    // The Release C failure, in one line.
    const result = classify(`/** ${IMPORT} §45. */`);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /§45 does not exist/);
});

test("a bare citation of a section no policy document has fails", () => {
    // No baseline for this one: it is wrong however the file is written.
    const result = classify(`/** ${IMPORT} — the contract. */\n// §42 requires it.`);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /§42 exists in no policy document/);
});

test("a section number that exists only in another document still fails when named explicitly", () => {
    const result = classify(`/** ${IMAGE} §14. */`);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /§14 does not exist in image-generation\.md/);
});

/* --------------------------------------------------------- unscoped */

test("a bare citation with no document to resolve against is unscoped, not missing", () => {
    // §14 exists somewhere, so this is a legibility problem rather than a
    // wrong reference — and the two must not be reported as the same thing.
    const result = classify("// §14 requires it.");
    assert.deepEqual(result.missing, []);
    assert.equal(result.unscoped.length, 1);
    assert.match(result.unscoped[0], /names no policy document/);
});

test("a bare citation absent from the document the file does name is unscoped", () => {
    const result = classify(`/** ${IMAGE} — images. */\n// §14 requires it.`);
    assert.deepEqual(result.missing, []);
    assert.equal(result.unscoped.length, 1);
    assert.match(result.unscoped[0], /not in image-generation\.md/);
});

/* -------------------------------------------------------- ambiguous */

test("a bare citation both named documents have is ambiguous", () => {
    // §9 is retrieval in one and pricing in the other. A reader cannot tell.
    const result = classify(`/** ${IMPORT} and ${IMAGE}. */\n// §9 applies.`);
    assert.deepEqual(result.missing, []);
    assert.equal(result.ambiguous.length, 1);
    assert.match(result.ambiguous[0], /could mean .* or /);
});

test("writing the document beside the number resolves the ambiguity", () => {
    const result = classify(`/** ${IMPORT} and ${IMAGE}. */\n// ${IMPORT} §9 applies.`);
    assert.deepEqual(result.ambiguous, []);
    assert.deepEqual(result.missing, []);
});

/* ------------------------------------------------- what is not ours */

test("a standards citation is not a policy citation", () => {
    // RFC 9111 §5.2.2.5 is a real reference to a document this check does not
    // own. Reporting it would train people to ignore the check.
    const result = classify("// RFC 9111 §5.2.2.5 gives no-store one meaning.");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unscoped, []);
});

test("a line naming another markdown document leaves its numbering alone", () => {
    const result = classify("// See §7.5 of .github/RELEASE_CHECKLIST.md.");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unscoped, []);
});

test("a document citing its own section is left alone", () => {
    const source = "## 7. Freeze\n### 7.2 How\n\nSee §7.2.\n";
    const result = classifyFile({
        file: "docs/ops/example.md",
        source,
        sections,
        ownSections: sectionsFromMarkdown(source),
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unscoped, []);
});

test("an exempt section is skipped and nothing else is", () => {
    const source = "// §7.5 of the release checklist, and §42 of nothing.";
    const result = classifyFile({
        file: "lib/example.ts",
        source,
        sections,
        exempt: new Set(["7.5"]),
    });
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /§42/);
});

/* ------------------------------------------------------- the pieces */

test("headings are read with or without a trailing dot", () => {
    const found = sectionsFromMarkdown("## 14. Assistant Profile\n### 9.1 Prompt boundary\n");
    assert.ok(found.has("14"));
    assert.ok(found.has("9.1"));
});

test("a number that is not a heading is not a section", () => {
    const found = sectionsFromMarkdown("Some prose about 14. things\n#### Not 9.1 either? no\n");
    assert.equal(found.has("14"), false);
});

test("only policy documents count as named", () => {
    const named = policyDocumentsNamedIn(
        `see ${IMPORT} and docs/policy/imaginary.md and docs/ops/whatever.md`,
        new Set(sections.keys())
    );
    assert.deepEqual(named, [IMPORT]);
});

/* ------------------------------------------------------- block scope */

test("a comment block that names a document scopes the citations inside it", () => {
    // How these files are already written: a header names the policy and the
    // paragraphs under it say §14. It also matters in prisma/schema.prisma,
    // where one file covers several policies and each model's own block is
    // the right scope.
    const source = [
        "model A {",
        `  /// ${IMAGE} — image conversations.`,
        "  /// §9 prices them.",
        "}",
        "model B {",
        `  /// ${IMPORT} — the profile contract.`,
        "  /// §9 is retrieval here.",
        "}",
    ].join("\n");
    const result = classifyFile({ file: "prisma/schema.prisma", source, sections });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.ambiguous, []);
    assert.equal(result.valid, 2);
});

test("a block naming nothing falls back to the file", () => {
    const source = [
        `/** ${IMPORT} — the contract. */`,
        "",
        "/** A later block. §14 applies. */",
    ].join("\n");
    assert.deepEqual(classify(source).unscoped, []);
});

test("code between two blocks ends the first one's scope", () => {
    // Otherwise a declaration at the top of a file would silently scope a
    // comment five hundred lines below it that is about something else.
    const source = [
        `/** ${IMAGE} — images. */`,
        "const x = 1;",
        "/** §9.1 applies. */",
    ].join("\n");
    const result = classify(source);
    // §9.1 is not in image-generation.md, and the file names nothing else.
    assert.equal(result.unscoped.length, 1);
});

/* -------------------------------------------------- the command itself -- */

const SCRIPT = fileURLToPath(
    new URL("../scripts/check-policy-section-references.mjs", import.meta.url)
);

const runIn = (cwd) => {
    try {
        const stdout = execFileSync(process.execPath, [SCRIPT], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, output: stdout };
    } catch (error) {
        return {
            status: error.status ?? 1,
            output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
        };
    }
};

/** A throwaway repository seeded with exactly the files a case needs. */
const repoWith = (files) => {
    const root = mkdtempSync(path.join(tmpdir(), "policy-section-"));
    const git = (...args) =>
        execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    git("add", "-A");
    git("commit", "-qm", "seed");
    return root;
};

test("the command refuses a run that resolved no policy documents", (t) => {
    // The defect this closes, at the level it happened. Until 2026-09-04 the
    // file list was built by interpolating patterns into a shell string and
    // quoting them for a POSIX shell, so on Windows `git ls-files` was handed
    // a literal `'docs/policy/*.md'` and matched nothing. The run then
    // printed "0 citation(s) against 0 policy document(s)" and exited 0.
    //
    // That is the shape worth testing: not the quoting, which a rewrite would
    // change, but the claim. A gate that scanned nothing must not report a pass,
    // however it came to scan nothing.
    const root = repoWith({ "example.ts": "export const x = 1;" });
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const result = runIn(root);
    assert.notEqual(
        result.status,
        0,
        `the check passed on an empty corpus:\n${result.output}`
    );
    assert.match(result.output, /no policy documents were found/);
    assert.doesNotMatch(result.output, /check passed/);
});
test("the command refuses a run that scanned no citations", (t) => {
    // The second guard, and it needs its own case: the test above never reaches
    // it, because a run with no policy documents exits at the first one. Here
    // the corpus resolves and the scan still reads nothing, which is what a
    // broken exclusion list or a pattern that stopped matching would look like.
    //
    // The seeded policy document has headings and no citations of its own, so
    // `policyDocuments.length` is 1 and `checked` is 0.
    const root = repoWith({
        "docs/policy/example.md": ["# Example", "", "## 1. Scope", "", "## 2. Limits", ""].join("\n"),
        "lib/example.ts": "export const x = 1;",
    });
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const result = runIn(root);
    assert.notEqual(
        result.status,
        0,
        `the check passed having scanned nothing:
${result.output}`
    );
    assert.match(result.output, /no citations were scanned/);
    // And it reached the second guard rather than the first, which is the
    // distinction this case exists to hold.
    assert.doesNotMatch(result.output, /no policy documents were found/);
});

test("the command passes on this repository, and says how much it read", () => {
    // The positive control. Without it the assertion above would hold just as
    // well against a script that refused everything, which is the other way to
    // make a gate useless.
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const result = runIn(repo);
    assert.equal(result.status, 0, result.output);
    const counts = result.output.match(
        /passed: (\d+) citation\(s\) against (\d+) policy document\(s\)/
    );
    assert.ok(counts, `the summary did not name its counts:\n${result.output}`);
    // Written as floors rather than exact numbers: the point is that the scan
    // reached the corpus, and an exact count would fail on every unrelated
    // policy edit.
    assert.ok(Number(counts[1]) > 100, `only ${counts[1]} citations scanned`);
    assert.ok(Number(counts[2]) > 10, `only ${counts[2]} policy documents found`);
});
