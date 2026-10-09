/**
 * The ownership manifest: which tracked paths the engineering agent may ever
 * publish a change to, and which belong to the control plane.
 *
 * docs/policy/engineering-agent.md §4 is the contract. Every tracked file is
 * `product`, `control-plane` or `unclassified`, and only `product` can reach
 * tier one. The classification is a human act -- adding or moving a rule is a
 * pull request the owner merges -- and this module is on the push-forbidden
 * list itself, so the agent cannot widen it.
 *
 * Nothing here claims to discover every future control-plane file on its own.
 * What it guarantees is narrower: a path nobody classified, a top-level
 * directory nobody listed, and a framework convention nobody re-checked after
 * an upgrade all fall to tier two rather than out onto the public repository.
 * `tests/agentAuthorityFiles.test.mjs` sweeps the tree so that a new file whose
 * name says it is agent or AMUX code fails the build until someone classifies
 * it.
 *
 * Pure and dependency-free, like every judgement module the services import.
 */

export const AUTHORITY_MANIFEST_VERSION = 1;

export const AUTHORITY_CLASSES = ["product", "control-plane", "unclassified"] as const;
export type AuthorityClass = (typeof AUTHORITY_CLASSES)[number];

/**
 * Every top-level directory the manifest knows about. A path under any other
 * top-level directory is tier two whatever its class (policy §4, rule (c)):
 * a new directory is a new place code can be loaded from, and nobody has
 * looked at it yet. Root-level files are control-plane on their own terms.
 */
export const KNOWN_TOP_LEVEL_DIRECTORIES = [
  ".claude",
  ".codex",
  ".github",
  ".railway",
  ".superpowers",
  ".tmp",
  "app",
  "apps",
  "components",
  "config",
  "crates",
  "docker",
  "docs",
  "lib",
  "locales",
  "packages",
  "prisma",
  "public",
  "scripts",
  "tests",
  "tools",
  "types",
  "vendor",
] as const;

/**
 * Framework conventions the push policy relies on -- which file names Next
 * turns into routes, which parser the slice analysis uses. When the installed
 * version differs from the one recorded here, nobody has re-checked the
 * conventions, and every change is tier two (rule (h)).
 */
export const CONVENTION_VERSIONS = {
  next: "16.3.8",
  typescript: "6.0.3",
} as const;

/**
 * The name tokens of the safety net. A tracked path containing one of these
 * must be classified `control-plane`; the test fails otherwise. This is not a
 * judgement -- it is how a forgotten classification gets noticed.
 */
export const CONTROL_PLANE_NAME_TOKENS = [
  "agent",
  "engineeringagent",
  "engineering-agent",
  "amux",
  "orchestrator",
] as const;

/**
 * Control-plane patterns. `**` spans directories, `*` stays within one path
 * segment. Grouped by the policy's reason so the next reader can check each
 * group against §4 rather than trust the list.
 */
