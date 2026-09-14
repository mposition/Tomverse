// A step-up refusal has to offer the way back -- and a panel that can receive
// one has to notice it in the first place.
//
// docs/ui-contracts/admin-console-ia.md rule 7.
//
// The bug this exists to stop has happened three times, and it looks the same
// each time: an admin control refuses with "sign in again", says so in a toast,
// and stops there. The operator is told the remedy and given no way to reach
// it -- the screen reads as broken rather than gated, and the only exit anyone
// finds is guessing a URL.
//
// ## The hole this file used to have
//
// The original test asked one question: does a panel that *handles* a step-up
// refusal render `adminRecentAuthenticationHref`? A panel that never looked at
// the status passed for free, because it carried none of the markers the sweep
// searched for. On 2026-09-14 four panels calling routes that answer 428 were
// in exactly that state -- and they were invisible to the test written to
// prevent it, which is a worse position than having no test.
//
// So the question is now asked from the server end. Which routes can answer
// 409 or 428 is a fact about the route files (`adminApprovalErrorResponse` is
// the only thing that produces either), and which panels can reach those routes
// is a fact about the paths they name. The panels in that intersection must
// handle the answer.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL_DIR = fileURLToPath(new URL("../components/admin/", import.meta.url));
const ROUTE_DIR = fileURLToPath(new URL("../app/api/admin/", import.meta.url));

const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const routeFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === "route.ts") found.push(full);
  }
  return found;
};

/**
 * The URL prefix a panel would have to name to reach a route.
 *
 * `app/api/admin/users/[userId]/security/route.ts` becomes
 * `/api/admin/users/`: everything up to the first dynamic segment, which is
 * where a panel's source stops being a literal and starts being a template.
 * Deliberately broad -- it over-matches a sibling path under the same prefix,
 * and over-requiring a panel to handle an answer it cannot receive is the safe
 * direction to be wrong in.
 */
const reachPrefix = (path) => {
  const segments = path
    .slice(ROUTE_DIR.length)
    .replace(/\/route\.ts$/, "")
    .split("/");
  const literal = [];
  for (const segment of segments) {
    if (segment.startsWith("[")) break;
    literal.push(segment);
  }
  const stoppedEarly = literal.length < segments.length;
  return `/api/admin/${literal.join("/")}${stoppedEarly ? "/" : ""}`;
};

/** Routes that can answer 409 (approval queued) or 428 (step-up required). */
const refusingPrefixes = [
  ...new Set(
    routeFiles(ROUTE_DIR)
      .filter((path) =>
        withoutComments(readFileSync(path, "utf8")).includes(
          "adminApprovalErrorResponse"
        )
      )
      .map(reachPrefix)
  ),
];

const panels = readdirSync(PANEL_DIR)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => ({
    name,
    source: withoutComments(readFileSync(`${PANEL_DIR}${name}`, "utf8")),
  }));

/** How a component learns it was refused for one of those two reasons. */
const HANDLES_REFUSAL = [
  "readAdminApiFailure",
  "describeAdminApiFailure",
  "requiresReauthentication",
  "ADMIN_REAUTHENTICATION_REQUIRED",
];

/** What produces a URL back into the step-up flow, directly or through the notice. */
const OFFERS_THE_WAY_BACK = [
  "adminRecentAuthenticationHref",
  "AdminApiFailureNotice",
];

const panelsReaching = (prefix) =>
  panels.filter((panel) => panel.source.includes(prefix));

test("the sweep sees both ends, so a silent pass is impossible", () => {
  assert.ok(
    refusingPrefixes.length >= 8,
    `only ${refusingPrefixes.length} route prefix(es) can refuse; the marker has probably drifted`
  );
  assert.ok(panels.length >= 30, `only ${panels.length} admin panel(s) found`);
  assert.ok(
    refusingPrefixes.some((prefix) => panelsReaching(prefix).length > 0),
    "no panel reaches any refusing route; the path matching has probably broken"
  );
});

test("every panel that can be refused notices the refusal", () => {
  // The hole. A panel that reads `data.error` and throws cannot tell a queued
  // approval from a server fault, and cannot tell either from a stale sign-in.
  const deaf = new Set();
  for (const prefix of refusingPrefixes) {
    for (const panel of panelsReaching(prefix)) {
      if (!HANDLES_REFUSAL.some((marker) => panel.source.includes(marker))) {
        deaf.add(`${panel.name} (reaches ${prefix})`);
      }
    }
  }

  assert.deepEqual(
    [...deaf].sort(),
    [],
    `these panels call a route that can answer 409 or 428 and never look at it. ` +
      `Read the response with readAdminApiFailure() from @/lib/adminApiOutcome:\n  ${[...deaf].sort().join("\n  ")}`
  );
});

test("every panel that notices a refusal offers the way back", () => {
  const missing = panels
    .filter(
      (panel) =>
        HANDLES_REFUSAL.some((marker) => panel.source.includes(marker)) &&
        !OFFERS_THE_WAY_BACK.some((marker) => panel.source.includes(marker))
    )
    .map((panel) => panel.name);

  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} can be refused for a stale step-up window and offer no link to renew it. ` +
      `A toast naming the remedy without a way to reach it is the defect this test exists for: ` +
      `render <AdminApiFailureNotice>, or the link directly with adminRecentAuthenticationHref(<this screen's path>).`
  );
});

test("the shared notice is the one that carries the link", () => {
  // If the notice ever stopped rendering the link, every panel that delegates
  // to it would silently lose the way back while still passing the test above.
  const notice = readFileSync(`${PANEL_DIR}AdminApiFailureNotice.tsx`, "utf8");
  assert.match(notice, /adminRecentAuthenticationHref/);
  assert.match(notice, /requiresReauthentication/);
});
