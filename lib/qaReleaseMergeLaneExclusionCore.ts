/**
 * Which develop pull requests the QA-release merge lane must leave to a person.
 *
 * docs/policy/qa-release-agent.md (version 3), section 8 item 3, is the
 * contract. A pull request listed here is never merged by the lane; it is
 * shown in Admin as human work, and the lane moves on to the next oldest
 * candidate. Every input comes from the caller -- this module reads no
 * network, file or clock -- and every uncertainty excludes.
 */
import { CONTROL_PLANE_NAME_TOKENS, classifyPath, compileManifestPattern, isCanonicalRepoPath } from "./agentAuthorityFiles.ts";
import { isPolicyTestName } from "./agentPushPolicy.ts";

/**
 * Gate paths: only what a revert cannot undo or what would let an agent widen
 * its own gate (owner, 2026-10-23: "keep only the minimum"). The workflows
 * and actions hold the secrets CI runs with; the instructions and the lane's
 * own policy say what agents may do; admin auth, the system audit actors and
 * the authority manifest are the security and audit boundary. Everything else
 * -- scripts, root config other than the three below, workspace manifests and
 * configs, audit records, other policies --
 * is reversible code the lane merges like any feature; CI has already run it
 * on the pull request.
 */
export const QA_RELEASE_MERGE_LANE_GATE_PATTERNS: readonly string[] = [
  ".github/workflows/**",
  ".github/actions/**",
  // The root manifest names the scripts the operator and CI run (npm run merge-train ...);
  // the TypeScript and Next configuration decide which file an import resolves to, so a
  // path alias could swap a kept module for an unkept one (independent review, 2026-10-23).
  "package.json",
  "tsconfig*.json",
  "next.config.*",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/policy/qa-release-agent.md",
  "lib/adminAuth*",
  "lib/adminAuditSystemActors.ts",
  "lib/agentAuthorityFiles.ts",
];

/** Head branches whose own contract requires a human merge or a required review. */
export const QA_RELEASE_MERGE_LANE_EXCLUDED_BRANCH_PREFIXES: readonly string[] = [
  "agent",
  "marketing-agent",
  "feedback-autofix",
  "feedback-autofix-main",
  "autofix",
  "visual-baseline",
  "dependabot",
];

/**
 * The one exception to the `agent` prefix (owner decision 2026-11-13: "develop
 * 병합 권한은 DM에게 승인합니다. main은 안됩니다."): an engineering agent pull
 * request, head `agent/engineering/<run>`, that the app reports approved by
 * the Decision Maker with its conditions re-checked at this very head
 * (lib/amux/dmT2MergeRead.ts). Develop only; the lane never merges into main.
 */
export const QA_RELEASE_DM_APPROVED_HEAD = /^agent\/engineering\/[0-9]{1,20}$/;

/**
 * The other exception (owner decision 2026-11-15: "CI Admission Agent에 ...
 * dependabot이 생성한 PR들 모두 자체 병합 가능하게 권한 주세요"): a Dependabot
 * npm update into develop. Only when the GitHub read vouches for it
 * (`dependabot`: not a fork, opened by dependabot[bot], every commit
 * dependabot[bot]'s and signed by GitHub) and it changes nothing but npm
 * manifests and lock files -- the root package.json is a gate path for its
 * scripts, and Dependabot only moves dependency versions. A person's commit on
 * the branch, a workflow (github_actions updates) or any other path leaves it
 * to a person.
 */
export const QA_RELEASE_DEPENDABOT_HEAD = /^dependabot\/npm_and_yarn\/develop\//;
export const QA_RELEASE_DEPENDABOT_PATHS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "**/package.json",
  "**/package-lock.json",
];