export const CONTROL_PLANE_PATTERNS: readonly string[] = [
  // §4-1: values whose authority belongs to a person.
  "lib/modelPricing.ts",
  "lib/models.ts",
  "lib/modelRegistryShared.ts",
  "lib/billingPriceCatalog.ts",
  "lib/appDefaults.ts",
  "lib/conversationProduct.ts",
  "docs/release-gates/**",
  "prisma/**",
  // §4-2: the execution environment. Root files and root dot-directories are
  // handled structurally in `classifyPath`.
  ".github/**",
  "scripts/**",
  "config/**",
  // Operator tooling that runs reviewer CLIs (the independent review
  // orchestrator): it decides who reviews whom, so no agent may change it.
  "tools/**",
  // The app side of its status report: the secret check and the one row it may write.
  "lib/reviewOrchestrator*",
  "tests/reviewOrchestrator*",
  "tests/fixtures/review-orchestrator/**",
  // §4-4: policy and contract documents.
  "docs/policy/**",
  "docs/ui-contracts/**",
  "docs/ops/cross-review/**",
  // §4-4: this agent's own gates, state, authentication, publishing and
  // registration, and the tests that pin them.
  "lib/agent*",
  "lib/engineeringAgent*",
  "packages/engineering-agent/**",
  // The services' image and their operating runbook (§8, §12).
  "docker/**",
  "docs/ops/engineering-agent*",
  // The product-research agent's own gates, state and runbook
  // (docs/policy/product-research-agent.md). Its judgement modules decide what
  // may be stored and how a phase window is counted, so no agent may change
  // them -- the same reason the engineering agent cannot change its own.
  "lib/productResearch*",
  "lib/adminMessages/productResearch*",
  "docs/ops/product-research-agent*",
  "tests/productResearch*",
  // The two backlog tests this agent owns, named one by one:
  // tests/issueBacklog.test.mjs is the existing report's own product test, and
  // a glob would take it too.
  "tests/issueBacklogShaMode.test.mjs",
  "tests/issueBacklogPartialClone.test.mjs",
  "tests/agent*",
  "tests/engineeringAgent*",
  "tests/support/engineeringAgentV22PublicationCheckHarness.mjs",
  "tests/**/engineering-agent*",
  "tests/**/agent-digest*",
  "tests/security*",
  // §4-4: administration and authentication.
  "app/api/admin/**",
  "app/(site)/(application)/admin/**",
  "components/admin/**",
  "lib/adminAuditSystemActors.ts",
  "lib/adminAuth*",
  "lib/adminMessages/amux*",
  // The AMUX admin tab status reads the same switches as the AMUX routes.
  "lib/adminAmux*",
  "tests/adminAmux*",
  "lib/adminMessages/engineeringAgent*",
  "lib/adminMessages/agentDigests*",
  // The Agent office's copy, which names the agent teams and what each may do.
  "lib/adminMessages/agentOffice*",
  // §4-4: the whole AMUX execution control plane, and its tests.
  "lib/amux/**",
  "crates/**",
  "apps/**",
  "app/api/internal/**",
  "docs/ops/amux/**",
  // The independent Ubuntu AMUX server is still agent execution code, never tier one.
  "vendor/amux/**",
  "tests/amux*",
  "tests/**/amux*",
  "tests/**/*-amux-*",
  "tests/orchestrator*",
];

/**
 * Product patterns: the only paths that can reach tier one at all, and only
 * after the push policy's other rules have had their say.
 */
export const PRODUCT_PATTERNS: readonly string[] = [
  "app/**",
  "components/**",
  "lib/**",
  "locales/**",
  "packages/**",
  "types/**",
  "tests/**",
  "docs/**",
];

const escapeRegExp = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compiles a manifest pattern. `**` at the end matches everything below the
 * directory; `**` between separators matches zero or more directories; `*`
 * matches within one segment. A trailing `*` directly after a name
 * (`lib/agent*`) also matches deeper paths that start with that name, so a
 * directory named like a forbidden module is forbidden too.
 */
export const compileManifestPattern = (pattern: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("/**/", index)) {
      source += "/(?:.*/)?";
      index += 4;
    } else if (pattern.startsWith("/**", index) && index + 3 === pattern.length) {
      source += "/.*";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      source += index === pattern.length - 1 ? ".*" : "[^/]*";
      index += 1;
    } else {
      source += escapeRegExp(pattern[index]);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
};

const CONTROL_PLANE_MATCHERS = CONTROL_PLANE_PATTERNS.map(compileManifestPattern);
const PRODUCT_MATCHERS = PRODUCT_PATTERNS.map(compileManifestPattern);

/**
 * A repository-relative path in the form Git stores it. Anything else --
 * absolute, backslashes, `.`/`..` segments, empty segments, a `.git` segment,
 * control characters -- is not classifiable and is treated as the worst case
 * by every caller.
 */
export const isCanonicalRepoPath = (path: string) => {
  if (path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  // A lone surrogate is not text: two different ones encode to the same
  // replacement bytes, so two distinct strings would name one Git path.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(path)) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        segment.toLowerCase() !== ".git",
    );
};

export const topLevelDirectory = (path: string): string | null => {
  const slash = path.indexOf("/");
  return slash === -1 ? null : path.slice(0, slash);
};

