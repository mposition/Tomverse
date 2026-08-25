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
    // One sentence for both would put the reader back where they started, with
    // the distinction computed and not communicated.
    const branch = panel.match(
        /firstInvalidIsOldest\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/
    );
    assert.ok(branch, "the panel must render both readings");
    const [, oldest, midChain] = branch;
    assert.notEqual(oldest, midChain);
    assert.ok(
        oldest.includes("signing key"),
        "the oldest-entry reading is the changed-key one and should say so"
    );
    assert.ok(
        oldest.includes("admin-audit-key-epochs"),
        "point at where the key changes are actually recorded"
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
