import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
    bodyOf,
    frontMatter,
    normalizeLineEndings,
    recordDigest,
} from "../scripts/check-staging-verification-records-core.mjs";

/**
 * The check only ever worked on an LF checkout.
 *
 * Found on a Windows machine, running the check on a repository git had
 * checked out with `core.autocrlf`. Every record reported as a blank page:
 *
 *   _record-template.md  declares templateRevision (none) ...
 *   2026-08-04__8c43430...md  names 8c43430... in its filename and nothing in
 *                             its front matter.
 *   2026-08-04__8c43430...md  has no executor.
 *   2026-08-04__8c43430...md  has no result.
 *
 * None of that was true of the files. `.` does not match `\r` and `$` does not
 * sit before one, so the front-matter regex matched no line at all and every
 * field came back missing. CI is Linux and so is every agent container, so the
 * one platform this failed on was the one most likely to be writing the
 * records, and the failure told the operator their finished record was empty.
 */

const RECORD = "docs/ops/staging-verification-records/2026-08-04__8c43430b9febd905351e63de4af8b5bbc157f31a.md";

const asCrlf = (text) => normalizeLineEndings(text).replace(/\n/g, "\r\n");

test("front matter parses the same however git checked the file out", () => {
    const lf = normalizeLineEndings(readFileSync(RECORD, "utf8"));
    const crlf = asCrlf(lf);
    assert.notEqual(lf, crlf, "the fixture must actually differ, or this proves nothing");

    const fromLf = frontMatter(lf);
    const fromCrlf = frontMatter(crlf);

    assert.ok(fromLf.size > 0, "the fixture record has front matter to read");
    assert.deepEqual([...fromCrlf.entries()], [...fromLf.entries()]);

    // Named individually, because these four are what the failure reported as
    // missing and what the check refuses a record for.
    for (const field of ["deploySha", "templateRevision", "executor", "result"]) {
        assert.equal(fromCrlf.get(field), fromLf.get(field), field);
        assert.ok(fromCrlf.get(field), `${field} must be readable, not empty`);
    }
});

test("a frozen record hashes to the same digest on either checkout", () => {
    // The one that would have been worst. The digest is the tamper evidence:
    // it says "this finished record was edited". Computed over un-normalised
    // bytes it also says that about a record nobody touched, on any machine
    // whose checkout differs from the one that froze it -- so `git clone` alone
    // could make a signed record look altered.
    const lf = normalizeLineEndings(readFileSync(RECORD, "utf8"));
    assert.equal(recordDigest(asCrlf(lf)), recordDigest(lf));

    // And it still matches what the record itself was signed as, so this
    // normalisation did not quietly invalidate the one frozen record on disk.
    const declared = frontMatter(lf).get("digest");
    if (frontMatter(lf).get("frozen") === "true") {
        assert.equal(recordDigest(lf), declared);
    }
});

test("the body a digest covers starts after the front matter, not inside it", () => {
    // `bodyOf` sliced a fixed four characters past the closing `---`, which is
    // `---\n` on LF and one short of `---\r\n`. Normalising first is what makes
    // that arithmetic true again rather than accidentally right on one
    // platform.
    const lf = normalizeLineEndings(readFileSync(RECORD, "utf8"));
    const body = bodyOf(lf);
    assert.ok(!body.includes("deploySha:"), "front matter leaked into the body");
    assert.ok(body.trimStart().startsWith("#"), "the body should begin at the heading");
    assert.equal(bodyOf(asCrlf(lf)), body);
});

test("normalisation is idempotent and leaves an LF document untouched", () => {
    const lf = "a\nb\nc\n";
    assert.equal(normalizeLineEndings(lf), lf);
    assert.equal(normalizeLineEndings(normalizeLineEndings("a\r\nb\rc\n")), "a\nb\nc\n");
    // A lone CR is a line ending too -- classic Mac line endings still turn up
    // in files that have been through the wrong editor.
    assert.equal(normalizeLineEndings("a\rb"), "a\nb");
});