/**
 * How far a Decision Maker approved pull request may reach (owner decision
 * 2026-11-15: "내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다. 로컬 CLI처럼
 * 편리한 Flow였으면 합니다."). `blocklist`, the default: every product path
 * on no block list may merge. `allowlist`, the kill switch: only the allow
 * list of 2026-11-13, exactly as it was. Unset, empty or exactly `blocklist`
 * is the default; any other value -- `allowlist`, or a typo -- is the allow
 * list, so the switch only ever fails toward the narrower rule. The app reads
 * it (lib/amux/dmT2MergeService.ts) and tells the merge lane only of what its
 * scope lets through; the lane judges those again in the block list scope
 * (lib/qaReleaseMergeLaneServiceCore.ts QA_RELEASE_LANE_DM_MERGE_SCOPE), so
 * setting it on the app service alone reverts the whole path.
 */
export const QA_RELEASE_DM_MERGE_SCOPE_ENV = "TOMVERSE_AMUX_DM_MERGE_SCOPE";
export type QaReleaseDmMergeScope = "blocklist" | "allowlist";
export const qaReleaseDmMergeScope = (env: Readonly<Record<string, string | undefined>>): QaReleaseDmMergeScope => {
  const value = env[QA_RELEASE_DM_MERGE_SCOPE_ENV];
  return value === undefined || value === "" || value === "blocklist" ? "blocklist" : "allowlist";
};

/**
 * The allow list scope (the kill switch): the only paths a Decision Maker
 * approved pull request may change and still be merged without a person
 * (review r-20261113-134019-5d8f82). Every changed path, both sides of a
 * rename, must be inside it; one outside leaves the whole pull request to a
 * person. Tests, documents other than policy, UI contracts and agent
 * instructions, locale strings, components, and the page, layout, loading
 * and error files of app routes. Code under lib/, every API route and
 * everything else is a person's.
 */
export const QA_RELEASE_DM_MERGE_ALLOW_PATTERNS: readonly string[] = [
  "tests/**",
  "docs/**",
  "locales/**",
  "components/**",
  "app/**/page.tsx",
  "app/**/layout.tsx",
  "app/**/loading.tsx",
  "app/**/error.tsx",
];

/** Inside the allow list and still a person's: the policy, the UI contracts, the agent instructions, every API route. */
export const QA_RELEASE_DM_MERGE_ALLOW_EXCEPT_PATTERNS: readonly string[] = [
  "docs/policy/**",
  "docs/ui-contracts/**",
  "docs/agents/**",
  "app/api/**",
];

/**
 * Laid over either scope, without regard to case: the gate paths above and
 * what a revert cannot undo (migrations and the schema; prices, credits and
 * the contract role's other areas; authentication and secrets; the audit
 * chain; deletion and retention). A path on it is a person's even inside the
 * allow list.
 */
export const QA_RELEASE_DM_MERGE_BLOCK_PATTERNS: readonly string[] = [
  "prisma/migrations/**",
  "prisma/schema.prisma",
  "lib/modelPricing*",
  "lib/credit*",
  "lib/chatCostGuardrails.ts",
  "lib/models.ts",
  "lib/billing*",
  "lib/planChange*",
  "app/api/billing/**",
  "lib/conversationProduct.ts",
  "lib/email*",
  "lib/auth*",
  "app/api/auth/**",
  "lib/**/*Secret*",
  "lib/adminAudit*",
  "lib/**/*SystemAudit*",
  "lib/amux/auditContract.ts",
  "lib/retention*",
  "lib/**/*Retention*",
  "lib/**/*Deletion*",
];

/**
 * The block list scope's further paths, without regard to case: raw SQL and
 * key material anywhere; package manifests, lock files and build
 * configuration in any directory (what runs, and which module an import
 * resolves to); unauthenticated public reads and shares, object storage, and
 * the account routes (deletion, export).
 */
export const QA_RELEASE_DM_MERGE_BLOCKLIST_SCOPE_PATTERNS: readonly string[] = [
  "**/*.sql",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/.npmrc",
  "**/tsconfig*.json",
  "**/*.config.*",
  "app/api/public/**",
  "lib/public*",
  "lib/r2.ts",
  "app/api/code/**",
  "app/api/user/account/**",
];

