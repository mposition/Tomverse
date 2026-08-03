/**
 * Phase 3 change policy and Red→Green proof contract. Pure and
 * dependency-free: the GitHub workflow enforces it via
 * scripts/feedback-autofix-policy-check.mjs before a branch is pushed, and
 * the result endpoint re-validates server-side -- the workflow's word is
 * never taken for it.
 *
 * The only automatic eligibility gate in Phase 3 is the deterministic
 * Red→Green proof (docs/policy/trace-feedback-automation.md §9). LLM
 * confidence numbers gate nothing.
 */

export const AUTOFIX_CHANGE_LIMITS = {
  maxFiles: 5,
  maxChangedLines: 300,
} as const;

/** Path prefixes an automated fix may never touch. The pipeline's own files
 * are included: the fix agent must not modify its own guardrails. */
const FORBIDDEN_PATH_PREFIXES = [
  ".github/",
  "prisma/",
  "docs/policy/",
  "scripts/",
  "public/",
  "locales/",
  // Auth / billing / credit / concurrency / identity surfaces
  // (docs/policy §9 exclusion areas). Prefix-matched on purpose: a new file
  // under these trees is as excluded as an existing one.
  "lib/auth",
  "lib/adminAuth",
  "lib/turnstile",
  "lib/stripe",
  "lib/planChange",
  "lib/credit",
  "lib/chatCostGuardrails",
  "lib/chatLimit",
  "lib/modelPricing",
  "lib/imageGenerationPricing",
  "app/api/billing/",
  "app/api/admin/",
  "app/api/auth/",
  "app/api/internal/",
  // The pipeline itself.
  "lib/feedbackAutoFix",
  "lib/errorReportToken",
  "lib/errorReportContract",
  "lib/traceErrorEvidence",
] as const;

const FORBIDDEN_EXACT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "proxy.ts",
  "instrumentation.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "prisma.config.ts",
  "playwright.config.ts",
  "eslint.config.mjs",
  "tsconfig.json",
  "AGENTS.md",
  "CLAUDE.md",
]);

const isTestPath = (path: string) =>
  path.startsWith("tests/") ||
  path.includes(".test.") ||
  path.includes(".spec.");

export type AutoFixChangedFile = {
  path: string;
  addedLines: number;
  removedLines: number;
  /** "modified" | "added" | "deleted" as reported by git. */
  changeKind: string;
};

export type AutoFixChangePolicyResult =
  | { allowed: true; changedLines: number }
  | { allowed: false; violations: string[] };

/**
 * Validates a proposed change manifest. The manifest is produced from the
 * actual git diff by the workflow -- and recomputed there, never taken from
 * the fix agent's own report.
 */
export const evaluateAutoFixChangePolicy = (
  files: AutoFixChangedFile[]
): AutoFixChangePolicyResult => {
  const violations: string[] = [];
  if (files.length === 0) {
    violations.push("the change set is empty");
  }
  if (files.length > AUTOFIX_CHANGE_LIMITS.maxFiles) {
    violations.push(
      `${files.length} files changed (limit ${AUTOFIX_CHANGE_LIMITS.maxFiles})`
    );
  }
  let changedLines = 0;
  let hasNewTest = false;
  for (const file of files) {
    changedLines += file.addedLines + file.removedLines;
    const path = file.path;
    if (path.includes("..") || path.startsWith("/")) {
      violations.push(`suspicious path: ${path}`);
      continue;
    }
    if (FORBIDDEN_EXACT_FILES.has(path)) {
      violations.push(`forbidden file: ${path}`);
      continue;
    }
    const prefix = FORBIDDEN_PATH_PREFIXES.find((entry) =>
      path.startsWith(entry)
    );
    // Tests for excluded modules stay allowed; the product paths do not.
    if (prefix && !isTestPath(path)) {
      violations.push(`forbidden path (${prefix}): ${path}`);
      continue;
    }
    if (isTestPath(path)) {
      if (file.changeKind === "deleted") {
        violations.push(`a test file was deleted: ${path}`);
      } else if (file.changeKind === "added" || file.addedLines > 0) {
        hasNewTest = true;
      }
    }
  }
  if (changedLines > AUTOFIX_CHANGE_LIMITS.maxChangedLines) {
    violations.push(
      `${changedLines} changed lines (limit ${AUTOFIX_CHANGE_LIMITS.maxChangedLines})`
    );
  }
  if (!hasNewTest) {
    violations.push(
      "no test was added or extended -- the Red→Green proof requires one"
    );
  }
  return violations.length > 0
    ? { allowed: false, violations }
    : { allowed: true, changedLines };
};

/** Patterns that silently weaken tests. Applied to the unified diff's added
 * lines by the workflow, and pinned here so both sides agree. */
export const FORBIDDEN_ADDED_LINE_PATTERNS: readonly RegExp[] = [
  /\btest\.skip\b/,
  /\bdescribe\.skip\b/,
  /\bit\.skip\b/,
  /\btest\.only\b/,
  /\bdescribe\.only\b/,
  /\bit\.only\b/,
  /\btest\.fixme\b/,
  /toMatchSnapshot\s*\(/,
];

export type RedGreenProof = {
  /** The test file the proof ran. Must be inside the change set. */
  testPath: string;
  /** git SHA of the clean base the red run executed on. */
  baseSha: string;
  /** git SHA of the fixed head the green run executed on. */
  headSha: string;
  red: {
    exitCode: number;
    /** True when the failure was an assertion, not a syntax/import/fixture
     * error. Classified by the runner from the test output. */
    assertionFailure: boolean;
  };
  green: { exitCode: number };
};

export type RedGreenVerdict =
  | { proven: true }
  | { proven: false; reason: string };

export const evaluateRedGreenProof = (
  proof: RedGreenProof,
  changedFiles: AutoFixChangedFile[]
): RedGreenVerdict => {
  if (!proof.testPath || !isTestPath(proof.testPath)) {
    return { proven: false, reason: "the proof does not name a test file" };
  }
  if (!changedFiles.some((file) => file.path === proof.testPath)) {
    return {
      proven: false,
      reason: "the proven test is not part of the change set",
    };
  }
  if (!proof.baseSha || !proof.headSha || proof.baseSha === proof.headSha) {
    return {
      proven: false,
      reason: "red and green must run on distinct base/head commits",
    };
  }
  if (proof.red.exitCode === 0) {
    return {
      proven: false,
      reason: "the test already passes on the clean base (already fixed?)",
    };
  }
  if (!proof.red.assertionFailure) {
    return {
      proven: false,
      reason:
        "the red run did not fail on an assertion (syntax/import/fixture failures do not count)",
    };
  }
  if (proof.green.exitCode !== 0) {
    return { proven: false, reason: "the test still fails on the fixed head" };
  }
  return { proven: true };
};
