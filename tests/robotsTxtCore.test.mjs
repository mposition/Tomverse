import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationServedBody,
  carriesManagedBlock,
  isPathAllowed,
  parseRobotsTxt,
  rulesForUserAgent,
} from "../lib/robotsTxtCore.ts";

/**
 * The body staging actually served on 2026-08-25, trimmed to the parts that
 * decide access. Cloudflare's managed `robots.txt` setting prepended its own
 * group; ours is the one at the bottom.
 */
const STAGING_BEHIND_CLOUDFLARE = `# BEGIN Cloudflare Managed content

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: GPTBot
Disallow: /

# END Cloudflare Managed Content

User-Agent: *
Disallow: /
`;

const STAGING_ALONE = `User-Agent: *
Disallow: /
`;

/**
 * The bug, stated as a passing test.
 *
 * Both `Allow: /` and `Disallow: /` are in the file, so any check that looked
 * for the string `Disallow: /` reported staging as protected. RFC 9309 merges
 * the two `*` groups, the two rules are equally specific, and Google resolves
 * that tie towards `Allow` -- so Googlebot read this as "crawl everything".
 * This is why the Cloudflare zone setting has to stay off, and why the
 * verification in scripts/check-edge-robots.mjs runs against the edge.
 */
test("a prepended Allow group defeats our Disallow, which is the staging bug", () => {
  assert.equal(isPathAllowed(STAGING_BEHIND_CLOUDFLARE, "Googlebot", "/"), true);
});

test("staging's own body, alone, refuses everything", () => {
  assert.equal(isPathAllowed(STAGING_ALONE, "Googlebot", "/"), false);
  assert.equal(isPathAllowed(STAGING_ALONE, "Googlebot", "/safety"), false);
  // The crawler that was found indexing staging is not special-cased anywhere.
  assert.equal(isPathAllowed(STAGING_ALONE, "SomeCrawlerWeHaveNeverHeardOf", "/"), false);
});

/**
 * RFC 9309 §2.2.1: a group naming the crawler wins outright, and `*` is not
 * consulted at all. Without this, every named refusal below would be merged
 * with the `*` group's `Allow: /` and lose the tie.
 */
test("a group naming the crawler replaces the * group rather than adding to it", () => {
  const body = `User-Agent: *
Allow: /

User-Agent: GPTBot
Disallow: /
`;
  assert.equal(isPathAllowed(body, "GPTBot", "/"), false);
  assert.equal(isPathAllowed(body, "Googlebot", "/"), true);
});

test("the product token is matched without regard to case", () => {
  const body = `User-Agent: GPTBot
Disallow: /
`;
  assert.equal(isPathAllowed(body, "gptbot", "/"), false);
});

test("consecutive user-agent lines are one group; a later one starts another", () => {
  const groups = parseRobotsTxt(`User-Agent: A
User-Agent: B
Disallow: /x

User-Agent: C
Disallow: /y
`);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].userAgents, ["a", "b"]);
  assert.deepEqual(rulesForUserAgent(groups, "B"), [{ kind: "disallow", path: "/x" }]);
});

test("the longer path pattern wins, whichever way it points", () => {
  const body = `User-Agent: *
Disallow: /
Allow: /public
`;
  assert.equal(isPathAllowed(body, "Googlebot", "/private"), false);
  assert.equal(isPathAllowed(body, "Googlebot", "/public/page"), true);
});

test("$ anchors the end of the path and * spans anything", () => {
  const body = `User-Agent: *
Allow: /
Disallow: /chat$
Disallow: /chat/
Disallow: /*.pdf$
`;
  assert.equal(isPathAllowed(body, "Googlebot", "/chat"), false);
  assert.equal(isPathAllowed(body, "Googlebot", "/chat/abc"), false);
  // `/chat$` must not swallow this one, which is a different page entirely.
  assert.equal(isPathAllowed(body, "Googlebot", "/chatter"), true);
  assert.equal(isPathAllowed(body, "Googlebot", "/files/report.pdf"), false);
  assert.equal(isPathAllowed(body, "Googlebot", "/files/report.pdf.html"), true);
});

/** An empty `Disallow:` is the documented way to forbid nothing. */
test("an empty Disallow forbids nothing", () => {
  assert.equal(isPathAllowed("User-Agent: *\nDisallow:\n", "Googlebot", "/"), true);
});

test("comments and non-rule fields do not change what is allowed", () => {
  const body = `# a comment
User-Agent: *
Content-Signal: search=yes, ai-train=no
Disallow: / # trailing comment

Sitemap: https://tomverse.app/sitemap.xml
Host: https://tomverse.app
`;
  assert.equal(isPathAllowed(body, "Googlebot", "/"), false);
});

test("a path no rule matches is allowed", () => {
  assert.equal(isPathAllowed("User-Agent: *\nDisallow: /admin\n", "Googlebot", "/"), true);
});

/**
 * Telling the two authors of a served file apart.
 *
 * The production edge check passed on 2026-08-25 while `app/robots.ts` named
 * no AI crawler at all: Cloudflare's half was refusing them, the merged file
 * read correctly, and the check could not see the difference. That made the
 * check useless for the one decision it existed to support -- whether it is
 * safe to turn the managed block off.
 */
test("our half of a served file can be read on its own", () => {
  const served = `# BEGIN Cloudflare Managed content

User-agent: GPTBot
Disallow: /

# END Cloudflare Managed Content

User-Agent: *
Allow: /
`;
  assert.equal(carriesManagedBlock(served), true);
  const own = applicationServedBody(served);
  // Cloudflare refuses it; we do not. Both facts are true, and only the second
  // one decides whether their block can go.
  assert.equal(isPathAllowed(served, "GPTBot", "/"), false);
  assert.equal(isPathAllowed(own, "GPTBot", "/"), true);
});

test("a file with no managed block is entirely ours", () => {
  const served = "User-Agent: *\nDisallow: /\n";
  assert.equal(carriesManagedBlock(served), false);
  assert.equal(applicationServedBody(served), served);
});
