// No admin panel may issue a request that cannot end.
//
// Thirty-three of the console's thirty-four fetching panels had no timeout.
// The one that did put it there by hand, on one of its calls. `/api/ready` has
// used a deadline on its database probe since it was written, so this was never
// a technique the codebase lacked -- the console simply never got it.
//
// A request with no deadline does not fail, it hangs. A panel spinning forever
// is the same defect as one reporting something untrue: the operator learns
// nothing and has nothing to act on, and it happens when the platform is slow,
// which is when they are looking.
//
// A source scan, like `adminReauthenticationCta.test.mjs`, and for the same
// reason: the question is whether a call goes through the wrapper at all, and a
// bare `fetch` never fails a render test that does not know to look for it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADMIN_FETCH_TIMEOUT_MS,
  isAdminFetchAbort,
  isAdminFetchTimeout,
} from "../lib/adminFetch.ts";

const PANEL_DIR = fileURLToPath(new URL("../components/admin/", import.meta.url));

/** Comments explain calls; they do not make them. */
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const panels = readdirSync(PANEL_DIR)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => ({
    name,
    source: withoutComments(readFileSync(`${PANEL_DIR}${name}`, "utf8")),
  }));

/** A call to the global `fetch`, not a property or an identifier ending in it. */
const BARE_FETCH = /(?<![\w.$])fetch\s*\(/;

test("the sweep sees the panels, so a silent pass is impossible", () => {
  assert.ok(
    panels.length >= 30,
    `only ${panels.length} admin panel(s) found; the directory has probably moved`
  );
  const fetching = panels.filter((panel) => panel.source.includes("adminFetch("));
  assert.ok(
    fetching.length >= 30,
    `only ${fetching.length} panel(s) reach the wrapper; the name has probably drifted`
  );
});

test("no admin panel calls fetch directly", () => {
  const bare = panels
    .filter((panel) => BARE_FETCH.test(panel.source))
    .map((panel) => panel.name);

  assert.deepEqual(
    bare,
    [],
    `${bare.join(", ")} call fetch() directly, so those requests have no deadline. ` +
      `Use adminFetch() from @/lib/adminFetch, which is the same signature with one.`
  );
});

test("a panel that uses the wrapper imports it rather than shadowing a name", () => {
  const unimported = panels
    .filter(
      (panel) =>
        panel.source.includes("adminFetch(") &&
        !panel.source.includes('from "@/lib/adminFetch"')
    )
    .map((panel) => panel.name);

  assert.deepEqual(unimported, [], `${unimported.join(", ")} use adminFetch without importing it.`);
});

test("the deadline is a real number of milliseconds, in one place", () => {
  assert.equal(typeof ADMIN_FETCH_TIMEOUT_MS, "number");
  assert.ok(
    ADMIN_FETCH_TIMEOUT_MS >= 5_000 && ADMIN_FETCH_TIMEOUT_MS <= 60_000,
    `a ${ADMIN_FETCH_TIMEOUT_MS}ms admin deadline is either too tight to survive a slow query or too loose to be noticed`
  );
});

test("a deadline is told apart from a cancellation the panel asked for", () => {
  // Reporting "the request failed" for an abort the component issued on
  // unmount tells the operator about the component's own bookkeeping.
  const timeout = new DOMException("timed out", "TimeoutError");
  const aborted = new DOMException("aborted", "AbortError");

  assert.equal(isAdminFetchTimeout(timeout), true);
  assert.equal(isAdminFetchTimeout(aborted), false);
  assert.equal(isAdminFetchAbort(aborted), true);
  assert.equal(isAdminFetchAbort(timeout), false);

  // And neither claims an ordinary failure as its own.
  assert.equal(isAdminFetchTimeout(new TypeError("network")), false);
  assert.equal(isAdminFetchAbort(new TypeError("network")), false);
});
