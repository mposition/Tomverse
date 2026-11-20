import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { koreanWordWrapClass } from "../components/imports/importFormatting.ts";

// On a 320px screen the import settings copy split Korean words mid-word.
// Korean must wrap by eojeol (keep-all) while long tokens still break.
test("korean word wrap class keeps Korean words whole but still wraps long tokens", () => {
    const classes = koreanWordWrapClass.split(/\s+/);
    assert.ok(classes.includes("[&:lang(ko)]:break-keep"));
    assert.ok(classes.includes("break-words"));
    // keep-all must stay scoped to Korean so other locales wrap normally.
    assert.ok(!classes.includes("break-keep"));
});

test("both external import management screen roots apply the Korean word wrap", () => {
    const source = readFileSync(
        new URL("../components/imports/ExternalImportManagement.tsx", import.meta.url),
        "utf8"
    );
    const roots = source.match(/<div className=\{`mx-auto w-full max-w-3xl[^`]*`\}/g) ?? [];
    assert.equal(roots.length, 2);
    for (const root of roots) assert.match(root, /\$\{koreanWordWrapClass\}/);
});
