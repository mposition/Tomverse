import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    RUN_INSTANT_UNAVAILABLE,
    readRunInstant,
    runInstantIso,
    runInstantLine,
} from "../scripts/report-run-instant.mjs";

const REPORTS = [
    "scripts/report-credit-lot-invariants.mjs",
    "scripts/report-assistant-knowledge-invariants.mjs",
];

// The statement lives at each call site rather than in the shared module, so
// that no report has to reach for the raw helper whose name says unsafe. This
// is the one copy both reports are compared against.
const RUN_INSTANT_SQL = "SELECT now() AS at";

test("a read instant is reported as an exact ISO 8601 UTC instant", () => {
    const at = new Date("2026-10-09T10:51:58.000Z");

    assert.equal(runInstantIso(at), "2026-10-09T10:51:58.000Z");
    assert.match(runInstantLine(at), /^Read at: 2026-10-09T10:51:58\.000Z\b/);
});

test("the line names whose clock it is, because the record had to guess once", () => {
    const line = runInstantLine(new Date("2026-10-09T10:51:58.000Z"));

    // "Read at: <time>" alone leaves the next reader to decide whether the
    // instant came from the database or from the operator's workstation, and
    // that is the ambiguity this module exists to remove.
    assert.match(line, /database's clock/);
    assert.match(line, /not this machine's/);
});

test("an unreadable instant is stated, never replaced by this machine's clock", async () => {
    for (const broken of [
        undefined,
        null,
        "2026-10-09T10:51:58.000Z",
        new Date("not a date"),
    ]) {
        assert.equal(runInstantIso(broken), null, `${String(broken)} is not an instant`);

        const line = runInstantLine(broken);
        assert.match(line, new RegExp(RUN_INSTANT_UNAVAILABLE));
        // The failure must not be dressed up as a reading: no ISO instant
        // anywhere in the sentence, so nothing can be copied into a record.
        assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}T/);
    }

    // A failed read is null, not the moment the read failed. Falling back to
    // the local clock is the substitution the 2026-10-09 release record
    // refused when it left the run time uncollected.
    const rejected = await readRunInstant(async () => {
        throw new Error("connection reset");
    });
    assert.equal(rejected, null);
    assert.equal(runInstantIso(rejected), null);

    for (const shape of [[], [{}], [{ at: null }], "not rows", undefined]) {
        assert.equal(
            await readRunInstant(async () => shape),
            null,
            `${JSON.stringify(shape) ?? "undefined"} is not a row carrying an instant`
        );
    }
});

test("the read runs the caller's query once and passes its row through", async () => {
    let calls = 0;
    const at = new Date("2026-10-09T10:51:58.000Z");

    const got = await readRunInstant(async () => {
        calls += 1;
        return [{ at }];
    });

    assert.equal(got, at);
    assert.equal(calls, 1);
});

test("both reports issue the same read-only statement, as a tagged template", () => {
    for (const path of REPORTS) {
        const source = readFileSync(path, "utf8");

        // A tagged template, not a string argument: `$queryRawUnsafe` would
        // need a reviewed exception in check-protected-table-writers-core.mjs,
        // and carrying one for a timestamp is not a trade worth making.
        assert.ok(
            source.includes("prisma.$queryRaw`" + RUN_INSTANT_SQL + "`"),
            `${path} reads the clock with a tagged template of exactly that statement`
        );
        assert.doesNotMatch(
            source,
            /\$queryRawUnsafe/,
            `${path} does not reach for the unsafe raw helper`
        );
    }
});

test("both invariant reports print the instant and carry it in --json", () => {
    for (const path of REPORTS) {
        const source = readFileSync(path, "utf8");

        // Pinned to the identifiers rather than to the surrounding prose: a
        // report that stops calling these has stopped reporting its instant,
        // whatever its comments say.
        assert.match(
            source,
            /from "\.\/report-run-instant\.mjs"/,
            `${path} imports the shared module`
        );
        assert.match(source, /readRunInstant\(/, `${path} reads the instant`);
        assert.match(source, /runInstantLine\(/, `${path} prints the instant`);
        assert.match(
            source,
            /readAt: runInstantIso\(/,
            `${path} puts the instant in its JSON report`
        );

        // The instant is read before the survey, so a printed instant can
        // never be later than the rows it describes.
        assert.ok(
            source.indexOf("readRunInstant(") < source.indexOf("const constraintState = await prisma.$queryRaw"),
            `${path} reads the instant before its first survey query`
        );
    }
});