/**
 * The block list scope's name fragments: one anywhere in a path, without
 * regard to case, leaves the pull request to a person. A revert cannot undo
 * what these areas do (AGENTS.md's list of what needs a person), so a list of
 * file names would always miss one -- a fragment takes every file of the area,
 * present and future, and more than it must (`auth` also takes `author`),
 * which only means a person merges. Above it: product paths only
 * (lib/agentAuthorityFiles.ts), so the execution environment (`scripts/**`,
 * `bin/**`, `config/**`, `docker/**`, `tools/**`, root files and
 * dot-directories), policy and agent instructions, the admin console and the
 * whole AMUX control plane stay a person's in either scope.
 */
export const QA_RELEASE_DM_MERGE_BLOCK_NAME_TOKENS: readonly string[] = [
  // Real money leaving: prices, credits, billing, spending caps and ceilings, cost ledgers, plans and what
  // they entitle, which models run by default, the paid providers and their calls, and guests (whose
  // calls Tomverse pays for).
  "pric", "credit", "billing", "stripe", "payment", "checkout", "subscription", "promotion", "coupon",
  "discount", "refund", "invoice", "payout", "purchase", "budget", "spend", "cost", "ledger", "guardrail",
  "quota", "ceiling", "entitlement", "ratelimit", "reservation", "settlement", "usage", "currency",
  "goodwill", "grant", "wallet", "foundingtester", "planchange", "plandefault", "planadjust", "codemanaged",
  "modelcatalog", "modelregistry", "modelselection", "models", "activeaimodel", "initialmodel",
  "pinnedmodel", "defaultmodel", "retire", "productkey", "conversationproduct", "appdefault", "appsetting",
  "tunable", "admission", "limitdecision", "requestlimit", "concurrency", "guest", "provider", "openai",
  "anthropic", "gemini", "google", "perplexity",
  "mistral", "cohere", "qwen", "xai", "deepseek", "elevenlabs", "higgsfield", "heygen", "falimage",
  // Anything leaving Tomverse: mail, notifications, publication, marketing, webhooks, shares, analytics,
  // the app stores.
  "mail", "unsubscribe", "newsletter", "broadcast", "notif", "webpush", "publish", "marketing", "social",
  "zernio", "webhook", "slack", "discord", "telegram", "twilio", "share", "sharing", "ga4", "analytic",
  "posthog", "sentry", "mobilestore",
  // Deleting user data, and where it is stored.
  "delet", "purge", "erase", "erasure", "retention", "gdpr", "wipe", "anonymi", "tombstone", "prune",
  "cleanup", "expir", "maintenance", "scheduledjob", "storage",
  // Credentials and security boundaries, consent and legal text.
  "auth", "secret", "token", "session", "password", "passkey", "webauthn", "credential", "csrf", "crypto",
  "encrypt", "signature", "hmac", "jwt", "cookie", "bearer", "revocation", "refreshrotation", "permission",
  "security", "sanitiz", "ssrf", "csp", "cors", "egress", "originprotection", "requestorigin", "clientip",
  "captcha", "turnstile", "abuse", "trust", "moderat", "jurisdiction", "region", "country", "china",
  "aurelationship", "allowlist", "denylist", "blocklist", "consent", "privacy", "legal", "terms", "safety",
  "redirect", "middleware", "verif", "keyring", "login", "signin", "signup", "account", "identity",
  "conversationlock", "lockservice", "lockgrant", "/lock", "mcp", "admin", "impersonat", "well-known", "testmode",
  "e2e", "fixture",
  // The audit chain.
  "audit",
  // Production merges, releases and deployments, and what CI admission and the merge lane decide.
  "deploy", "release", "railway", "github", "ciadmission", "cirepair", "qarelease", "mergetrain",
  "mergelane", "autofix", "canary", "rollout", "qualitygate",
  // Giving an agent a new permission: approvals, activations, switches, and the agents themselves.
  "approv", "activation", "killswitch", "featureflag", "featureswitch", "supporttriage", "scout", "sreops",
  "crossreview", ...CONTROL_PLANE_NAME_TOKENS,
  // The database: migrations, backfills, the client and its connection.
  "prisma", "migrat", "backfill", "postgres", "connectionconfig",
];

