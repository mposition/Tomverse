import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * A failing audit chain has to be diagnosable from the screen that reports it.
 *
 * The panel named `firstInvalidId` and stopped there. Two staging rounds wrote
 * that down — 2026-08-21 recorded that the id could not be looked up anywhere
 * in the console, and 2026-08-25 found the identical id still unreachable — so
 * this is the second time the same wall was hit by the same operator.
 *
 * An id nobody can resolve is not a diagnosis. It says something is wrong and
 * refuses to say what, which is the same shape as the step-up refusal that
 * `tests/adminReauthenticationCta.test.mjs` exists to prevent: naming a remedy
 * without offering it.
 *
 * Two things fix it and both are asserted here. The row can be fetched, from
 * the endpoint that already existed and had never been linked to. And the
 * verdict says whether the failing row is the oldest one, which distinguishes
 * the two stories a broken chain can tell: entries before it verified and this
 * one did not, or nothing verified at all.
 *
 * The verifier no longer stops at that first failure — it counts every row —
 * but the first one is still what the panel leads with, because it is where a
 * reader starts.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), "utf8");

const panel = read("components/admin/AdminAuditIntegrityPanel.tsx");
const verifier = read("lib/adminAuditIntegrity.ts");

test("the panel can resolve the id it names", () => {
    assert.ok(
        panel.includes("firstInvalidId"),
        "the panel must still report which entry failed"
    );
    assert.match(
        panel,
        /fetch\(\s*`\/api\/admin\/audit\/\$\{/,
        "naming the failing entry without fetching it is the defect this file exists for"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-show-entry"'),
        "the fetch needs a control the operator can press"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-entry"'),
        "the fetched row needs somewhere to render"
    );
});

test("the endpoint the panel calls is the one that exists", () => {
    // A route that moved would leave the control pressing a 404, which reads
    // to the operator exactly like the unreachable id did.
    assert.ok(
        read("app/api/admin/audit/[auditId]/route.ts").includes(
            "export async function GET"
        ),
        "GET /api/admin/audit/{auditId} is what the panel depends on"
    );
});

test("the verdict says whether the failing entry is the oldest one", () => {
    assert.ok(
        verifier.includes("firstInvalidIsOldest"),
        "without this the reader cannot tell a changed key from an altered entry"
    );
    // Computed from the ordered rows the verifier already has, not from a
    // second query that could disagree with the one being walked.
    assert.match(
        verifier,
        /rows\[0\]\?\.id === firstInvalid\.id/,
        "the comparison must be against the first row of the same ordered read"
    );
    assert.match(
        verifier,
        /orderBy:\s*\[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/,
        "`rows[0]` only means `oldest` while the read is ordered ascending"
    );
});

test("the panel says something different for each reading", () => {
    // One sentence covering two readings puts the reader back where they
    // started, with the distinction computed and not communicated. That has
    // now happened three times: a sentence claiming *nothing has verified*
    // whatever the counts said, one calling a single failing row an unlisted
    // *span*, and one promising "every entry after it does" while eight later
    // entries did not.
    const reading = panel.slice(panel.indexOf("function auditIntegrityReading"));
    const body = reading.slice(0, reading.indexOf("\n}"));
    const sentences = [
        ...body.matchAll(/return [`"]([^`"]*)[`"];/g),
    ].map((match) => match[1]).filter((text) => text.length > 0);
    assert.ok(sentences.length >= 4, "at least four distinct readings");
    assert.equal(
        new Set(sentences).size,
        sentences.length,
        "two readings sharing a sentence is the defect this asserts against"
    );

    const nothingVerified = sentences.find((t) => t.includes("Nothing has verified"));
    const singleRow = sentences.find((t) => t.includes("Only the chain's first entry"));
    assert.ok(nothingVerified && singleRow);
    assert.ok(
        !singleRow.includes("ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS"),
        "telling the reader to add a key for a single row sends them after nothing"
    );
    for (const text of sentences) {
        if (text === nothingVerified) continue;
        assert.ok(
            !text.includes("Nothing has verified"),
            "a chain with entries verified must never be told nothing verified"
        );
    }
});

test("failures scattered among passes are never described as a key boundary", () => {
    // The defect this replaced: with the unverified prefix at one and eight
    // further failures past it, the panel said "every entry after it does".
    // A sentence about the whole chain cannot be chosen from one statistic
    // about part of it.
    const reading = panel.slice(panel.indexOf("function auditIntegrityReading"));
    const body = reading.slice(0, reading.indexOf("\n}"));
    assert.match(
        body,
        /invalidEntries - integrity\.unverifiedPrefix/,
        "the reading must know how many failures lie beyond the prefix"
    );
    const scattered = body.slice(body.indexOf("if (scattered > 0)"));
    const branch = scattered.slice(0, scattered.indexOf("\n  if ("));
    assert.ok(
        !branch.includes("ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS"),
        "no key change produces failures interleaved with passes"
    );
    assert.ok(
        branch.includes("rewritten"),
        "interleaved failures mean something rewrote the rows; say so"
    );
});

test("every failing entry is listed and diagnosable, not only the first", () => {
    // Reporting one was enough while one failed. When nine did -- eight of
    // them rows that had verified an hour earlier -- the only reachable one
    // was the oldest, which is the least informative: a row that was fine an
    // hour ago bounds the window it changed in.
    assert.ok(
        verifier.includes("unverifiedIds"),
        "the verifier must report the failing ids, not just the first"
    );
    assert.ok(
        verifier.includes("unverifiedIdsTruncated"),
        "a bounded list has to say what it left out"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-unverified-list"'),
        "the list needs somewhere to render"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-diagnose-one"'),
        "each listed entry needs its own diagnosis control"
    );
    assert.match(
        panel,
        /\[\.\.\.integrity\.unverifiedIds\]\.reverse\(\)/,
        "newest first: a recently broken row bounds the window, an old one does not"
    );
});

test("a deleted actor is reported as a mechanism, never as a match", () => {
    // `actorUserId` is in the hash and is also a foreign key nulled on delete,
    // so deleting a user rewrites every audit row that user wrote with no
    // application code involved. The id cannot be reconstructed -- a cuid is
    // not a value any candidate set can try -- so this must not be presented
    // as a reproduced digest.
    const diagnosis = read("lib/adminAuditEntryDiagnosis.ts");
    assert.match(
        diagnosis,
        /actorIdMissingWithEmail:\s*\n?\s*stored\.actorUserId === null && Boolean\(stored\.actorEmail\)/,
        "the fingerprint is a null id beside a surviving address"
    );
    assert.ok(
        !diagnosis.includes('label: "actorUserId: was a deleted user"'),
        "it is not a candidate: nothing can reproduce the digest without the id"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-actor-fingerprint"'),
        "the panel must report the mechanism"
    );
});

test("the readings are chosen by the size of the unverified prefix", () => {
    // `firstInvalidIsOldest` says where the first failure is. It says nothing
    // about how much of the chain opened, and reading it as though it did is
    // how the panel twice described a chain it had not measured.
    const reading = panel.slice(panel.indexOf("function auditIntegrityReading"));
    const body = reading.slice(0, reading.indexOf("\n}"));
    assert.ok(
        !body.includes("firstInvalidIsOldest"),
        "position alone cannot distinguish these readings"
    );
    assert.match(body, /unverifiedPrefix === 0/);
    assert.match(body, /unverifiedPrefix === 1/);
    assert.match(body, /verifiedEntries === 0/);
});

test("the prefix counts only leading entries, and stops at the first that opens", () => {
    // Counted from the same ordered walk rather than from the failure list:
    // failures include linkage breaks, and a linkage break on a row whose
    // content verified is not a key boundary.
    assert.match(
        verifier,
        /orderBy:\s*\[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/,
        "`prefix` only means `oldest first` while the read is ordered ascending"
    );
    assert.match(
        verifier,
        /stillInPrefix = false/,
        "the first entry that opens must end the prefix"
    );
    assert.match(
        verifier,
        /else if \(stillInPrefix\) \{\s*unverifiedPrefix \+= 1;/,
        "only entries no key opened may extend the prefix"
    );
});

test("the panel reports what each listed key opened, by position", () => {
    // `keysUsed` alone cannot say which listed key is doing nothing: two keys
    // used is the same number whether two or five were offered. Without the
    // per-key counts the only way to find a dead key is to redeploy with each
    // one alone.
    assert.ok(
        panel.includes("integrity.keyEntryCounts"),
        "the panel must render the per-key counts"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-key-counts"'),
        "the per-key counts need somewhere to render"
    );
    // Positions only. A key, or anything derived from one, must never reach a
    // response: the panel is how an operator diagnoses a chain, not a place to
    // learn what signs it.
    assert.ok(
        !verifier.includes("keys[keyIndex]") && !verifier.includes("keysUsedValues"),
        "no key value may leave the verifier"
    );
});

test("a new verification does not leave the previous failure's row on screen", () => {
    // The row is fetched for one verdict. Carrying it into the next would
    // caption a fresh result with an entry it says nothing about.
    const verify = panel.slice(panel.indexOf("const verify = async"));
    const body = verify.slice(0, verify.indexOf("const loadEntry"));
    assert.ok(
        body.includes("setEntry(null)"),
        "verifying again must clear the entry loaded for the previous verdict"
    );
});
