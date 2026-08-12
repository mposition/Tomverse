// Every module that moves purchased credits holds the account lock
// (docs/policy/credit-and-cost-limits.md §9).
//
// `reserveAddOnCredits()` decides sufficiency from a read of the account's
// lots and then decrements them. The decrement is atomic per row; the
// decision is not, `CreditLot.remainingCredits` has no CHECK constraint, and
// nothing inspects the post-update value. So two callers that read the same
// balance both pass and the balance goes negative -- the account spends
// credits it never bought.
//
// What actually prevents that is `lockCreditAccount(tx, userId)`, an advisory
// lock on `credit-account:<userId>` that serialises the account. Chat and
// image generation have always held it. Memory extraction, added later as a
// third caller of the same primitive from its own orchestration, did not --
// which is the reason this test exists rather than a comment.
//
// A source scan rather than a runtime check on purpose: the next caller is
// the one at risk, and it has not been written yet. The behavioural half is
// in tests/integration/memory-extraction-credits.db.test.ts and
// tests/integration/credit-finance.db.test.ts, which prove the lock is really
// taken and really serialises; this proves nobody added a fourth caller
// without one.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const libDir = join(root, "lib");

/** Where the primitives live; it defines them rather than calling them. */
const DEFINING_MODULE = "creditLedger.ts";

/** Mutators of purchased-credit lots. Calling one is what creates the duty. */
const LOT_MUTATORS = ["reserveAddOnCredits", "settleAddOnCredits"];

const ACCOUNT_LOCK = "lockCreditAccount";

const libSources = readdirSync(libDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, source: readFileSync(join(libDir, name), "utf8") }));

/** A call, not an import or a mention in a comment. */
const calls = (source, symbol) =>
    new RegExp(`(?<![\\w.])${symbol}\\s*\\(`).test(source);

const mutators = libSources.filter(
    ({ name, source }) =>
        name !== DEFINING_MODULE &&
        LOT_MUTATORS.some((symbol) => calls(source, symbol))
);

test("the scan finds the callers it is meant to guard", () => {
    // Guards the guard: a rename that made the regex match nothing would leave
    // this file passing while checking no module at all.
    const names = mutators.map((entry) => entry.name).sort();
    assert.ok(
        names.length >= 3,
        `expected at least the three known credit paths, found ${JSON.stringify(names)}`
    );
    for (const expected of [
        "chatSecurity.ts",
        "imageGenerationService.ts",
        "memoryExtractionCredits.ts",
    ]) {
        assert.ok(
            names.includes(expected),
            `${expected} no longer looks like a credit path to this scan`
        );
    }
});

/** Modules importing `@/lib/<basename>`; one of them owns the transaction. */
const importersOf = (name) => {
    const specifier = `@/lib/${name.replace(/\.ts$/, "")}`;
    return libSources.filter(
        (entry) =>
            entry.name !== name &&
            new RegExp(`from\\s+["']${specifier}["']`).test(entry.source)
    );
};

test("every module that moves credit lots also locks the account", () => {
    const offenders = [];
    for (const entry of mutators) {
        // The lock may be taken by the module itself or by the service that
        // opens the transaction it runs inside -- `memoryExtractionCredits`
        // receives a `tx` and never opens one of its own. Both count.
        const locked = [entry, ...importersOf(entry.name)].some((candidate) =>
            calls(candidate.source, ACCOUNT_LOCK)
        );
        if (!locked) offenders.push(entry.name);
    }
    assert.deepEqual(
        offenders,
        [],
        "these modules reserve or settle purchased credits with no " +
            `${ACCOUNT_LOCK}() in themselves or in any module that imports ` +
            `them: ${offenders.join(", ")}. See credit-and-cost-limits.md §9.`
    );
});

test("the extraction path locks the account before its own run lock", () => {
    // Order, not merely presence. Chat takes the credit account first and then
    // its own advisory lock; a second path that inverted the pair would
    // deadlock against it. Extraction is the path that takes both.
    const source = readFileSync(
        join(libDir, "memoryExtractionService.ts"),
        "utf8"
    );
    const creditLock = source.indexOf("acquireCreditAccountLock(tx");
    const runLock = source.indexOf("acquireUserRunLock(tx");
    assert.ok(creditLock >= 0, "the extraction path no longer locks the account");
    assert.ok(runLock >= 0, "the extraction run lock is gone");
    assert.ok(
        creditLock < runLock,
        "acquireUserRunLock() is taken before acquireCreditAccountLock(), " +
            "which inverts chat's order (credit-and-cost-limits.md §9)"
    );
});
