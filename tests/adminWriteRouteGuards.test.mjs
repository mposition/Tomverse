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
import { createHash } from "node:crypto";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
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
const amuxSourceScopePreviewService = withoutComments(readFileSync(
  join(LIB_DIR, "amux/ideaSourceScopePreviewService.ts"), "utf8"
));
const amuxSourceScopePreviewCore = withoutComments(readFileSync(
  join(LIB_DIR, "amux/ideaSourceScopePreviewCore.ts"), "utf8"
));
const amuxResolutionPreviewCore = withoutComments(readFileSync(
  join(LIB_DIR, "amux/ideaResolutionChoiceCore.ts"), "utf8"
));
const amuxResolutionPreviewService = withoutComments(readFileSync(
  join(LIB_DIR, "amux/ideaResolutionPreviewService.ts"), "utf8"
));
const SOURCE_SCOPE_ROUTE = "app/api/admin/amux/ideas/source-scope-preview/route.ts";
const SOURCE_SCOPE_SERVICE = "lib/amux/ideaSourceScopePreviewService.ts";
const SOURCE_SCOPE_CORE = "lib/amux/ideaSourceScopePreviewCore.ts";
const SOURCE_SCOPE_REVIEWED_FILES = [
  SOURCE_SCOPE_ROUTE,
  "lib/adminAuditIntegrityCore.ts",
  "lib/amux/boardImportCore.ts",
  "lib/amux/ideaCrypto.ts",
  "lib/amux/ideaInputCore.ts",
  "lib/amux/ideaKeyConfig.ts",
  "lib/amux/ideaKeyStore.ts",
  "lib/amux/ideaRequestIdCore.ts",
  "lib/amux/ideaSourceScopeCore.ts",
  SOURCE_SCOPE_CORE,
  SOURCE_SCOPE_SERVICE,
  "lib/amux/ideaSubmissionCore.ts",
  "lib/amux/localIntakeCore.ts",
].sort();
// A digest change reopens this audit exception only after independent review.
const SOURCE_SCOPE_REVIEWED_DIGEST = "faa49f4ee1f34d0f6ce90101f38cae4c7b2d929dcac77b05362eb639a14b9446";
const RESOLUTION_ROUTE = "app/api/admin/amux/ideas/resolution-preview/route.ts";
// The entire AMUX-local import closure is pinned. A new writer or import
// invalidates the exception until its read-only behavior is reviewed.
const RESOLUTION_REVIEWED_DIGEST = "5777109fb68c656e768ab8e96a1e6477cc750e2dbba65f44d7426959eb960877";
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

const amuxBusinessClosure = (overrides = new Map(), root = SOURCE_SCOPE_ROUTE) => {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const absolute = join(REPOSITORY_ROOT, ...path.split("/"));
    const source = overrides.get(path) ?? readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../") &&
          !specifier.startsWith("@/lib/amux/")) continue;
      const target = specifier.startsWith(".")
        ? resolve(dirname(absolute), specifier)
        : resolve(REPOSITORY_ROOT, specifier.slice(2));
      const withExtension = extname(target) ? target : `${target}.ts`;
      const relativePath = relative(REPOSITORY_ROOT, withExtension).split(sep).join("/");
      if (!relativePath.startsWith("lib/amux/") &&
          relativePath !== "lib/adminAuditIntegrityCore.ts") {
        throw new Error("AMUX preview import escaped its closure");
      }
      visit(relativePath);
    }
  };
  visit(root);
  return [...seen].sort();
};

const amuxReviewedDigest = (paths, overrides = new Map()) => {
  const hash = createHash("sha256");
  for (const path of paths) {
    const source = overrides.has(path)
      ? overrides.get(path)
      : readFileSync(join(REPOSITORY_ROOT, ...path.split("/")), "utf8");
    hash.update(path).update("\0").update(source.replace(/\r\n/g, "\n")).update("\0");
  }
  return hash.digest("hex");
};
const amuxSourceScopeReviewedDigest = (overrides = new Map()) =>
  amuxReviewedDigest(SOURCE_SCOPE_REVIEWED_FILES, overrides);
