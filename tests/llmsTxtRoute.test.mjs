import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MARKETING_SUPERLATIVE_WORDS } from "../lib/marketingBannedClaims.ts";
import { SITE_ORIGIN, reviewSeoCopy } from "../lib/seo.ts";
import * as sitemapModule from "../app/sitemap.ts";
import * as routeModule from "../app/llms.txt/route.ts";

// tsx hands a .ts default export to an .mjs importer either as the function
// or wrapped once more under `default`.
const sitemap =
    typeof sitemapModule.default === "function"
        ? sitemapModule.default
        : sitemapModule.default.default;
const route = routeModule.GET ? routeModule : routeModule.default;

/**
 * Policy test for /llms.txt (marketing policy 9.2). It is owned by a person and
 * is not in the SEO code agent's allowed file list, so the agent is judged by it
 * and cannot loosen it.
 */

const withEnv = async (value, run) => {
    const before = process.env.LLMS_TXT_ENABLED;
    if (value === undefined) delete process.env.LLMS_TXT_ENABLED;
    else process.env.LLMS_TXT_ENABLED = value;
    try {
        return await run();
    } finally {
        if (before === undefined) delete process.env.LLMS_TXT_ENABLED;
        else process.env.LLMS_TXT_ENABLED = before;
    }
};

const enabledBody = async () => withEnv("true", async () => route.GET().text());

test("llms.txt answers 404 unless the variable is exactly true", async () => {
    for (const value of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
        const response = await withEnv(value, () => route.GET());
        assert.equal(response.status, 404, `LLMS_TXT_ENABLED=${JSON.stringify(value)}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(await response.text(), "Not found");
    }
});

test("llms.txt is served as plain text while enabled", async () => {
    const response = await withEnv("true", () => route.GET());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const body = await response.text();
    assert.ok(body.startsWith("# Tomverse\n"));
    assert.ok(body.endsWith("\n"));
});

test("the route module exports only what a route file may", () => {
    const names = Object.keys(routeModule).filter((name) => name !== "default");
    assert.deepEqual(names.sort(), ["GET", "dynamic"]);
    assert.equal(routeModule.dynamic, "force-dynamic");
});

test("every link is a public page the sitemap lists", async () => {
    const body = await enabledBody();
    const links = [...body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
    assert.ok(links.length >= 5);
    const listed = new Set(sitemap().map((entry) => entry.url));
    for (const link of links) {
        assert.ok(link.startsWith(`${SITE_ORIGIN}/`), `${link} is on the site origin`);
        assert.ok(listed.has(link), `${link} is in the sitemap`);
    }
    assert.equal(new Set(links).size, links.length, "no link is listed twice");
});

test("the only factual sentences are copied from public page copy", async () => {
    const body = await enabledBody();
    assert.ok(body.includes(`> ${reviewSeoCopy.en.description}`));
    const prose = body
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith(">"));
    assert.deepEqual(prose, ["Tomverse is where GPT, Claude and Gemini are used in one place."]);
});

test("it carries no price, limit, date or comparative claim", async () => {
    const body = (await enabledBody()).toLowerCase();
    assert.doesNotMatch(body, /[$€£]|\bfree\b|\bonly\b|\bguarantee/);
    // The one allowed digit run is the model count in the public description.
    assert.doesNotMatch(body.replace(/\bup to three\b/g, ""), /\d/);
    for (const word of MARKETING_SUPERLATIVE_WORDS) {
        if (/^[a-z][a-z' -]*$/.test(word)) {
            assert.doesNotMatch(body, new RegExp(`\\b${word}\\b`), `superlative: ${word}`);
        }
    }
});

test("nothing outside the route file serves or lists llms.txt by default", () => {
    const robots = readFileSync(new URL("../app/robots.ts", import.meta.url), "utf8");
    assert.doesNotMatch(robots, /llms\.txt/);
    const sitemapSource = readFileSync(new URL("../app/sitemap.ts", import.meta.url), "utf8");
    assert.doesNotMatch(sitemapSource, /llms\.txt/);
});
