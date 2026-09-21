// Every admin write is rate limited and audited, and stays that way.
//
// All forty-seven mutating handlers under `app/api/admin/**` call
// `consumeApiRateLimit` and `writeAdminAuditLog` today. That is a fact about
// the tree, not a contract: each was added by hand, several have per-route
// contract tests, and nothing asks the question across the whole surface. A
// forty-eighth route that omits either would be found by whoever needed the
// audit trail and could not produce one -- which is the wrong moment.
//
// A source scan for the same reason `adminReauthenticationCta.test.mjs` is
// one: the question is whether a call exists at all, and a missing call never
// fails a test that does not know to look for it. Coarse on purpose -- it
// cannot tell a guard that runs from one that is imported and forgotten, and
// it does not try.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_API_DIR = fileURLToPath(new URL("../app/api/admin/", import.meta.url));

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

const routeFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routeFiles(full));
    } else if (entry === "route.ts") {
      found.push(full);
    }
  }
  return found;
};

/**
 * The file with its comments removed.
 *
 * Matching raw source read a *mention* as a call:
 * `email-deliveries/reveal/route.ts` explains in a comment why it writes its
 * audit entry before disclosing anything, "for the same reason
 * `runWithAdminApproval` writes one first", and was reported as a route that
 * raises an approval requirement without mapping it. It raises none.
 *
 * Stripping is also the stricter reading in the direction that matters: a
 * commented-out `consumeApiRateLimit` is not a rate limit, and this now says
 * so. Naive about a `/*` inside a string literal, which none of these files
 * has; if one appears, the scan over-reports rather than under-reports.
 */
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const LIB_DIR = fileURLToPath(new URL("../lib/", import.meta.url));
const amuxReviewProxy = withoutComments(readFileSync(join(LIB_DIR, "amux/reviewAdminProxy.ts"), "utf8"));
const amuxReviewInternalRoute = withoutComments(readFileSync(
  fileURLToPath(new URL("../app/api/internal/amux/review/route.ts", import.meta.url)),
  "utf8",
));
const amuxReviewWriter = withoutComments(readFileSync(join(LIB_DIR, "amux/reviewApproval.ts"), "utf8"));
const amuxProposalWriter = amuxReviewWriter.match(
  /export async function createAmuxReviewProposal\b[\s\S]*?(?=\nexport (?:async )?function |$)/
)?.[0] ?? "";

/**
 * Whether a file *performs* a call rather than merely containing the name.
 *
 * The distinction is the whole reason this is a function. Following a route's
 * imports one level lets a route audit through a shared service -- which is the
 * better shape, one place deciding what the row says -- but every route that
 * calls `writeAdminAuditLog` also imports `lib/adminAudit.ts`, the module that
 * *defines* it. Counting a mention made that module vouch for the route, and
 * the sweep passed a handler whose only audit call had been renamed away.
 * Caught by mutation, which is the only way a weakened guard gets caught.
 */