export type QaReleaseChangedFile = {
  path: string;
  /** Set for a rename: both sides are judged. */
  previousPath?: string | null;
  /**
   * The new text of a changed `migration.sql` under `prisma/migrations`, or
   * `null` when it could not be read. Ignored for every other path.
   */
  migrationSql?: string | null;
};

/**
 * Table names a migration must not touch unattended: this agent's own tables
 * and the shared digest table its rows live in (policy version 2, section 8
 * item 3).
 */
export const QA_RELEASE_PROTECTED_TABLE_PATTERN = /QaRelease[A-Za-z0-9_]*|AgentDigestItem/;

export const QA_RELEASE_MIGRATION_SQL_PATH = /^prisma\/migrations\/[^/]+\/migration\.sql$/;

export type QaReleaseExclusionInput = {
  headBranch: string;
  changedFiles: readonly QaReleaseChangedFile[];
  /** False when the changed-file list could not be read to its last page. */
  changedFilesComplete: boolean;
  /** `tests/**` paths named by the policy documents at the pull request's base; null when unread. */
  policyTestPaths: readonly string[] | null;
  /** This agent's own path patterns, read from the policy at the pull request's base; null when unread. */
  agentOwnPatterns: readonly string[] | null;
  /**
   * The app reports this pull request approved by the Decision Maker, its
   * conditions re-checked, at this head, into develop (QA_RELEASE_DM_APPROVED_HEAD).
   * Absent or false: the `agent` prefix leaves it to a person, as ever.
   */
  dmApproved?: boolean;
  /**
   * Which rule judges a Decision Maker approved pull request's paths: the
   * caller reads it from its environment (qaReleaseDmMergeScope). Absent is
   * the allow list, the narrower rule.
   */
  dmMergeScope?: QaReleaseDmMergeScope;
  /**
   * The GitHub read vouches that this is Dependabot's own pull request
   * (QA_RELEASE_DEPENDABOT_HEAD). Absent or false: the `dependabot` prefix
   * leaves it to a person, as ever.
   */
  dependabot?: boolean;
};

export type QaReleaseExclusionReason =
  | "changed_files_incomplete"
  | "changed_files_empty"
  | "inputs_unreadable"
  | "unreadable_path"
  | "gate_path"
  | "policy_test"
  | "agent_own_path"
  | "protected_table_migration"
  | "excluded_branch"
  /** A Decision Maker approved pull request that changes a path its merge scope leaves to a person. */
  | "dm_outside_allowlist"
  /** A Dependabot pull request that changes a path other than an npm manifest or lock file. */
  | "dependabot_outside_manifests";

export type QaReleaseExclusion =
  | { excluded: false }
  | { excluded: true; reasons: QaReleaseExclusionReason[] };

const GATE_MATCHERS = QA_RELEASE_MERGE_LANE_GATE_PATTERNS.map(compileManifestPattern);
const DM_ALLOW_MATCHERS = QA_RELEASE_DM_MERGE_ALLOW_PATTERNS.map(compileManifestPattern);
const DM_ALLOW_EXCEPT_MATCHERS = QA_RELEASE_DM_MERGE_ALLOW_EXCEPT_PATTERNS
  .map((pattern) => new RegExp(compileManifestPattern(pattern).source, "i"));
const DEPENDABOT_MATCHERS = QA_RELEASE_DEPENDABOT_PATHS.map(compileManifestPattern);
const DM_BLOCK_MATCHERS = [...QA_RELEASE_MERGE_LANE_GATE_PATTERNS, ...QA_RELEASE_DM_MERGE_BLOCK_PATTERNS]
  .map((pattern) => new RegExp(compileManifestPattern(pattern).source, "i"));
const DM_BLOCKLIST_SCOPE_MATCHERS = QA_RELEASE_DM_MERGE_BLOCKLIST_SCOPE_PATTERNS
  .map((pattern) => new RegExp(compileManifestPattern(pattern).source, "i"));

/** A block list scope name fragment anywhere in the path, without regard to case. */
export function qaReleaseDmMergeBlockedName(path: string): boolean {
  const lower = path.toLowerCase();
  return QA_RELEASE_DM_MERGE_BLOCK_NAME_TOKENS.some((token) => lower.includes(token));
}

