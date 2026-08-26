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

test("the panel says something different for each of the four readings", () => {
    // One sentence covering two of them puts the reader back where they
    // started, with the distinction computed and not communicated. That has
    // happened twice: first a sentence claiming *nothing has verified*
    // whatever the counts said, then one calling a single failing row an
    // unlisted *span*. Both sent the reader after a key that was not missing.
    const reading = panel.slice(panel.indexOf("function auditIntegrityReading"));
    const body = reading.slice(0, reading.indexOf("\n}"));
    const sentences = [
        ...body.matchAll(/return [`"]([^`"]+)[`"];/g),
    ].map((match) => match[1]);
    assert.equal(sentences.length, 4, "four readings, four sentences");
    assert.equal(
        new Set(sentences).size,
        4,
        "two readings sharing a sentence is the defect this asserts against"
    );

    const [noPrefix, nothingVerified, singleRow, longerSpan] = sentences;
    assert.ok(
        noPrefix.includes("does not explain this on its own"),
        "a chain whose head verified is not a key story"
    );
    assert.ok(
        nothingVerified.includes("Nothing has verified"),
        "the nothing-verified reading is the whole-key-absent one"
    );
    for (const sentence of [noPrefix, singleRow, longerSpan]) {
        assert.ok(
            !sentence.includes("Nothing has verified"),
            "a chain with entries verified must never be told nothing verified"
        );
    }
    assert.ok(
        singleRow.includes("contiguous span"),
        "the single-row reading has to say why one row is not a key boundary"
    );
    assert.ok(
        !singleRow.includes("ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS"),
        "telling the reader to add a key for a single row sends them after nothing"
    );
    for (const sentence of [nothingVerified, longerSpan]) {
        assert.ok(
            sentence.includes("ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS") &&
                sentence.includes("admin-audit-key-epochs"),
            "a key reading names the remedy and where the epochs are recorded"
        );
    }
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