const performs = (source, name) => {
  const declares = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`
  ).test(source);
  return !declares && new RegExp(`\\b${name}\\s*\\(`).test(source);
};

/** The `@/lib` modules a route imports, as text. One level, not transitive. */
const importedSources = (routeSource) =>
  [...routeSource.matchAll(/from "@\/lib\/([A-Za-z0-9/_-]+)"/g)]
    .map((match) => `${LIB_DIR}${match[1]}.ts`)
    .filter((path) => existsSync(path))
    .map((path) => withoutComments(readFileSync(path, "utf8")));

const routes = routeFiles(ADMIN_API_DIR).map((path) => {
  const source = withoutComments(readFileSync(path, "utf8"));
  const imported = importedSources(source);
  return {
    name: path.slice(ADMIN_API_DIR.length),
    source,
    /**
     * Whether the route, or a service it calls, performs `name`.
     *
     * Two levels would accept a helper that merely shares a dependency with
     * something that audits, and the question is whether the write leaves a
     * row -- not how far away the writer is.
     */
    reaches: (name) =>
      performs(source, name) ||
      imported.some((moduleSource) => performs(moduleSource, name)),
  };
});

const writeRoutes = routes.filter((route) =>
  WRITE_METHODS.some((method) =>
    new RegExp(`^export async function ${method}\\b`, "m").test(route.source)
  )
);

/** The proposal route delegates its one audit to the canonical internal transaction. */
const reachesCanonicalAmuxReviewAudit = (route) =>
  route.name === "amux/escalations/proposals/route.ts" &&
  /forwardAmuxAdminReviewCommand\s*\(\s*request,\s*\{\s*action:\s*"proposal"/.test(route.source) &&
  amuxReviewProxy.includes('new URL("/api/internal/amux/review"') &&
  amuxReviewInternalRoute.includes('action.action === "proposal"') &&
  amuxReviewInternalRoute.includes("createAmuxReviewProposal({") &&
  amuxProposalWriter.includes('action: "amux.human_escalation.proposed"') &&
  performs(amuxProposalWriter, "writeAdminAuditLog");

test("the sweep sees the admin API, so a silent pass is impossible", () => {
  assert.ok(
    routes.length >= 60,
    `only ${routes.length} admin route file(s) found; the directory has probably moved`
  );
  assert.ok(
    writeRoutes.length >= 40,
    `only ${writeRoutes.length} admin write route(s) matched; the export pattern has probably drifted`
  );
});

test("every admin route decides whether the caller is an administrator", () => {
  // The guard itself, not the role: `isAdminSession` answers the first
  // question and `hasAdminPermission` the second, but a route that asks
  // neither is open to any signed-in account.
  const unguarded = routes
    .filter(
      (route) =>
        !route.source.includes("isAdminSession") &&
        !route.source.includes("hasAdminPermission")
    )
    .map((route) => route.name);

  assert.deepEqual(
    unguarded,
    [],
    `${unguarded.join(", ")} answer without checking that the caller is an administrator.`
  );
});

test("every admin write route is rate limited", () => {
  // Not abuse protection so much as blast-radius protection: these endpoints
  // disable models, suppress addresses and delete accounts, and a loop that
  // gets one of them wrong should run out of budget rather than run out of
  // rows.
  const unlimited = writeRoutes
    .filter((route) => !route.reaches("consumeApiRateLimit"))
    .map((route) => route.name);

  assert.deepEqual(
    unlimited,
    [],
    `${unlimited.join(", ")} mutate without calling consumeApiRateLimit(). ` +
      `Every other admin write route does; add it rather than making this the exception.`
  );
});

test("every admin write route writes an audit entry", () => {
  // `AdminAuditLog` is the only record of who changed what, it is hash-chained,
  // and a write that leaves no row is invisible to `verifyAdminAuditIntegrity`
  // as well -- the chain stays valid because the entry was never in it.
  const unaudited = writeRoutes
    .filter((route) => !route.reaches("writeAdminAuditLog") && !reachesCanonicalAmuxReviewAudit(route))
    .map((route) => route.name);

  assert.deepEqual(
    unaudited,
    [],
    `${unaudited.join(", ")} mutate without calling writeAdminAuditLog(). ` +
      `An administrator action nobody can reconstruct is the failure the audit log exists to prevent.`
  );
});

test("a route that can queue an approval can also answer the step-up refusal", () => {
  // `runWithAdminApproval` asserts a recent sign-in before it does anything
  // else and throws `AdminReauthenticationRequiredError`. Only
  // `adminApprovalErrorResponse()` also maps two-person approval outcomes.
  // Routes using only assertRecentAdminAuthentication may map its 428 directly.
  const missing = writeRoutes
    .filter(
      (route) =>
        (route.source.includes("runWithAdminApproval") ||
          route.source.includes("assertRecentAdminAuthentication")) &&
        !route.source.includes("adminApprovalErrorResponse") &&
        !( !route.source.includes("runWithAdminApproval") &&
          /if\s*\(\s*isAdminReauthenticationError\s*\(\s*error\s*\)\s*\)/.test(route.source) &&
          /return\s+[^;]*status:\s*428/.test(route.source))
    )
    .map((route) => route.name);

  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} can raise a step-up or approval requirement and do not map it. ` +
      `Use adminApprovalErrorResponse for two-person approval routes, or map a step-up-only refusal to HTTP 428.`
  );
  assert.ok(
    writeRoutes.some((route) => route.source.includes("runWithAdminApproval")),
    "no route uses runWithAdminApproval; the marker has probably been renamed"
  );
});