const amuxResolutionReviewedDigest = (overrides = new Map()) =>
  amuxReviewedDigest(amuxBusinessClosure(overrides, RESOLUTION_ROUTE), overrides);

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
  [...routeSource.matchAll(/from\s+"@\/lib\/([A-Za-z0-9/_-]+)"/g)]
    .map((match) => `${LIB_DIR}${match[1]}.ts`)
    .filter((path) => existsSync(path))
    .map((path) => withoutComments(readFileSync(path, "utf8")));

const routes = routeFiles(ADMIN_API_DIR).map((path) => {
  const source = withoutComments(readFileSync(path, "utf8"));
  const imported = importedSources(source);
  return {
    /**
     * Forward slashes on every platform.
     *
     * `join` separates with a backslash on Windows, and the exemption below
     * matches a route by this name -- so a backslash quietly turned a
     * recognised delegation into an unaudited write. The sweep failed on one
     * platform and named a defect that was not in the tree, which is the
     * expensive direction for a guard to be wrong in: the next reader has to
     * rule out a missing audit row before they can dismiss it. A path is how
     * the scan reaches a file; a name is what it asserts about, and the two
     * should not share a shape the operating system chooses.
     */
    name: path.slice(ADMIN_API_DIR.length).split(sep).join("/"),
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

/**
 * The proposal route delegates its one audit to the canonical internal
 * transaction, which is why `writeAdminAuditLog` is absent from its own reach.
 *
 * The route is a proxy and holds no database handle. The proposal row and the
 * entry recording it are written together by `createAmuxReviewProposal`, in one
 * transaction behind `/api/internal/amux/review` -- the stronger shape, because
 * a proposal that committed without its audit entry is then not reachable.
 * Calling `writeAdminAuditLog` on this side as well would add a second row for
 * one action, outside that transaction, and it would survive a proposal that
 * rolled back. So this exempts the route from the call, never from the record.
 *
 * Narrow by construction: rather than trusting the name, it re-derives the
 * whole path on every run -- the forwarded command's shape, the proxy's target
 * URL, the internal route's proposal branch and its writer call, the audit
 * action that writer names, and that the writer performs the call rather than
 * mentioning it. Break any link and this route stops being exempt.
 */
const reachesCanonicalAmuxReviewAudit = (route) =>
  route.name === "amux/escalations/proposals/route.ts" &&
  /forwardAmuxAdminReviewCommand\s*\(\s*request,\s*\{\s*action:\s*"proposal"/.test(route.source) &&
  /new URL\s*\(\s*"\/api\/internal\/amux\/review"/.test(amuxReviewProxy) &&
  amuxReviewInternalRoute.includes('action.action === "proposal"') &&
  amuxReviewInternalRoute.includes("createAmuxReviewProposal({") &&
  amuxProposalWriter.includes('action: "amux.human_escalation.proposed"') &&
  performs(amuxProposalWriter, "writeAdminAuditLog");

/** A POST body is needed for a private scope proposal, but this particular
 * handler is read-only. Keep the audit exemption conditional on the closed
 * code switch, the single service call and the transaction's first operation
 * being SET TRANSACTION READ ONLY. A future write or additional raw statement
 * must make the broad admin audit sweep fail again. */
const isDarkReadOnlyAmuxSourceScopePreview = (
  route,
  service = amuxSourceScopePreviewService,
  core = amuxSourceScopePreviewCore,
) => {
  const routeBusinessImports = [...route.source.matchAll(/from "@\/lib\/([^"]+)"/g)]
    .map((match) => match[1]).sort();
  const serviceBusinessImports = [...service.matchAll(/from "@\/lib\/([^"]+)"/g)]
    .map((match) => match[1]).sort();
  const ownerAt = route.source.indexOf("const session = await owner();");
  const gateAt = route.source.indexOf("if (!sourceScopePreviewPermitted(process.env[AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV]))");
  const rateAt = route.source.indexOf("await consumeApiRateLimit(request, session.user!.id!");
  const previewAt = route.source.indexOf("await previewAmuxSourceScope(session, inspected.request)");
  if (route.name !== "amux/ideas/source-scope-preview/route.ts" ||
      JSON.stringify(amuxBusinessClosure()) !== JSON.stringify(SOURCE_SCOPE_REVIEWED_FILES) ||
      amuxSourceScopeReviewedDigest() !== SOURCE_SCOPE_REVIEWED_DIGEST ||
      ownerAt < 0 || gateAt <= ownerAt || rateAt <= gateAt || previewAt <= rateAt ||
      !/AMUX_V4_SOURCE_SCOPE_PREVIEW_CODE_ENABLED\s*=\s*false\b/.test(core) ||
      !/AMUX_V4_SOURCE_SCOPE_PREVIEW_CODE_ENABLED\s*&&\s*value\s*===\s*"enabled"/.test(core) ||
      (service.match(/\$transaction\s*\(/g) ?? []).length !== 1 ||
      !/return await prisma\.\$transaction\(async \(tx\) => \{\s*await configureAmuxSourceScopeReadOnlyTransaction\(tx\);\s*return previewAmuxSourceScopeInTransaction\(tx, actorUserId, request, keys\);\s*\},/.test(service) ||
      (service.match(/from "\.\/ideaKeyStore\.ts"/g) ?? []).length !== 1 ||
      !/import \{\s*amuxContentKeyRing,\s*loadAmuxContentUnitKeys\s*\} from "\.\/ideaKeyStore\.ts";/.test(service) ||
      JSON.stringify(routeBusinessImports) !== JSON.stringify([
        "adminApproval", "adminAuth", "adminReauthentication", "amux/ideaSourceScopePreviewCore",
        "amux/ideaSourceScopePreviewService", "apiSecurity", "auth",
      ].sort()) ||
      JSON.stringify(serviceBusinessImports) !== JSON.stringify(["adminAuth", "prisma"].sort()) ||
      /\b(?:prisma|tx)\b|\bfetch\s*\(|\bimport\s*\(/.test(route.source) ||
      /\bimport\s*\(|\brequire\s*\(/.test(service) ||
      /\$(?:queryRaw|executeRaw)Unsafe\b/.test(service) ||
      /\b(?:tx|prisma)\.[A-Za-z][\w]*\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/.test(service) ||
      /\bfetch\s*\(/.test(service)) return false;
  const statements = [...service.matchAll(/\$(queryRaw|executeRaw)(?:<[^`]+>)?`([^`]*)`/g)]
    .map((match) => `${match[1]}:${match[2].trim().replace(/\s+/g, " ")}`);
  return JSON.stringify(statements) === JSON.stringify([
    "executeRaw:SET TRANSACTION READ ONLY",
    "executeRaw:SELECT set_config('statement_timeout', '5000', true)",
    'queryRaw:SELECT (clock_timestamp() AT TIME ZONE \'UTC\')::TIMESTAMP(3) AS "now"',
  ]);
};

const isDarkReadOnlyAmuxResolutionPreview = (route) => {
  if (route.name !== "amux/ideas/resolution-preview/route.ts" ||
      amuxResolutionReviewedDigest() !== RESOLUTION_REVIEWED_DIGEST ||
      !/AMUX_V4_RESOLUTION_PREVIEW_CODE_ENABLED\s*=\s*false\b/.test(amuxResolutionPreviewCore) ||
      !/AMUX_V4_RESOLUTION_PREVIEW_CODE_ENABLED\s*&&\s*value\s*===\s*"enabled"/.test(amuxResolutionPreviewCore) ||
      /\b(?:tx|prisma)\.[A-Za-z][\w]*\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(|\$(?:queryRaw|executeRaw)\b|\bfetch\s*\(|\bimport\s*\(/.test(amuxResolutionPreviewService)) {
    return false;
  }
  const post = route.source.slice(route.source.indexOf("export async function POST"));
  const ownerAt = post.indexOf("const session = await owner();");
  const gateAt = post.indexOf("amuxV4ResolutionPreviewEnabled(process.env[AMUX_V4_RESOLUTION_PREVIEW_ENV])");
  const gateReturnsDisabled = /if\s*\(\s*!amuxV4ResolutionPreviewEnabled\(process\.env\[AMUX_V4_RESOLUTION_PREVIEW_ENV\]\)\s*\)\s*\{\s*return\s+NextResponse\.json\(\{\s*error:\s*"resolution_preview_disabled"/.test(post);
  const rateAt = post.indexOf("await consumeApiRateLimit(request, session.user!.id!");
  const previewAt = post.indexOf("await previewAmuxIdeaResolution({ session, ...parsed.data })");
  return ownerAt >= 0 && gateAt > ownerAt && gateReturnsDisabled && rateAt > gateAt &&
    previewAt > rateAt && !/\b(?:prisma|tx)\.|\bfetch\s*\(|\bimport\s*\(/.test(post);
};

test("the read-only POST audit exception closes when its source boundary changes", () => {
  const route = routes.find((candidate) =>
    candidate.name === "amux/ideas/source-scope-preview/route.ts");
  assert.ok(route);
  assert.deepEqual(amuxBusinessClosure(), SOURCE_SCOPE_REVIEWED_FILES);
  assert.equal(amuxSourceScopeReviewedDigest(), SOURCE_SCOPE_REVIEWED_DIGEST);
  const rawRoute = readFileSync(join(REPOSITORY_ROOT, ...SOURCE_SCOPE_ROUTE.split("/")), "utf8");
  assert.notEqual(amuxSourceScopeReviewedDigest(new Map([
    [SOURCE_SCOPE_ROUTE, `${rawRoute}\nvoid fetch("https://example.invalid");`],
  ])), SOURCE_SCOPE_REVIEWED_DIGEST);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview(route), true);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview({ ...route,
    source: `${route.source}\nawait prisma.amuxIdeaSubmission.update({});`,
  }), false);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview({ ...route,
    source: route.source.replace("const session = await owner();", "const session = null;"),
  }), false);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview({ ...route,
    source: route.source.replace("await consumeApiRateLimit(", "void consumeApiRateLimit("),
  }), false);
  assert.notEqual(amuxSourceScopeReviewedDigest(new Map([
    [SOURCE_SCOPE_ROUTE, `${rawRoute}\nimport { request } from "node:https";`],
  ])), SOURCE_SCOPE_REVIEWED_DIGEST);
  const cryptoPath = "lib/amux/ideaCrypto.ts";
  const rawCrypto = readFileSync(join(REPOSITORY_ROOT, ...cryptoPath.split("/")), "utf8");
  assert.notEqual(amuxSourceScopeReviewedDigest(new Map([
    [cryptoPath, `${rawCrypto}\nvoid globalThis.fetch("https://example.invalid");`],
  ])), SOURCE_SCOPE_REVIEWED_DIGEST);
  const auditPath = "lib/adminAuditIntegrityCore.ts";
  const rawAudit = readFileSync(join(REPOSITORY_ROOT, ...auditPath.split("/")), "utf8");
  assert.notEqual(amuxSourceScopeReviewedDigest(new Map([
    [auditPath, `${rawAudit}\nvoid globalThis.fetch("https://example.invalid");`],
  ])), SOURCE_SCOPE_REVIEWED_DIGEST);
  const boardPath = "lib/amux/boardImportCore.ts";
  const rawBoard = readFileSync(join(REPOSITORY_ROOT, ...boardPath.split("/")), "utf8");
  assert.throws(() => amuxBusinessClosure(new Map([
    [boardPath, `${rawBoard}\nimport { writeAdminAuditLog } from "../adminAudit.ts";`],
  ])), /escaped its closure/);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview(route,
    amuxSourceScopePreviewService.replace("SET TRANSACTION READ ONLY", "SELECT 1")), false);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview(route,
    amuxSourceScopePreviewService.replace("loadAmuxContentUnitKeys }",
      "createAmuxContentUnitKeys }")), false);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview(route,
    amuxSourceScopePreviewService.replace("await configureAmuxSourceScopeReadOnlyTransaction(tx);",
      "await tx.$queryRaw`INSERT INTO audit_probe DEFAULT VALUES RETURNING id`;\nawait configureAmuxSourceScopeReadOnlyTransaction(tx);")), false);
  assert.equal(isDarkReadOnlyAmuxSourceScopePreview(route,
    amuxSourceScopePreviewService,
    amuxSourceScopePreviewCore.replace("CODE_ENABLED = false", "CODE_ENABLED = true")), false);
});

test("resolution preview audit exception is pinned to its dark read-only closure", () => {
  const route = routes.find((candidate) =>
    candidate.name === "amux/ideas/resolution-preview/route.ts");
  assert.ok(route);
  assert.equal(amuxResolutionReviewedDigest(), RESOLUTION_REVIEWED_DIGEST);
  assert.equal(isDarkReadOnlyAmuxResolutionPreview(route), true);
  assert.equal(isDarkReadOnlyAmuxResolutionPreview({ ...route,
    source: `${route.source}\nawait prisma.amuxIdeaUnitDecision.create({});`,
  }), false);
  const servicePath = "lib/amux/ideaResolutionPreviewService.ts";
  const service = readFileSync(join(REPOSITORY_ROOT, ...servicePath.split("/")), "utf8");
  assert.notEqual(amuxResolutionReviewedDigest(new Map([
    [servicePath, `${service}\nvoid fetch("https://example.invalid");`],
  ])), RESOLUTION_REVIEWED_DIGEST);
});
const oneShotStageWriter = withoutComments(readFileSync(
  join(LIB_DIR, "promptRefinerVnextOneShotStageWriter.ts"), "utf8"));
const oneShotStageAuditWriter = withoutComments(readFileSync(
  join(LIB_DIR, "promptRefinerVnextOneShotStageApprovalAudit.ts"), "utf8"));
const reachesCanonicalOneShotStageAudit = (route) =>
  route.name === "prompt-refiner/vnext-stage-approval/route.ts" &&
  route.source.includes("createPromptRefinerVnextOneShotStageWithSlots({") &&
  oneShotStageWriter.includes("return prisma.$transaction(async (tx) => {") &&
  oneShotStageWriter.includes("writePromptRefinerVnextOneShotStageApprovalAudit({ ...input, tx })") &&
  oneShotStageAuditWriter.includes('action: "prompt_refiner.vnext_one_shot.stage_approved"') &&
  oneShotStageAuditWriter.includes("tx: input.tx,") &&
  performs(oneShotStageAuditWriter, "writeAdminAuditLog");

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
  // neither is open to any signed-in account. Shared mutation services count
  // only through the same one-level call boundary used for the write guards.
  const unguarded = routes
    .filter(
      (route) =>
        !route.reaches("isAdminSession") &&
        !route.reaches("hasAdminPermission")
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
    .filter((route) => !route.reaches("writeAdminAuditLog") &&
      !reachesCanonicalAmuxReviewAudit(route) &&
      !isDarkReadOnlyAmuxSourceScopePreview(route) &&
      !isDarkReadOnlyAmuxResolutionPreview(route) &&
      !reachesCanonicalOneShotStageAudit(route))
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
        !(!route.source.includes("runWithAdminApproval") &&
          (/if\s*\(\s*isAdminReauthenticationError\s*\(\s*error\s*\)\s*\)/.test(route.source) ||
            /if\s*\(\s*!isAdminReauthenticationError\s*\(\s*error\s*\)\s*\)\s*throw\s+error/.test(route.source)) &&
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