/**
 * Whether one changed path may be part of a pull request the Decision Maker
 * merges: a canonical product path in the engineering agent's authority
 * manifest (its control plane -- the AMUX, the agents, admin, scripts and the
 * rest of the execution environment, policy and instructions -- stays a
 * person's), not a policy test (by name, lib/agentPushPolicy.ts, or named by
 * the policy documents when the caller read them), and on no block list.
 * The allow list scope also wants it inside the allow list and outside its
 * exceptions, exactly as before. The block list scope keeps what the allow
 * list let through and adds every other product path -- code under lib/, API
 * routes, the rest of app/, packages, types -- whose name carries no block
 * fragment; raw SQL and key material are a person's anywhere.
 */
export function qaReleaseDmMergeAllowed(path: unknown, policyTestPaths: readonly string[] = [],
  scope: QaReleaseDmMergeScope = "allowlist"): boolean {
  if (!isReadablePath(path)) return false;
  const blocklist = scope === "blocklist";
  const inAllowList = DM_ALLOW_MATCHERS.some((matcher) => matcher.test(path)) &&
    !DM_ALLOW_EXCEPT_MATCHERS.some((matcher) => matcher.test(path));
  if (!blocklist && !inAllowList) return false;
  if (classifyPath(path) !== "product") return false;
  if (isPolicyTestName(path) || policyTestPaths.includes(path)) return false;
  if (DM_BLOCK_MATCHERS.some((matcher) => matcher.test(path))) return false;
  if (!blocklist) return true;
  if (DM_BLOCKLIST_SCOPE_MATCHERS.some((matcher) => matcher.test(path))) return false;
  return inAllowList || !qaReleaseDmMergeBlockedName(path);
}

/**
 * A repository-relative path as Git stores it, judged by the same rule the
 * ownership manifest uses. Anything else cannot be judged against the
 * patterns and so excludes the pull request.
 */
function isReadablePath(path: unknown): path is string {
  return typeof path === "string" && isCanonicalRepoPath(path);
}

function branchExcluded(headBranch: string, dmApproved: boolean, dependabot: boolean): boolean {
  if (dmApproved && QA_RELEASE_DM_APPROVED_HEAD.test(headBranch)) return false;
  if (dependabot && QA_RELEASE_DEPENDABOT_HEAD.test(headBranch)) return false;
  return QA_RELEASE_MERGE_LANE_EXCLUDED_BRANCH_PREFIXES.some(
    (prefix) => headBranch === prefix || headBranch.startsWith(`${prefix}/`),
  );
}

/**
 * The paths of a Decision Maker approved pull request that leave it to a
 * person (qaReleaseDmMergeAllowed in that scope): control plane, on a block
 * list, a policy test, outside the allow list in that scope, or one that
 * cannot be judged. Empty when none does.
 */
export function qaReleaseDmApprovedHumanPaths(paths: readonly unknown[], policyTestPaths: readonly string[] = [],
  scope: QaReleaseDmMergeScope = "allowlist"): string[] {
  return paths.flatMap((path) => qaReleaseDmMergeAllowed(path, policyTestPaths, scope) ? [] : [String(path).slice(0, 200)]);
}

/** The scope a judgement runs in: the block list only when the caller says so. */
const scopeOf = (input: Pick<QaReleaseExclusionInput, "dmMergeScope">): QaReleaseDmMergeScope =>
  input.dmMergeScope === "blocklist" ? "blocklist" : "allowlist";

