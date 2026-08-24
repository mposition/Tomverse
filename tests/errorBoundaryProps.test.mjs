import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * The error boundaries must name the props Next actually passes them.
 *
 * Next passed `unstable_retry` in v16.2.0 and renamed it to `retry` in
 * v16.3.0. All three of this app's boundaries kept the old name across the
 * upgrade, and nothing said so: an error component is `any`-typed at the
 * framework edge, so destructuring a prop the runtime does not pass is not a
 * build error, not a lint error and not a warning. It is `undefined`, and the
 * only symptom is `TypeError: retry is not a function` the moment somebody
 * presses the one button whose entire job is recovering from an error -- on
 * the screen with the least capacity to absorb another failure, and for
 * `global-error.tsx`, with nothing underneath left to catch it.
 *
 * So this reads the contract from the installed runtime rather than from a
 * list kept here. A list would be the thing that went stale, and its
 * staleness would again be invisible until a user pressed the button.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), "utf8");

/** Every `error.tsx`-family boundary in the app, and the prop each retries with. */
const BOUNDARIES = [
    "app/global-error.tsx",
    "app/(site)/(application)/chat/error.tsx",
    "app/(site)/(application)/admin/error.tsx",
];

/**
 * The props Next's own error boundary hands to `errorComponent`, read out of
 * the installed package. The runtime renders it as
 * `jsx(this.props.errorComponent, { error: ..., reset: ..., retry: ... })`, so
 * the keys of that object literal are the contract.
 */
const runtimeProps = () => {
    const source = read(
        "node_modules/next/dist/client/components/error-boundary.js"
    );
    const start = source.indexOf("this.props.errorComponent");
    assert.ok(
        start >= 0,
        "could not find the error component render in Next's error boundary; this test needs updating for the installed version"
    );
    const open = source.indexOf("{", start);
    const close = source.indexOf("})", open);
    assert.ok(open >= 0 && close > open, "could not read the props object");
    const block = source.slice(open, close);
    const names = new Set(
        Array.from(block.matchAll(/^\s*(?:\/\/.*\n\s*)?([a-zA-Z_$][\w$]*)\s*:/gm)).map(
            (match) => match[1]
        )
    );
    // Sanity: a regex that stopped matching would make every assertion below
    // pass by finding nothing, which is how scans fail silently.
    assert.ok(
        names.has("error"),
        `read no plausible prop set from the runtime: ${[...names].join(", ") || "(none)"}`
    );
    return names;
};

test("the installed Next still passes a retry prop under that name", () => {
    // If this fails, Next renamed it again. Update the boundaries first, then
    // this expectation -- in that order, because the boundaries are what a
    // user presses.
    assert.ok(
        runtimeProps().has("retry"),
        "Next no longer passes `retry`; the boundaries' retry button is now dead"
    );
});

test("no boundary destructures a prop Next does not pass", () => {
    const passed = runtimeProps();
    for (const file of BOUNDARIES) {
        const source = read(file);
        const signature = source.match(
            /export default function \w+\(\{([\s\S]*?)\}:/
        );
        assert.ok(signature, `${file} has no destructured props signature`);
        const destructured = signature[1]
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => part.split(/[:=]/)[0].trim())
            .filter((name) => /^[a-zA-Z_$][\w$]*$/.test(name));
        assert.ok(
            destructured.length > 0,
            `${file}: read no prop names out of the signature`
        );
        for (const name of destructured) {
            assert.ok(
                passed.has(name),
                `${file} reads \`${name}\`, which Next does not pass (it passes ${[...passed].join(", ")}). It will be undefined at runtime.`
            );
        }
    }
});

test("every boundary wires its retry control to the prop it declared", () => {
    // A boundary that declares `retry` and then calls something else is the
    // same defect wearing the fixed name.
    for (const file of BOUNDARIES) {
        const source = read(file);
        assert.match(
            source,
            /onClick=\{\(\) => retry\(\)\}/,
            `${file} has no retry button wired to the \`retry\` prop`
        );
    }
});

test("no boundary tells the reader to quote a reference it does not have", () => {
    // `error.digest` only exists for a server-side throw. All three boundaries
    // used to substitute a placeholder for the missing one -- inside the
    // sentence "quote reference ... when you contact support", so the reader
    // was being asked to repeat the placeholder to support. The absent digest
    // has to change the sentence, not fill a hole in it.
    for (const file of BOUNDARIES) {
        assert.doesNotMatch(
            read(file),
            /error\.digest\s*(\|\||\?\?)/,
            `${file} still substitutes a placeholder for a missing digest instead of changing the sentence`
        );
    }
});
