import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";

/**
 * The page scroll lock, and the stacking bug that made it necessary.
 *
 * Seven surfaces each kept their own `previousOverflow` save/restore. Read one
 * at a time they were all correct; read together they were not, because they
 * open on top of each other -- the mobile drawer opens the settings modal,
 * which opens the delete-account dialog -- and a per-surface save captures
 * whatever the surface underneath had already set.
 *
 * A user hit the end state of that in production: `body.style.overflow` stuck
 * at `hidden` with nothing open, on a settings screen whose save button sat
 * below the fold. Nothing else in the app writes that property, so it survived
 * until a reload.
 *
 * The two orderings below are the whole defect. They failed against the old
 * per-surface code and pass against the counter.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), "utf8");

/**
 * A `document` stand-in, installed as a global before the module under test is
 * imported -- it reads `document` at call time precisely so this works.
 */
const installDocument = () => {
    const body = { style: { overflow: "" } };
    globalThis.document = { body };
    return body.style;
};

const style = installDocument();
const { lockBodyScroll, bodyScrollLockHolders, __resetBodyScrollLockForTests } =
    await import("../components/useBodyScrollLock.ts");

const fresh = () => {
    __resetBodyScrollLockForTests();
    style.overflow = "";
};

test("a single lock locks and restores", () => {
    fresh();
    const release = lockBodyScroll();
    assert.equal(style.overflow, "hidden");
    release();
    assert.equal(style.overflow, "");
    assert.equal(bodyScrollLockHolders(), 0);
});

test("the outer surface releasing first does not unlock the page under the inner one", () => {
    // The drawer closing behind the settings modal it opened. Under the old
    // code this wrote the drawer's own "" back and the page scrolled behind an
    // open dialog.
    fresh();
    const releaseDrawer = lockBodyScroll();
    const releaseModal = lockBodyScroll();

    releaseDrawer();
    assert.equal(
        style.overflow,
        "hidden",
        "the page must stay locked while the modal above is still open"
    );

    releaseModal();
    assert.equal(style.overflow, "", "the last release restores the page");
});

test("the inner surface does not restore a lock it inherited", () => {
    // The reported end state: every surface closed, page still frozen, because
    // the inner one captured the outer one's `hidden` and wrote it back.
    fresh();
    const releaseA = lockBodyScroll();
    const releaseB = lockBodyScroll();
    const releaseC = lockBodyScroll();

    releaseA();
    releaseB();
    releaseC();

    assert.equal(
        style.overflow,
        "",
        "with nothing open the page must scroll again"
    );
    assert.equal(bodyScrollLockHolders(), 0);
});

test("a page that was already unscrollable stays that way", () => {
    // The captured value is the page's own, not an assumed "".
    fresh();
    style.overflow = "clip";
    const release = lockBodyScroll();
    assert.equal(style.overflow, "hidden");
    release();
    assert.equal(style.overflow, "clip");
});

test("releasing twice does not drop somebody else's lock", () => {
    // React can run an effect cleanup more than once for the same setup, and a
    // double release that decremented twice would unlock the page under a
    // dialog that is still open.
    fresh();
    const releaseFirst = lockBodyScroll();
    const releaseSecond = lockBodyScroll();

    releaseFirst();
    releaseFirst();
    assert.equal(style.overflow, "hidden");
    assert.equal(bodyScrollLockHolders(), 1);

    releaseSecond();
    assert.equal(style.overflow, "");
});

test("only the shared module writes body.style.overflow", () => {
    // The counter is defeated the moment one surface goes back to setting the
    // property itself, and the symptom of that is again invisible until
    // somebody cannot reach a button.
    const offenders = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory)) {
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const path = join(directory, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.tsx?$/.test(entry)) continue;
            const relative = path.slice(ROOT.length + 1);
            if (relative === "components/useBodyScrollLock.ts") continue;
            if (/document\.body\.style\.overflow\s*=/.test(readFileSync(path, "utf8"))) {
                offenders.push(relative);
            }
        }
    };
    for (const directory of ["components", "app", "lib"]) walk(resolve(ROOT, directory));
    assert.deepEqual(
        offenders,
        [],
        `these write the scroll lock directly instead of taking one: ${offenders.join(", ")}`
    );
});

test("every surface that locks the page takes it from the shared module", () => {
    // Sanity in the other direction: a scan that stopped finding the call
    // sites would let the assertion above pass over an empty tree.
    const holders = [
        "components/useModalDialog.ts",
        "components/chat/MobileChatShell.tsx",
        "components/chat/ChatInput.tsx",
        "components/chat/FeedbackButton.tsx",
        "components/chat/UsageLimitModal.tsx",
        "components/chat/GuestVerificationSheet.tsx",
        "components/billing/CreditPackPurchaseButton.tsx",
    ];
    for (const file of holders) {
        assert.match(
            read(file),
            /\b(lockBodyScroll|useBodyScrollLock)\b/,
            `${file} no longer takes the shared scroll lock`
        );
    }
});
