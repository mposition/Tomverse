import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";
import { zhHant } from "../locales/zhHant.ts";

/**
 * Every application workspace that can throw has to land the reader somewhere
 * they can read, retry from, and reach support from.
 *
 * Only `/chat` did. `/review` and `/plugins` render the same navigation rail
 * and had no `error.tsx`, so a throw there fell through to Next's built-in
 * boundary: "Application error: a client-side exception has occurred", in
 * English, with no retry control and no link out. A dead `<Link>` in that rail
 * is one way to get there -- a client-side navigation to a path with no page
 * of its own answers the RSC request with the 404 document, and Next raises
 * "Expected RSC response, got text/html" (tests/singleSegmentLinkTargets.test.mjs).
 *
 * So this holds two things: the three workspaces have a boundary, and the copy
 * each boundary asks for exists in every locale rather than falling back to
 * English on the screen least able to absorb it.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), "utf8");

/**
 * The workspaces that render `ReviewNavigation` (the rail with the help link),
 * and therefore share its failure mode.
 */
const WORKSPACE_SEGMENTS = ["chat", "review", "plugins"];
const boundaryPath = (segment) => `app/(site)/(application)/${segment}/error.tsx`;

const SCREEN = "components/WorkspaceErrorScreen.tsx";

const dictionaries = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt };

const lookup = (dictionary, key) =>
    key.split(".").reduce((value, part) => (value == null ? value : value[part]), dictionary);

test("every rail workspace has an error boundary rendering the shared screen", () => {
    for (const segment of WORKSPACE_SEGMENTS) {
        const file = boundaryPath(segment);
        assert.ok(existsSync(resolve(ROOT, file)), `${segment} has no error boundary at ${file}`);
        assert.match(
            read(file),
            /<WorkspaceErrorScreen\b/,
            `${file} does not render WorkspaceErrorScreen, so its copy and retry are unchecked`
        );
    }
});

test("the shared screen offers a retry and a support route", () => {
    const source = read(SCREEN);
    assert.match(source, /data-testid=\{retryTestId\}/, "the screen has no identified retry control");
    assert.match(source, /href="\/support"/, "the screen offers no way through to support");
});

test("the shared screen takes all of its copy from t()", () => {
    // Literal copy here would render English under `lang="ko"`, which is the
    // thing this screen exists to stop.
    const source = read(SCREEN);
    for (const match of source.matchAll(/\{(["'])((?:(?!\1).)*)\1\}/g)) {
        // `{" "}` is JSX's way of writing a space, not copy.
        if (match[2].trim() === "") continue;
        assert.fail(`${SCREEN} renders the literal string ${match[0]} instead of a t() key`);
    }
    assert.match(source, /\{t\(titleKey\)\}/, "the screen does not render its title key");
    assert.match(source, /\{t\(bodyKey\)\}/, "the screen does not render its body key");
});

test("every copy key a boundary asks for exists in every locale", () => {
    const keys = new Set(["chat.workspaceError.reference", "chat.workspaceError.noReference", "chat.workspaceError.retry", "chat.workspaceError.support"]);
    for (const segment of WORKSPACE_SEGMENTS) {
        const source = read(boundaryPath(segment));
        for (const match of source.matchAll(/(?:titleKey|bodyKey)="([^"]+)"/g)) keys.add(match[1]);
    }
    // Four shared keys plus a title and a body for each workspace, deduplicated.
    assert.ok(keys.size >= 6, `read no plausible key set: ${[...keys].join(", ") || "(none)"}`);
    for (const [language, dictionary] of Object.entries(dictionaries)) {
        for (const key of keys) {
            assert.equal(
                typeof lookup(dictionary, key),
                "string",
                `${language} has no string for ${key}`
            );
        }
    }
});