export const isKnownTopLevel = (path: string) => {
  const top = topLevelDirectory(path);
  return top === null || (KNOWN_TOP_LEVEL_DIRECTORIES as readonly string[]).includes(top);
};

export const classifyPath = (path: string): AuthorityClass => {
  if (!isCanonicalRepoPath(path)) return "unclassified";
  const top = topLevelDirectory(path);
  // Every root-level file is configuration, an entry point or an instruction
  // document; every root dot-directory is tooling.
  if (top === null) return "control-plane";
  if (top.startsWith(".")) return "control-plane";
  if (CONTROL_PLANE_MATCHERS.some((matcher) => matcher.test(path))) {
    return "control-plane";
  }
  if (PRODUCT_MATCHERS.some((matcher) => matcher.test(path))) return "product";
  return "unclassified";
};

export const pathCarriesControlPlaneName = (path: string) => {
  const lower = path.toLowerCase();
  return CONTROL_PLANE_NAME_TOKENS.some((token) => lower.includes(token));
};

/**
 * Constants whose values AGENTS.md reserves for a person. The test checks each
 * is defined in exactly the files listed and that those files are
 * control-plane, so a value moving into a product file fails the build.
 */
export const RESERVED_DECISION_CONSTANTS: ReadonlyArray<{
  name: string;
  definedIn: readonly string[];
}> = [
  {
    name: "PENDING_VERIFIED_PRICE_REGISTER",
    definedIn: ["lib/modelPricing.ts", "scripts/report-issue-backlog-core.mjs"],
  },
  { name: "CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED", definedIn: ["lib/modelPricing.ts"] },
  { name: "STATIC_CATALOG_RECONCILIATION_MODEL_IDS", definedIn: ["lib/modelRegistryShared.ts"] },
  { name: "OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS", definedIn: ["lib/modelRegistryShared.ts"] },
  { name: "RESERVATION_ONLY_RECONCILIATION_MODEL_IDS", definedIn: ["lib/modelRegistryShared.ts"] },
  { name: "DEFAULT_BILLING_PRICE_CATALOG", definedIn: ["lib/billingPriceCatalog.ts"] },
  { name: "DEFAULT_MODEL_ID", definedIn: ["lib/models.ts"] },
  { name: "GUEST_DEFAULT_MODEL_ID", definedIn: ["lib/appDefaults.ts"] },
  { name: "GUEST_BRAND_TRIO_MODEL_IDS", definedIn: ["lib/appDefaults.ts"] },
  { name: "CONVERSATION_PRODUCT_KEYS", definedIn: ["lib/conversationProduct.ts"] },
  { name: "KNOWN_ROLES", definedIn: ["scripts/check-accent-tokens.mjs"] },
  { name: "GUARDED_FILES", definedIn: ["scripts/check-accent-tokens.mjs"] },
];

/**
 * Constants AGENTS.md names that are contracts rather than values reserved for
 * a person: the single table a feature derives from, an error code, a limit a
 * contract states. Their files stay product, so a change to one can reach tier
 * one -- where it is still a pull request a person reviews against the named
 * contract. Listing them here is what makes the coverage test two-way: a new
 * constant named in AGENTS.md fails the build until someone decides which of
 * the two lists it belongs to.
 */
export const AGENTS_NAMED_CONTRACT_CONSTANTS: readonly string[] = [
  "ISSUE_PROBES",
  "GATE_EVIDENCE",
  "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
  "PROVIDER_BUDGET_EXHAUSTED",
  "CHAT_ATTACHMENT_FORMATS",
  "PUBLIC_MESSAGE_ATTACHMENT_SELECT",
  "ARTIFACT_FORMAT_TABLE",
  "REFUSED_ARTIFACT_EXTENSIONS",
  "ARTIFACT_TOOL_CAPABILITIES",
  "ARTIFACT_LIMITS",
  "LOCKED_EMAIL_PURPOSES",
  "IMAGE_INLINE_MODEL_DISCOVERY_LIMIT",
  "CHAT_STARTER_MAX_VISIBLE",
  "CROSS_LOCK_ORDER",
  "DEPLOY_EXCLUDED_PREFIXES",
];