export function judgeQaReleaseMergeLaneExclusion(input: QaReleaseExclusionInput): QaReleaseExclusion {
  const reasons = new Set<QaReleaseExclusionReason>();
  const dmApproved = input.dmApproved === true;
  const dependabot = dependabotVouched(input);

  if (typeof input.headBranch !== "string" || input.headBranch === "" || branchExcluded(input.headBranch, dmApproved, dependabot)) {
    reasons.add("excluded_branch");
  }
  // The lists the judgement depends on must be present; a missing one is not
  // an empty one.
  if (!Array.isArray(input.policyTestPaths) || !Array.isArray(input.agentOwnPatterns)) {
    reasons.add("inputs_unreadable");
  }
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : null;
  if (changedFiles === null || input.changedFilesComplete !== true) {
    reasons.add("changed_files_incomplete");
  } else if (changedFiles.length === 0) {
    reasons.add("changed_files_empty");
  }
  if (reasons.has("inputs_unreadable") || changedFiles === null || input.policyTestPaths === null || input.agentOwnPatterns === null) {
    return { excluded: true, reasons: [...reasons].sort() };
  }

  const judgeFile = fileJudge(input.policyTestPaths, input.agentOwnPatterns, dmApproved, dependabot, scopeOf(input));
  for (const file of changedFiles) for (const reason of judgeFile(file)) reasons.add(reason);

  return reasons.size === 0 ? { excluded: false } : { excluded: true, reasons: [...reasons].sort() };
}

/** Dependabot's exception holds only on its own head prefix, whatever the caller says. */
function dependabotVouched(input: Pick<QaReleaseExclusionInput, "dependabot" | "headBranch">): boolean {
  return input.dependabot === true && typeof input.headBranch === "string" && QA_RELEASE_DEPENDABOT_HEAD.test(input.headBranch);
}

/** The per-file half of the judgement: what one changed file excludes for. */
function fileJudge(policyTestPaths: readonly string[], agentOwnPatterns: readonly string[], dmApproved = false, dependabot = false,
  dmMergeScope: QaReleaseDmMergeScope = "allowlist") {
  const policyTests = new Set(policyTestPaths);
  const ownMatchers = agentOwnPatterns.map(compileManifestPattern);
  return (file: QaReleaseChangedFile): Set<QaReleaseExclusionReason> => {
    const reasons = new Set<QaReleaseExclusionReason>();
    const paths = [file.path];
    if (file.previousPath !== undefined && file.previousPath !== null) paths.push(file.previousPath);
    for (const path of paths) {
      if (!isReadablePath(path)) {
        reasons.add("unreadable_path");
        continue;
      }
      const manifest = DEPENDABOT_MATCHERS.some((matcher) => matcher.test(path));
      if (dependabot && !manifest) reasons.add("dependabot_outside_manifests");
      if (GATE_MATCHERS.some((matcher) => matcher.test(path)) && !(dependabot && manifest)) {
        reasons.add("gate_path");
      }
      if (policyTests.has(path)) reasons.add("policy_test");
      if (ownMatchers.some((matcher) => matcher.test(path))) reasons.add("agent_own_path");
      if (dmApproved && !qaReleaseDmMergeAllowed(path, policyTestPaths, dmMergeScope)) reasons.add("dm_outside_allowlist");
    }
    if (isReadablePath(file.path) && QA_RELEASE_MIGRATION_SQL_PATH.test(file.path)) {
      if (typeof file.migrationSql !== "string" || QA_RELEASE_PROTECTED_TABLE_PATTERN.test(file.migrationSql)) {
        reasons.add("protected_table_migration");
      }
    }
    return reasons;
  };
}

/**
 * The changed files that leave a pull request to a person, with why, for the
 * Admin screen: the same per-file rule as the judgement, so the screen names
 * exactly the files the lane stopped on. Empty when the inputs were not read.
 */
export function qaReleaseMergeLaneExcludingFiles(
  input: QaReleaseExclusionInput,
  limit = 20,
): { path: string; reasons: QaReleaseExclusionReason[] }[] {
  if (!Array.isArray(input.changedFiles) || !Array.isArray(input.policyTestPaths) || !Array.isArray(input.agentOwnPatterns)) return [];
  const judgeFile = fileJudge(input.policyTestPaths, input.agentOwnPatterns, input.dmApproved === true, dependabotVouched(input),
    scopeOf(input));
  const out: { path: string; reasons: QaReleaseExclusionReason[] }[] = [];
  for (const file of input.changedFiles) {
    const reasons = judgeFile(file);
    if (reasons.size > 0) out.push({ path: String(file.path).slice(0, 200), reasons: [...reasons].sort() });
    if (out.length >= limit) break;
  }
  return out;
}
