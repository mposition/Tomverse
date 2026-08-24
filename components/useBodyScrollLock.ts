"use client";

import { useEffect } from "react";

/**
 * One reference-counted lock on the page's scroll, shared by every surface
 * that needs it.
 *
 * Seven places each kept their own copy of the same four lines:
 *
 *     const previous = document.body.style.overflow;
 *     document.body.style.overflow = "hidden";
 *     return () => { document.body.style.overflow = previous; };
 *
 * Read alone that is correct. Read as a group it is not, because these
 * surfaces stack -- and this app's own code says so: the mobile drawer's
 * effect names "the account footer's settings modal, and the delete-account
 * dialog on top of that" as things that open above it. Two overlapping locks
 * break in both directions:
 *
 *   1. The inner one captures `"hidden"`, because the outer one had already
 *      set it. When the *outer* one releases first -- a drawer closing behind
 *      the dialog it opened, a modal unmounting on a route change -- it writes
 *      back its own `""` and the page scrolls behind a dialog that is still
 *      open.
 *   2. Then the inner one releases and writes back the `"hidden"` it captured.
 *      Nothing is open any more, and the page cannot scroll at all.
 *
 * State 2 is what a user reported from production: `body.style.overflow`
 * stuck at `hidden` with `scrollHeight` 1669 against a `clientHeight` of 1281,
 * on a settings screen whose save button was below the fold and therefore
 * unreachable. It survives until a full reload, because nothing else in the
 * app ever writes that property.
 *
 * Counting is the fix rather than better bookkeeping in each copy: the bug is
 * that each surface believes it is the only one, and no amount of care inside
 * one of them can know about the others. The value is captured once, when the
 * count goes from zero, and restored once, when it returns to zero. Release
 * order stops mattering, which is the point -- unmount order is decided by
 * React and by the router, not by the surfaces.
 *
 * `document` is read at call time so the module stays importable where there
 * is no DOM, and so `tests/bodyScrollLock.test.mjs` can drive it with a stub.
 */

/** How many surfaces currently want the page not to scroll. */
let holders = 0;

/** The page's own value, captured when the first holder arrived. */
let restoreTo = "";

/**
 * Takes a lock and returns its release. The release is idempotent: calling it
 * twice must not drop somebody else's lock, and a React effect cleanup can run
 * more than once for the same setup under StrictMode.
 */
export function lockBodyScroll(): () => void {
    if (typeof document === "undefined") return () => {};

    if (holders === 0) restoreTo = document.body.style.overflow;
    holders += 1;
    document.body.style.overflow = "hidden";

    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        // Defensive: a negative count would mean a release ran without its
        // lock, and letting it go negative would make the next real lock's
        // release a no-op.
        holders = 0;
        document.body.style.overflow = restoreTo;
    };
}

/** Holds the lock for as long as `active` is true. */
export function useBodyScrollLock(active: boolean) {
    useEffect(() => {
        if (!active) return;
        return lockBodyScroll();
    }, [active]);
}

/**
 * The current holder count. Exported for tests and for the assertion in
 * `useModalDialog`; nothing in the product should branch on it.
 */
export const bodyScrollLockHolders = () => holders;

/** Test seam: forget all locks. Never call this from product code. */
export const __resetBodyScrollLockForTests = () => {
    holders = 0;
    restoreTo = "";
};
