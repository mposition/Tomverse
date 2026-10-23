// GENERATED from lib/agentAuthorityFiles.ts by `npm run generate:auto-rec-authority`. Do not edit.
// The auto-rec runner's host node cannot import TypeScript; see scripts/generate-auto-rec-authority.mjs.
const AUTHORITY_MANIFEST_VERSION = 1;
const AUTHORITY_CLASSES = ["product", "control-plane", "unclassified"];
const KNOWN_TOP_LEVEL_DIRECTORIES = [
  ".claude",
  ".codex",
  ".github",
  ".railway",
  ".superpowers",
  ".tmp",
  "app",
  "apps",
  "bin",
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
  "vendor"
];
const CONVENTION_VERSIONS = {
  next: "16.3.8",
  typescript: "6.0.3"
};
const CONTROL_PLANE_NAME_TOKENS = [
  "agent",
  "engineeringagent",
  "engineering-agent",
  "amux",
  "orchestrator"
];
const CONTROL_PLANE_PATTERNS = [
  // §4-1: values whose authority belongs to a person.
  "lib/modelPricing.ts",
  "lib/models.ts",
  "lib/modelRegistryShared.ts",
  "lib/billingPriceCatalog.ts",
  "lib/appDefaults.ts",
  "lib/conversationProduct.ts",
  // The marketing LLM cost ledger's price pins and cap ceiling (marketing
  // policy v4): a price is a person's decision here as in modelPricing.ts.
  "lib/marketingLlmBudgetCore.ts",
  // The official hosts a market fact may cite (S3f): which competitor and which
  // host is a person's decision about content.
  "lib/marketingIntelReportCore.ts",
  "docs/release-gates/**",
  "prisma/**",
  // §4-2: the execution environment. Root files and root dot-directories are
  // handled structurally in `classifyPath`.
  ".github/**",
  "bin/**",
  "scripts/**",
  "config/**",
  // Operator tooling that runs reviewer CLIs (the independent review
  // orchestrator): it decides who reviews whom, so no agent may change it.
  "tools/**",
  // The app side of its status report: the secret check and the one row it may write.
  "lib/reviewOrchestrator*",
  "tests/reviewOrchestrator*",
  "tests/fixtures/review-orchestrator/**",
  // The app side of the Auto router coding agent on the Ubuntu runner: the
  // bearer-secret check, the claim and result it may write, and its system
  // audit writer. An agent changing them could widen its own permission.
  "lib/autoRouterRecAgent*",
  "tests/autoRouterRecAgent*",
  // §4-4: policy and contract documents.
  "docs/policy/**",
  "docs/ui-contracts/**",
  "docs/ops/cross-review/**",
  // The per-area agent instructions AGENTS.md indexes (moved out of the root
  // AGENTS.md on 2026-10-19); a root file was control-plane on its own terms.
  "docs/agents/**",
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
  "tests/support/engineeringAgentPrObserverHarness.mjs",
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
  "lib/chatUnifiedOptimizerAmux*",
  "crates/**",
  "apps/**",
  "app/api/internal/**",
  "docs/ops/amux/**",
  // The independent Ubuntu AMUX server is still agent execution code, never tier one.
  "vendor/amux/**",
  "tests/amux*",
  "tests/chatUnifiedOptimizerAmux*",
  "tests/**/amux*",
  "tests/**/*-amux-*",
  "tests/verifyAmuxWslGitTransfer.test.mjs",
  "tests/orchestrator*"
];
const PRODUCT_PATTERNS = [
  "app/**",
  "components/**",
  "lib/**",
  "locales/**",
  "packages/**",
  "types/**",
  "tests/**",
  "docs/**"
];
const escapeRegExp = (value) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const compileManifestPattern = (pattern) => {
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
const isCanonicalRepoPath = (path) => {
  if (path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(path)) {
    return false;
  }
  return path.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git"
  );
};
const topLevelDirectory = (path) => {
  const slash = path.indexOf("/");
  return slash === -1 ? null : path.slice(0, slash);
};
const isKnownTopLevel = (path) => {
  const top = topLevelDirectory(path);
  return top === null || KNOWN_TOP_LEVEL_DIRECTORIES.includes(top);
};
const classifyPath = (path) => {
  if (!isCanonicalRepoPath(path)) return "unclassified";
  const top = topLevelDirectory(path);
  if (top === null) return "control-plane";
  if (top.startsWith(".")) return "control-plane";
  if (CONTROL_PLANE_MATCHERS.some((matcher) => matcher.test(path))) {
    return "control-plane";
  }
  if (PRODUCT_MATCHERS.some((matcher) => matcher.test(path))) return "product";
  return "unclassified";
};
const pathCarriesControlPlaneName = (path) => {
  const lower = path.toLowerCase();
  return CONTROL_PLANE_NAME_TOKENS.some((token) => lower.includes(token));
};
const RESERVED_DECISION_CONSTANTS = [
  {
    name: "PENDING_VERIFIED_PRICE_REGISTER",
    definedIn: ["lib/modelPricing.ts", "scripts/report-issue-backlog-core.mjs"]
  },
  { name: "CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED", definedIn: ["lib/modelPricing.ts"] },
  { name: "MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL", definedIn: ["lib/marketingLlmBudgetCore.ts"] },
  { name: "STATIC_CATALOG_RECONCILIATION_MODEL_IDS", definedIn: ["lib/modelRegistryShared.ts"] },
  { name: "OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS", definedIn: ["lib/modelRegistryShared.ts"] },
  { name: "RESERVATION_ONLY_RECONCILIATION_MODEL_IDS", definedIn: ["lib/modelRegistryShared.ts"] },
  { name: "DEFAULT_BILLING_PRICE_CATALOG", definedIn: ["lib/billingPriceCatalog.ts"] },
  { name: "DEFAULT_MODEL_ID", definedIn: ["lib/models.ts"] },
  { name: "GUEST_DEFAULT_MODEL_ID", definedIn: ["lib/appDefaults.ts"] },
  { name: "GUEST_BRAND_TRIO_MODEL_IDS", definedIn: ["lib/appDefaults.ts"] },
  { name: "CONVERSATION_PRODUCT_KEYS", definedIn: ["lib/conversationProduct.ts"] },
  { name: "KNOWN_ROLES", definedIn: ["scripts/check-accent-tokens.mjs"] },
  { name: "GUARDED_FILES", definedIn: ["scripts/check-accent-tokens.mjs"] }
];
const AGENTS_NAMED_CONTRACT_CONSTANTS = [
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
  "DEPLOY_EXCLUDED_PREFIXES"
];
export {
  AGENTS_NAMED_CONTRACT_CONSTANTS,
  AUTHORITY_CLASSES,
  AUTHORITY_MANIFEST_VERSION,
  CONTROL_PLANE_NAME_TOKENS,
  CONTROL_PLANE_PATTERNS,
  CONVENTION_VERSIONS,
  KNOWN_TOP_LEVEL_DIRECTORIES,
  PRODUCT_PATTERNS,
  RESERVED_DECISION_CONSTANTS,
  classifyPath,
  compileManifestPattern,
  isCanonicalRepoPath,
  isKnownTopLevel,
  pathCarriesControlPlaneName,
  topLevelDirectory
};
