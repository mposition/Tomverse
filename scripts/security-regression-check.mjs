import { readdirSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const WORKFLOW_DIR = ".github/workflows";

const workflowFiles = () =>
  readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => `${WORKFLOW_DIR}/${name}`);

/**
 * Lines a workflow file may start in column 0: a top-level key, a document
 * marker, a comment, or nothing.
 *
 * Anything else there is almost always a `run: |` block whose continuation
 * was not indented -- an easy edit to make in a long shell step, and one with
 * no local symptom whatsoever. GitHub does not reject the file; it registers
 * the workflow under its *filename*, with no name and no triggers, so
 * dispatching it answers `422 Workflow does not have 'workflow_dispatch'
 * trigger` as though it had never been added. Substring assertions about a
 * workflow's contents all keep passing while it is dead.
 */
const UNINDENTED_LINE_IS_ALLOWED = /^(["']?[A-Za-z_][\w.-]*["']?:|#|---|\.\.\.)/;

const unparseableWorkflowLines = (source) =>
  source
    .split("\n")
    .map((line, number) => ({ line, number: number + 1 }))
    // Indented lines belong to whatever block they are in; only a line that
    // starts in column 0 claims to be top-level, and only that claim can be
    // wrong in the way this catches.
    .filter(({ line }) => /^\S/.test(line))
    .filter(({ line }) => !UNINDENTED_LINE_IS_ALLOWED.test(line));

/**
 * The workflow-level `concurrency:` block and nothing else -- from the
 * top-level key to the next line in column 0.
 *
 * Substring-matching the whole file cannot be used here: the settings are the
 * kind that want a comment explaining them, and a comment naturally quotes the
 * value it is warning against. `.github/workflows/e2e.yml` documents that
 * `queue: max` with `cancel-in-progress: true` is a validation error, which a
 * file-wide match reads as the workflow *having* `cancel-in-progress: true`.
 */
const workflowConcurrencyBlock = (source) => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^concurrency:\s*$/.test(line));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
};

/**
 * `mobile-composer-contract.spec.ts` gates only its goldens on the canonical
 * browser; its 30 geometry and behaviour tests must keep running on a
 * substitute one. That distinction lives in *where* the gate is called, which a
 * whole-file substring match cannot see.
 */
const composerGateIsScopedToTheVisualBlock = () => {
  const source = read("tests/e2e/mobile-composer-contract.spec.ts");
  const blockAt = source.indexOf(
    'test.describe("Mobile composer: visual record"'
  );
  if (blockAt < 0) return false;
  const beforeBlock = source.slice(0, blockAt);
  const insideBlock = source.slice(blockAt);
  return (
    insideBlock.includes("test.beforeEach(skipUnlessCanonicalVisualBrowser)") &&
    // An import is not a call; anything that invokes it above the block would
    // apply the skip to the whole file.
    !/skipUnlessCanonicalVisualBrowser\s*\)/.test(
      beforeBlock.replace(/^import[\s\S]*?;$/m, "")
    ) &&
    !beforeBlock.includes("skipUnlessCanonicalVisualBrowser()")
  );
};

/**
 * The chat-state goldens reach the gate through their capture helper, not
 * through a `test.beforeEach`.
 *
 * Same rule as `composerGateIsScopedToTheVisualBlock`, arrived at the other way
 * round: that spec keeps its behavioural tests outside a gated describe block,
 * this one has them interleaved with goldens, so the only placement that can
 * gate captures without gating behaviour is the capture itself.
 *
 * Asserted as "in the capture and in no beforeEach" rather than as a substring
 * anywhere, because the file-wide `beforeEach` this replaced satisfied a
 * substring check perfectly while skipping 18 behavioural tests.
 */
const chatStateGateIsAtTheCapture = () => {
  const fixtures = read("tests/e2e/support/chat-state-fixtures.ts");
  const captureAt = fixtures.indexOf(
    "export async function expectStableScreenshot"
  );
  if (captureAt < 0) return false;
  if (!fixtures.slice(captureAt).includes("skipUnlessCanonicalVisualBrowser()")) {
    console.error(
      "expectStableScreenshot no longer calls skipUnlessCanonicalVisualBrowser -- the chat-state goldens are ungated."
    );
    return false;
  }
  const spec = read("tests/e2e/chat-state-visual-regression.spec.ts");
  for (const match of spec.matchAll(/test\.beforeEach\(([\s\S]*?)\n\}\);/g)) {
    if (match[1].includes("skipUnlessCanonicalVisualBrowser(")) {
      console.error(
        "chat-state-visual-regression.spec.ts gates the whole file in beforeEach again -- that skips its 18 screenshot-free tests too."
      );
      return false;
    }
  }
  return true;
};

/**
 * The back-merge fallback step must refuse a conflict before it can push
 * anything: an unresolved index means bail out and fail, and only a clean
 * replay reaches `git push`. Expressed as an ordering rather than a presence
 * check, because presence is what a duplicated string satisfies by accident.
 */
const conflictExitsBeforeAnyPush = (backMergeJob) => {
  const stepAt = backMergeJob.indexOf(
    "- name: Open a pull request when the push was refused, or fail on a conflict"
  );
  if (stepAt < 0) return false;
  const step = backMergeJob.slice(stepAt);
  const detectsConflict = step.indexOf("git ls-files --unmerged");
  const aborts = step.indexOf("git merge --abort");
  const exits = step.indexOf("exit 1");
  const pushes = step.indexOf("git push");
  return (
    detectsConflict >= 0 &&
    aborts > detectsConflict &&
    exits > detectsConflict &&
    pushes > exits
  );
};

const checks = [
  {
    name: "Next.js X-Powered-By header is disabled",
    file: "next.config.ts",
    test: (source) => /poweredByHeader:\s*false/.test(source),
  },
  {
    name: "CSP script policy uses nonces",
    file: "lib/csp.ts",
    test: (source) =>
      source.includes("script-src 'self' 'nonce-${nonce}' 'strict-dynamic'"),
  },
  {
    name: "CSP style policy uses nonces without production unsafe-inline",
    file: "lib/csp.ts",
    test: (source) =>
      source.includes("style-src 'self' 'nonce-${nonce}'") &&
      source.includes('isDevelopment ? " \'unsafe-inline\'" : ""'),
  },
  {
    name: "Host protection runs through proxy",
    file: "proxy.ts",
    test: (source) =>
      source.includes("isAllowedRequestHost") &&
      source.includes("hasRequiredOriginSecret") &&
      source.includes("Misdirected Request"),
  },
  {
    name: "Client IP uses trusted proxy header fallback",
    file: "lib/clientIp.ts",
    test: (source) =>
      source.includes("TRUSTED_PROXY_IP_HEADER") &&
      source.includes("x-real-ip") &&
      source.includes("cf-connecting-ip"),
  },
  {
    name: "/api/chat rejects inline attachment data",
    file: "app/api/chat/route.ts",
    test: (source) =>
      source.includes("INLINE_ATTACHMENT_FORBIDDEN") &&
      !source.includes('} else if (typeof attachment.data === "string")'),
  },
  {
    name: "/api/chat rejects unsupported system role from clients",
    file: "lib/chatSecurity.ts",
    test: (source) =>
      source.includes('candidate.role !== "user"') &&
      source.includes('candidate.role !== "assistant"') &&
      !source.includes('candidate.role !== "system"') &&
      !source.includes('"user" | "assistant" | "system"'),
  },
  {
    name: "/api/chat has guest verification and model access checks",
    file: "app/api/chat/route.ts",
    test: (source) =>
      source.includes("assertModelAccess(access, modelConfig)") &&
      source.includes("getUserBillingPlan") &&
      source.includes("ensureGuestVerified"),
  },
  {
    name: "/api/chat treats retired models and empty provider streams as failures",
    file: "app/api/chat/route.ts",
    test: (source) =>
      source.includes('"MODEL_RETIRED"') &&
      source.includes("const isEmptyResponse = !generatedText.trim()") &&
      source.includes('"AI_EMPTY_RESPONSE"') &&
      source.indexOf("if (isEmptyResponse)") <
        source.indexOf("await recordProviderSuccess"),
  },
  {
    name: "Chat usage limits reserve tokens, cost, provider budget, and lease",
    file: "lib/chatSecurity.ts",
    test: (source) => {
      const guardrails = read("lib/chatCostGuardrails.ts");
      return (
        source.includes("CHAT_USER_TOKENS_PER_DAY") &&
        source.includes("getChatCostGuardrails") &&
        // Plan-funded and total cost are separate buckets, so purchased
        // credits are not blocked twice by a plan-shaped ceiling.
        source.includes('period: "cost-day"') &&
        source.includes('period: "op-cost-day"') &&
        source.includes('period: "op-cost-month"') &&
        source.includes("provider-cost-month") &&
        source.includes("ChatRequestLease") &&
        // The retired per-user USD entitlement ceilings must stay unread.
        !source.includes("CHAT_FREE_COST_MICROUSD_PER_DAY") &&
        !source.includes("CHAT_PRO_COST_MICROUSD_PER_DAY") &&
        !source.includes("CHAT_MAX_COST_MICROUSD_PER_DAY") &&
        // A guardrail override below the derived floor is clamped, not honoured.
        guardrails.includes("clampedOverrides") &&
        guardrails.includes("COST_PER_CREDIT_CEILING_MICRO_USD")
      );
    },
  },
  {
    name: "Internal cost figures never reach an end-user response",
    file: "lib/chatSecurity.ts",
    test: (source) => {
      const decisions = read("lib/chatLimitDecisionCore.ts");
      return (
        // Guardrail diagnostics are prefixed `internal` and stripped on the
        // way out; they survive only in the limit-decision event and logs.
        source.includes("publicChatErrorDetails") &&
        source.includes('!key.startsWith("internal")') &&
        source.includes("internalLimitCostMicroUsd") &&
        // Limit decisions record the hashed usage subject, never prompt text.
        decisions.includes("subjectKey") &&
        !decisions.includes("promptText") &&
        // A reset instant handed to a blocked user is always in the future.
        // The record side has always been guarded; so is the response side,
        // at the one exit point every ChatAccessError passes through, which
        // re-checks the instant against the moment the response is built.
        decisions.includes("futureResetAt") &&
        decisions.includes("withFutureResetAt") &&
        source.includes("withFutureResetAt(details, now)") &&
        // Daily boundaries come from a stored time zone and can go stale, so
        // they reach the caller rolled forward rather than raw -- the same
        // instant the decision record carries.
        source.includes("safeDailyResetAt") &&
        !/resetAt:\s*\w*[Dd]ayWindow\.end\.toISOString\(\)/.test(source)
      );
    },
  },
  {
    name: "R2 reads validate metadata before bounded streaming",
    file: "lib/r2.ts",
    test: (source) =>
      source.includes("HeadObjectCommand") &&
      source.includes("IfMatch: head.ETag") &&
      source.includes("totalBytes > options.maxBytes") &&
      source.includes("deleteInvalidObject"),
  },
  {
    name: "OAuth account tokens are encrypted before adapter storage",
    file: "lib/auth.ts",
    test: (source) =>
      source.includes("encryptOAuthAccountTokens") &&
      source.includes("strategy: \"jwt\"") &&
      source.includes("maxAge: SESSION_MAX_AGE_SECONDS"),
  },
  {
    name: "Existing OAuth tokens are encrypted by maintenance cleanup",
    file: "lib/maintenance.ts",
    test: (source) =>
      source.includes("encryptExistingOAuthTokens") &&
      source.includes("oauthTokensEncrypted") &&
      source.includes("cursor: { id: cursor }") &&
      source.includes("OAUTH_ACCOUNT_BATCH_SIZE") &&
      source.includes("OAUTH_TOKEN_ENCRYPTED_PREFIX"),
  },
  {
    name: "OAuth token encryption requires a dedicated key",
    file: "lib/oauthTokenCrypto.ts",
    test: (source) =>
      source.includes("process.env.OAUTH_TOKEN_ENCRYPTION_KEY") &&
      !source.includes("process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET"),
  },
  {
    name: "Azure OAuth requires complete configuration without dangerous email linking",
    file: "lib/auth.ts",
    test: (source) =>
      source.includes("hasCompleteAzureConfiguration") &&
      source.includes("process.env.AZURE_AD_CLIENT_ID") &&
      source.includes("process.env.AZURE_AD_CLIENT_SECRET") &&
      source.includes("process.env.AZURE_AD_TENANT_ID") &&
      !source.includes("allowDangerousEmailAccountLinking: true"),
  },
  {
    name: "Production readiness accepts complete public Azure OAuth configuration",
    file: "lib/securityEnvironment.ts",
    test: (source) =>
      source.includes("azureOAuthConfiguration") &&
      source.includes("configured(azureClientId)") &&
      source.includes("configured(azureClientSecret)") &&
      source.includes("configured(azureTenant)") &&
      !source.includes("azureTenantIsGeneric"),
  },
  {
    name: "Provider credit updates require billing permission and audit logging",
    file: "app/api/admin/provider-credits/route.ts",
    test: (source) =>
      source.includes('hasAdminPermission(session, "billing:write")') &&
      source.includes("readLimitedJson") &&
      source.includes("getProviderBillingProfiles") &&
      source.includes('settlementModel !== "prepaid"') &&
      source.includes('settlementModel !== "hybrid"') &&
      source.includes("setProviderCreditCheckpoint") &&
      source.includes("writeAdminAuditLog") &&
      source.includes('action: "provider_credit.checkpoint_updated"'),
  },
  {
    name: "Provider billing profile updates are validated, authorized, and audited",
    file: "app/api/admin/provider-billing/route.ts",
    test: (source) =>
      source.includes('hasAdminPermission(session, "billing:write")') &&
      source.includes("readLimitedJson") &&
      source.includes("setProviderBillingProfile") &&
      source.includes("consumeApiRateLimit") &&
      source.includes('action: "provider_billing.profile_updated"'),
  },
  {
    name: "Provider billing defaults distinguish Mistral hybrid settlement",
    file: "lib/providerBilling.ts",
    test: (source) =>
      source.includes('mistral: defaultProfile("usage_based", "hybrid")') &&
      source.includes('groq: defaultProfile("usage_based", "postpaid")') &&
      source.includes('source: "documented_default"'),
  },
  {
    name: "Provider credit controls are limited to prepaid and hybrid profiles",
    file: "components/admin/AdminProviderHealthPanel.tsx",
    test: (source) =>
      source.includes('provider.billingProfile.settlementModel === "prepaid"') &&
      source.includes('provider.billingProfile.settlementModel === "hybrid"') &&
      source.includes("{tracksCredit && (") &&
      source.includes("Projected month-end"),
  },
  {
    name: "OpenAI usage reconciliation requires a dedicated bounded Admin API adapter",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes("OPENAI_ADMIN_API_KEY") &&
      source.includes('https://api.openai.com/v1/organization/costs') &&
      source.includes("openAiCostsRequestPolicy") &&
      source.includes("AbortSignal.timeout(requestPolicy.attemptTimeoutMs)") &&
      source.includes("isRetryableOpenAiStatus") &&
      source.includes("MAX_EXTERNAL_RESPONSE_BYTES") &&
      source.includes("MAX_OPENAI_PAGES") &&
      source.includes('source: "openai_costs"') &&
      source.includes('console.warn("Provider usage sync failed"'),
  },
  {
    name: "OpenAI usage retry duration and attempts remain bounded",
    file: "lib/providerUsageSyncCore.ts",
    test: (source) =>
      source.includes("OPENAI_COSTS_DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000") &&
      source.includes("OPENAI_COSTS_DEFAULT_MAX_ATTEMPTS = 3") &&
      source.includes("maximum: 60_000") &&
      source.includes("maximum: 3") &&
      source.includes("isRetryableOpenAiStatus"),
  },
  {
    name: "Anthropic usage reconciliation uses the dedicated Admin Cost API adapter",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes("ANTHROPIC_ADMIN_API_KEY") &&
      source.includes("https://api.anthropic.com/v1/organizations/cost_report") &&
      source.includes('"x-api-key": adminKey') &&
      source.includes('"anthropic-version": "2023-06-01"') &&
      source.includes("anthropicCostsUrl") &&
      source.includes("parseAnthropicCostsPage") &&
      source.includes("MAX_ANTHROPIC_PAGES") &&
      source.includes('source: "anthropic_costs"') &&
      source.includes('case "anthropic"'),
  },
  {
    name: "Perplexity usage sync exposes exact response cost accounting instead of skipped",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes("const perplexityInternalUsage") &&
      source.includes('usageSourceLabel: "Exact response cost accounting"') &&
      source.includes('case "perplexity"') &&
      source.includes("return perplexityInternalUsage(date)"),
  },
  {
    name: "xAI usage reconciliation uses the dedicated Management Usage adapter",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes("XAI_MANAGEMENT_API_KEY") &&
      source.includes("XAI_TEAM_ID") &&
      source.includes("https://management-api.x.ai/v1/billing/teams") &&
      source.includes('method: "POST"') &&
      source.includes("xaiUsageDayRequest") &&
      source.includes("parseXaiUsage") &&
      source.includes('source: "xai_usage"') &&
      source.includes('case "xai"'),
  },
  {
    name: "Mistral response Usage preserves cached tokens and request-time pricing",
    file: "lib/chatSecurity.ts",
    test: (source) =>
      source.includes(
        "cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier"
      ) &&
      source.includes("usage.cachedInputTokens") &&
      source.includes("pricingSnapshot: {") &&
      source.includes("...costBreakdown,") &&
      // The rate a reservation was priced at is frozen with it, so a later
      // price change never re-settles an existing reservation.
      source.includes("pricingVersion: canonical.pricingVersion") &&
      source.includes("settledCachedInputTokens"),
  },
  {
    name: "Zhipu uses cached-token pricing and internal credit accounting",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes("zhipuInternalUsage") &&
      source.includes('const provider: AiProvider = "zhipu"') &&
      source.includes('status: "internal"') &&
      source.includes("cachedInputTokens: usage.cachedInputTokens") &&
      source.includes("Official balance and daily cost APIs unavailable"),
  },
  {
    name: "Moonshot uses response accounting when daily cost reconciliation is unavailable",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes("moonshotInternalUsage") &&
      source.includes('const provider: AiProvider = "moonshot"') &&
      source.includes("live balance is monitored separately") &&
      source.includes('case "moonshot"') &&
      source.includes("hasGenericUsageEndpoint(provider, date)"),
  },
  {
    name: "DeepSeek response Usage replaces a missing aggregate cost API",
    file: "lib/providerUsageSync.ts",
    test: (source) => {
      const model = read("lib/activeAiModel.ts");
      const adapter = read("lib/deepseekUsageAdapterCore.ts");
      return (
        source.includes("deepseekInternalUsage") &&
        source.includes('const provider: AiProvider = "deepseek"') &&
        source.includes('case "deepseek"') &&
        source.includes("DeepSeek Usage export") &&
        model.includes("deepseekUsageFetch") &&
        adapter.includes("prompt_cache_hit_tokens") &&
        adapter.includes("prompt_tokens_details") &&
        read("lib/modelPricing.ts").includes('modelId: "deepseek-v4-flash"') &&
        read("lib/modelPricing.ts").includes('modelId: "deepseek-v4-pro"')
      );
    },
  },
  {
    name: "Mistral missing provider reconciliation is reported as internal accounting",
    file: "lib/providerUsageSync.ts",
    test: (source) =>
      source.includes('status: "internal"') &&
      source.includes('usageSourceLabel: "Internal response accounting"') &&
      source.includes(
        'reconciliationLabel: "Unavailable on current Mistral plan"'
      ),
  },
  {
    name: "Provider usage diagnostics are redacted and visible only in Admin UI",
    file: "components/admin/AdminProviderUsageSyncPanel.tsx",
    test: (source) =>
      source.includes("View failure details") &&
      source.includes("Provider request ID") &&
      source.includes("Tomverse trace"),
  },
  {
    name: "Provider health exposes explicit status decision reasons",
    file: "lib/providerMonitoring.ts",
    test: (source) =>
      source.includes("statusReasons") &&
      source.includes("RECENT_PROVIDER_FAILURES") &&
      source.includes("FAILURE_OUTAGE_THRESHOLD") &&
      source.includes("MONTHLY_BUDGET_WARNING"),
  },
  {
    name: "Provider error details are sanitized, bounded, and retained temporarily",
    file: "lib/providerMonitoring.ts",
    test: (source) => {
      // STG-R002: the redaction itself now lives in the shared, pure
      // classification module so the administrator verification path uses the
      // identical rules instead of a second copy that could drift. Both halves
      // are pinned here: the shared redactor must still strip credentials, and
      // providerMonitoring must still route every persisted field through it.
      const classification = read("lib/providerErrorClassification.ts");
      const verification = read("lib/providerVerification.ts");
      return (
        source.includes("providerErrorEvent.create") &&
        source.includes("options.includeErrorEvents") &&
        source.includes("redactProviderText") &&
        source.includes("safeText(event.message, 500)") &&
        source.includes("safeText(event.traceId, 120)") &&
        classification.includes('"Bearer [REDACTED]"') &&
        classification.includes("[REDACTED_KEY]") &&
        verification.includes("redactProviderText(safeErrorMessage(error), 300)")
      );
    },
  },
  {
    name: "Admin provider health explicitly requests detailed error events",
    file: "app/api/admin/provider-health/route.ts",
    test: (source) =>
      source.includes("isAdminSession(session)") &&
      source.includes("includeErrorEvents: true") &&
      source.includes('"Cache-Control": "no-store"'),
  },
  {
    name: "Synthetic provider probe (AUD-R001) is authenticated, bounded, and leaks no secrets",
    file: "app/api/internal/provider-probe/check/route.ts",
    test: (source) => {
      const probe = read("lib/providerProbe.ts");
      const errorClassification = read("lib/providerErrorClassification.ts");
      const cron = read("railway.provider-probe.json");
      const runner = read("scripts/run-provider-probe.mjs");
      return (
        // Constant-time secret comparison, and an unauthenticated request
        // gets an unrevealing 404 rather than 401/403 -- this endpoint must
        // never be discoverable or brute-forceable from outside.
        source.includes("timingSafeEqual") &&
        source.includes("PROVIDER_PROBE_SECRET") &&
        source.includes('{ error: "Not found." }, { status: 404 }') &&
        // The provider list is the server's own fixed registry, never a
        // client-supplied value -- no SSRF-style dynamic provider/endpoint.
        source.includes("MONITORED_PROVIDERS") &&
        // Overlap guard (no duplicate concurrent runs) and a daily cost cap
        // enforced before any provider is called.
        source.includes("OVERLAP_GUARD_MS") &&
        source.includes("probeDailyCostCapMicroUsd") &&
        // Hard per-call timeout, zero internal retries (the next cron tick
        // is the retry, so a flaky provider can't cause a retry storm), and
        // no live provider call outside production without an explicit
        // opt-in -- both required regardless of which internal route calls
        // into lib/providerProbe.ts.
        probe.includes("PROBE_TIMEOUT_MS") &&
        probe.includes("maxRetries: 0") &&
        probe.includes("isLiveProbeEnvironment") &&
        // Failures are classified into a small fixed public-safe vocabulary,
        // never a raw provider message, stack trace, or API key.
        errorClassification.includes("ProbeErrorClassification") &&
        // The Railway cron cadence stays comfortably under the public
        // status page's freshness window, and the trigger script only ever
        // calls this one fixed, HTTPS-enforced endpoint.
        cron.includes('"cronSchedule": "*/10 * * * *"') &&
        runner.includes("/api/internal/provider-probe/check") &&
        runner.includes('protocol !== "https:"')
      );
    },
  },
  {
    // A run whose worker died stays `running` with a lease nobody holds, and
    // the claim is fenced on `leaseGeneration` -- so the lease does not lapse
    // into availability on its own. Only this sweep makes the run claimable
    // again, and it lived unreferenced outside the tests until it was wired
    // here (import/memory policy §11, §11.1).
    name: "Memory extraction leases are reclaimed and re-driven by maintenance",
    file: "lib/maintenance.ts",
    test: (source) =>
      source.includes("dispatchPendingMemoryExtractionRuns") &&
      source.includes("memoryExtractionRuns") &&
      source.includes("memoryExtractionDispatched"),
  },
  {
    // The guard has to bound what the request really sends. A provider-native
    // search adds 6,400 input tokens the raw estimate does not carry, so
    // comparing the estimate let a searching turn sit that far over the limit
    // and fail at the provider -- after a reservation and a dispatched call --
    // instead of here, for free
    // (docs/ops/tomverse-chat-context-window-rollout.md).
    name: "The context-window guard measures the reserved input, not the raw estimate",
    file: "app/api/chat/route.ts",
    test: (source) => {
      const guard = source.slice(
        source.indexOf("fitChatOutputToContextWindow({"),
        source.indexOf("MODEL_CONTEXT_WINDOW_EXCEEDED")
      );
      return (
        guard.includes("reservedInputTokens: budget.inputTokens") &&
        !guard.includes("estimatedInputTokens")
      );
    },
  },
  {
    // The concurrency slot is released deterministically on every unwind, not
    // left to a TTL (docs/policy/chat-concurrency-and-identity.md). Ownership
    // moves once, at the source reader, and the stream cannot free anything
    // until it is pulled -- which only happens once the Response is returned.
    // Anything that throws in between leaves a slot nobody will ever free, and
    // its owner is told a response is already being generated until it lapses.
    name: "A stream that is never published still frees its concurrency slot",
    file: "app/api/chat/route.ts",
    test: (source) => {
      const ownership = read("lib/chatLeaseOwnershipCore.ts");
      return (
        // The failure path asks who holds the slot, rather than reading "the
        // request no longer holds it" as "someone else will free it".
        source.includes("chatLeaseToReleaseOnUnwind(leaseOwnership)") &&
        source.includes("reason: orphanedLease.reason") &&
        !source.includes('reason: "request_failed_before_stream",') &&
        // Published after the Response is constructed, so a throw while
        // building it still unwinds through the branch above.
        /const response = new Response\([\s\S]{0,600}?chatLeaseStreamPublished\(leaseOwnership\);\s*\n\s*return response;/.test(
          source
        ) &&
        ownership.includes('reason: "stream_never_started"')
      );
    },
  },
  {
    // The one unwind outside the handler's try. POST() appends the Turnstile
    // grant cookie to whatever Response the handler produced, and a throw
    // there does not merely lose the answer -- it drops a stream that is still
    // holding a concurrency slot, leaving the fifteen-minute reconciliation as
    // the only thing that frees it. The grant is server-built from a signed
    // token, so a value `Headers` refuses is a bug, and its cost must not be
    // the caller's answer and their slot.
    name: "A rejected grant cookie does not cost the caller their response",
    file: "app/api/chat/route.ts",
    test: (source) => {
      const wrapper = source.slice(
        source.indexOf("export async function POST"),
        source.indexOf("async function handleChatPost")
      );
      return (
        wrapper.includes("try {") &&
        wrapper.includes('response.headers.append("Set-Cookie"') &&
        wrapper.includes("chat_verification_grant_cookie_rejected") &&
        // The append must be inside the try, not merely near one.
        wrapper.indexOf("try {") <
          wrapper.indexOf('response.headers.append("Set-Cookie"') &&
        wrapper.indexOf('response.headers.append("Set-Cookie"') <
          wrapper.indexOf("} catch (error) {")
      );
    },
  },
  {
    // A plan change moves money and credits, and only one of them was quoted.
    // The credit arithmetic has one home (lib/planChangeCredits.ts) so the
    // preview and the steady-state balance cannot drift; nothing imported it.
    // Null for a scheduled downgrade on purpose: it changes nothing about this
    // month, so any number here would be true for nobody yet.
    name: "A plan-change quote states what happens to this month's credits",
    file: "lib/planChangeService.ts",
    test: (source) =>
      source.includes("planCreditsAfterPlanChange") &&
      source.includes('decision.plan.execution === "immediate_upgrade"\n      ? await quoteCredits'),
  },
  {
    // The concurrency policy names rollbackChatAdmission() in step 4 of the
    // admission lifecycle and nothing called it. A preflight that reserves and
    // then fails to answer left every slot held until the admission TTL, so
    // the retry step 6 asks the client to make was refused for concurrency on
    // a subject running nothing.
    name: "A preflight that fails after admission gives the slots back",
    file: "app/api/chat/preflight/route.ts",
    test: (source) =>
      source.includes("grantedAdmissionId = result.admission.admissionId") &&
      source.includes("if (grantedAdmissionId)") &&
      source.includes("rollbackChatAdmission(grantedAdmissionId"),
  },
  {
    // §10's reason for one shared context builder applies to the guard too:
    // preflight prices what chat sends. Without this check preflight quoted
    // credits and reserved a concurrency slot for a model the chat route was
    // always going to refuse, which on a comparison is the partial execution
    // the aggregate admission exists to prevent.
    name: "Preflight refuses a model whose context window cannot hold the request",
    file: "app/api/chat/preflight/route.ts",
    test: (source) => {
      const check = source.indexOf("fitChatOutputToContextWindow({");
      const reserve = source.indexOf("preflightChatComparisonAccess(access, budgets");
      return (
        check !== -1 &&
        reserve !== -1 &&
        // Before the reservation, or a refused comparison still holds slots.
        check < reserve &&
        source.includes("MODEL_CONTEXT_WINDOW_EXCEEDED")
      );
    },
  },
  {
    // A model's settable output ceiling is a capability, not this request's
    // budget. Kimi K3's ceiling is its whole context window, so using it as
    // the fixed output cap refused every request at every input size. The
    // request cap is fitted to the room the window has left, and the fitted
    // figure -- not the profile's -- is what reaches the provider.
    name: "The dispatched output cap is the one fitted to the context window",
    file: "app/api/chat/route.ts",
    test: (source) =>
      source.includes("const requestMaxOutputTokens = outputBudget.outputTokens") &&
      source.includes("maxOutputTokens: requestMaxOutputTokens,") &&
      !source.includes("maxOutputTokens: budget.maxOutputTokens,"),
  },
  {
    // One function owns the reserved-input figure, so the estimator
    // calibration's safety margin and framing overhead cannot be skipped by a
    // caller that adds the tool overhead itself.
    name: "The chat budget derives its reserved input from the active calibration",
    file: "lib/chatSecurity.ts",
    test: (source) =>
      // `estimatedInput`, not `estimatedInputTokens`: the reservation is
      // computed from the whole breakdown, because the calibration widens each
      // character segment by its own margin. Passing the flattened total here
      // would be the same skip this check exists to catch -- it would silently
      // fall back to the largest margin for every request.
      source.includes("toReservedInputTokens(estimatedInput,") &&
      source.includes("toolOverheadTokens: estimateToolInputTokenOverhead"),
  },
  {
    // Class identity belongs to the module instance. A second evaluation of
    // chatSecurity (a bundler boundary, a test harness) gives a second
    // ChatAccessError class, and `instanceof` against the wrong one silently
    // files our own refusal as a provider failure -- bad health data, no
    // error. The owning module answers instead.
    name: "AI Review asks chatSecurity whether a failure was its own refusal",
    file: "lib/comparisonReviewService.ts",
    test: (source) =>
      source.includes("isChatAccessError(error)") &&
      !source.includes("instanceof ChatAccessError"),
  },
  {
    // §8.4 requires the server to establish evidence existence, ownership and
    // a matching content digest. The check was written and never called: the
    // label map is built when the chunk is claimed, and a source deleted
    // during the provider call then fails the evidence insert's foreign key
    // and takes the whole chunk down instead of dropping the candidate.
    name: "Extraction evidence is re-verified at write time",
    file: "lib/memoryExtractionPersistence.ts",
    test: (source) =>
      source.includes("verifyExternalMessageEvidence") &&
      source.includes("unsourced"),
  },
  {
    // An attempt whose request went out and never settled holds its
    // reservation forever while nothing records that the call finished. The
    // sweep lived unreferenced outside its tests until it was wired here
    // (policy §3, §11 "idempotent settlement").
    name: "Unsettled extraction provider calls are reconciled by maintenance",
    file: "app/api/internal/maintenance/credit-reservations/route.ts",
    test: (source) =>
      source.includes("reconcileUnsettledExtractionProviderCalls") &&
      source.includes("memoryExtractionProviderCalls"),
  },
  {
    // `npm run check:model-pricing` proves the priced-premium rule about the
    // compiled catalogue at CI time, but ModelRegistryEntry is what prices a
    // real request and an administrator writes to it long after CI ran. The
    // rule is enforced in the shared zod refinement, so create, update and the
    // validate endpoint all get it from one place.
    name: "An unpriced premium model cannot be enabled through the registry",
    file: "lib/modelRegistryAdmin.ts",
    test: (source) => {
      const pricingDbCheck = read("scripts/check-model-pricing-db.mjs");
      return (
        source.includes("findUnpricedModels") &&
        source.includes("unpricedPremiumMessage(candidate)") &&
        // Both schemas go through refineModelInput, which is where the rule
        // lives; a per-route check is how a fourth write path escapes it.
        source.includes("createModelRegistrySchema = refineModelInput") &&
        source.includes("updateModelRegistrySchema = refineModelInput") &&
        pricingDbCheck.includes("assertPricedPremiumModels")
      );
    },
  },
  {
    // `enforceUserOperationalSecurity` lived in chatSecurity.ts and nowhere
    // else, so an account an administrator had suspended, restricted or
    // scheduled for deletion was still free to generate images and run memory
    // extractions -- both of which call a provider and charge credits. Every
    // paid AI entry point goes through the one gate.
    name: "Every paid AI entry point refuses an account put out of bounds",
    file: "lib/chatSecurity.ts",
    test: (source) => {
      const image = read("lib/imageGenerationService.ts");
      const extraction = read("lib/memoryExtractionService.ts");
      return (
        source.includes("export const assertUserOperationalAccess") &&
        source.includes("enforceUserOperationalSecurity") &&
        // Both the first request and the retry: a retry is a fresh provider
        // call on a fresh reservation, not an inherited permission.
        image.split("assertUserOperationalAccess(input.userId)").length === 3 &&
        extraction.includes("assertUserOperationalAccess(input.userId)")
      );
    },
  },
  {
    // The refusal carries its own 403 and code. Falling through to the route's
    // generic handler would tell a suspended account the server broke.
    name: "The extraction route answers an account refusal with its own status",
    file: "app/api/memories/extraction-runs/route.ts",
    test: (source) => source.includes("chatErrorResponse(error)"),
  },
  {
    // The route makes two unguarded Stripe calls and one catch handles both.
    // It assumed the Session, so a customers.create failure was reported as
    // CHECKOUT_SESSION_CREATE_FAILED at stage "session" -- an operator sent to
    // a call that never ran.
    name: "A checkout failure names the Stripe call that actually failed",
    file: "app/api/billing/checkout/route.ts",
    test: (source) =>
      source.includes("class CheckoutStripeCallError") &&
      source.includes('throw new CheckoutStripeCallError("customer"') &&
      source.includes("checkoutStripeCallFailure(") &&
      // The assumption this replaced. Its return would be a silent regression.
      !source.includes('stage: "session",'),
  },
  {
    // Deleting one conversation enqueued its generated images for removal from
    // object storage; deleting the account did not. The cascade runs
    // User -> Conversation -> ImageGeneration -> ImageAsset, and ImageAsset
    // holds the only record of the R2 key, so the tombstone has to be written
    // before the cascade and inside the same transaction -- afterwards the
    // object has no name anywhere in the system and no sweep can find it.
    name: "Account deletion enqueues its images before the cascade takes their keys",
    file: "lib/accountDeletion.ts",
    test: (source) => {
      const enqueue = source.indexOf("enqueueImageAssetCleanupForConversations(");
      const deleteConversations = source.indexOf("tx.conversation.deleteMany(");
      return (
        enqueue !== -1 &&
        deleteConversations !== -1 &&
        enqueue < deleteConversations &&
        source.includes('"account_deleted"')
      );
    },
  },
  {
    // The retention sweeps are independent, and awaiting them bare meant the
    // first to throw skipped every one behind it -- on every run, since a step
    // that fails for a persistent reason fails again tomorrow. The step that
    // deletes accounts past their 30-day grace period is fifth in the order.
    name: "Retention cleanup steps run in isolation and report which failed",
    file: "lib/maintenance.ts",
    test: (source) =>
      source.includes("createMaintenanceStepRunner") &&
      source.includes("failedSteps: failures") &&
      source.includes('step("scheduled_account_deletions"'),
  },
  {
    // Isolation must not turn a partial failure into a silent success: the
    // alert has to fire and the run has to be recorded failed.
    name: "A failed retention step still fails the scheduled job",
    file: "app/api/internal/maintenance/cleanup/route.ts",
    test: (source) =>
      source.includes("deleted.failedSteps.length > 0") &&
      source.includes("failScheduledJob") &&
      source.includes("SCHEDULED_MAINTENANCE_CLEANUP_STEP_FAILED"),
  },
  {
    name: "Provider error events expire through maintenance cleanup",
    file: "lib/maintenance.ts",
    test: (source) =>
      source.includes("providerErrorEvent.deleteMany") &&
      source.includes("30 * 24 * 60 * 60 * 1000") &&
      // Optional because the sweep runs as an isolated step now: a step that
      // threw reports `null` rather than a count.
      /providerErrorEvents\??\.count/.test(source),
  },
  {
    name: "Infrastructure metrics remain admin-only with bounded external responses",
    file: "app/api/admin/infrastructure/route.ts",
    test: (source) =>
      source.includes("isAdminSession(session)") &&
      source.includes("consumeApiRateLimit") &&
      source.includes('headers: { "Cache-Control": "no-store" }') &&
      source.includes('hasAdminPermission(session, "billing:write")') &&
      source.includes("readLimitedJson") &&
      source.includes("writeAdminAuditLog"),
  },
  {
    name: "External infrastructure calls use server-only tokens, timeouts, and response limits",
    file: "lib/infrastructureMonitoring.ts",
    test: (source) =>
      source.includes('import "server-only"') &&
      source.includes("RAILWAY_API_TOKEN") &&
      source.includes("CLOUDFLARE_API_TOKEN") &&
      source.includes("AbortSignal.timeout(EXTERNAL_TIMEOUT_MS)") &&
      source.includes("MAX_EXTERNAL_RESPONSE_BYTES"),
  },
  {
    name: "Conversation share creation requires unlock grant and snapshots",
    file: "app/api/conversations/[conversationId]/share/route.ts",
    test: (source) =>
      source.includes("hasConversationUnlockGrant") &&
      source.includes("shareSnapshot") &&
      source.includes("createShareToken()") &&
      source.includes("MAX_SHARE_SNAPSHOT_BYTES"),
  },
  {
    name: "Public share reads are no-store and non-indexable",
    file: "app/api/public/shares/[shareToken]/route.ts",
    test: (source) =>
      source.includes("isStrongShareToken") &&
      source.includes("public-share-read") &&
      source.includes('"Cloudflare-CDN-Cache-Control": "no-store"') &&
      source.includes('"X-Robots-Tag": "noindex, nofollow, noarchive"') &&
      !source.includes("s-maxage"),
  },
  {
    name: "Conversation search filters locked results by unlock grant",
    file: "app/api/conversations/search/route.ts",
    test: (source) =>
      source.includes("hasConversationUnlockGrant") &&
      source.includes("conversation: { select: { title: true, password: true } }"),
  },
  {
    name: "Bulk conversation deletion requires unlock grants",
    file: "app/api/conversations/route.ts",
    test: (source) =>
      source.includes("inaccessibleLockedConversation") &&
      source.includes("hasConversationUnlockGrant") &&
      source.includes("conversationLockedResponse"),
  },
  {
    name: "Billing plan feature entitlements are server enforced",
    file: "lib/billingEntitlements.ts",
    test: (source) =>
      source.includes("allowAttachments") &&
      source.includes("allowSharing") &&
      source.includes("allowDownloads") &&
      source.includes("PLAN_MODEL_LIMIT_EXCEEDED"),
  },
  {
    name: "Conversation lock passwords require at least eight characters",
    file: "lib/conversationLock.ts",
    test: (source) => source.includes("assertPasswordLength(password, 8)"),
  },
  {
    name: "Railway maintenance cron is represented in code",
    file: "railway.maintenance.json",
    test: (source) =>
      source.includes('"startCommand": "npm run maintenance:cleanup"') &&
      source.includes('"cronSchedule": "0 3 * * *"'),
  },
  {
    name: "Process liveness stays independent from external dependencies",
    file: "app/api/health/route.ts",
    test: (source) =>
      source.includes("{ ok: true }") &&
      source.includes("status: 200") &&
      !source.includes("prisma") &&
      !source.includes("getSecurityEnvironmentStatus"),
  },
  {
    name: "Production readiness fails closed on database or security configuration",
    file: "app/api/ready/route.ts",
    test: (source) =>
      source.includes('SELECT 1 AS "ready"') &&
      source.includes("getSecurityEnvironmentStatus") &&
      source.includes("database && securityEnvironment") &&
      source.includes("status: ready ? 200 : 503") &&
      source.includes("reportOperationalDependencyStatus") &&
      source.includes("DATABASE_READINESS_FAILED") &&
      source.includes("after(async ()"),
  },
  {
    name: "Operational outage reporting is independent from Prisma storage",
    file: "lib/operationalMonitoring.ts",
    test: (source) => {
      const instrumentation = read("instrumentation.ts");
      return (
        source.includes("Sentry.captureException") &&
        source.includes("OPS_ALERT_SLACK_WEBHOOK_URL") &&
        source.includes("OPS_ALERT_DISCORD_WEBHOOK_URL") &&
        source.includes("operational_incident") &&
        !source.includes('from "@/lib/prisma"') &&
        instrumentation.includes("Sentry.captureRequestError")
      );
    },
  },
  {
    name: "Maintenance failures use DB-independent operational reporting",
    file: "app/api/internal/maintenance/cleanup/route.ts",
    test: (source) => {
      const reservations = read(
        "app/api/internal/maintenance/credit-reservations/route.ts"
      );
      return (
        source.includes("reportOperationalIncident") &&
        source.includes("SCHEDULED_MAINTENANCE_CLEANUP_FAILED") &&
        reservations.includes("reportOperationalIncident") &&
        reservations.includes("CREDIT_RESERVATION_RECONCILIATION_FAILED")
      );
    },
  },
  {
    name: "Only cheap liveness bypasses canonical host protection",
    file: "proxy.ts",
    test: (source) => {
      const originGate = source.indexOf("!isAllowedRequestHost");
      const preGate = source.slice(0, originGate);
      return (
        preGate.includes('request.nextUrl.pathname === "/api/health"') &&
        !preGate.includes('request.nextUrl.pathname === "/api/ready"') &&
        !source.includes("_next/static|_next/image")
      );
    },
  },
  {
    name: "Locked conversations are excluded from all-conversation export",
    file: "app/api/conversations/export-all/route.ts",
    test: (source) =>
      source.includes("hasConversationUnlockGrant") &&
      source.includes("locked conversation(s) were excluded"),
  },
  {
    name: "Maintenance endpoint requires bearer secret",
    file: "app/api/internal/maintenance/cleanup/route.ts",
    test: (source) =>
      source.includes("MAINTENANCE_SECRET") &&
      source.includes("Bearer ") &&
      source.includes("timingSafeEqual"),
  },
  {
    name: "Provider monitoring keeps DB and enforced monthly limits separate",
    file: "lib/providerMonitoring.ts",
    test: (source) =>
      // Tri-state on purpose: a missing production budget reports as
      // "unconfigured" and alerts, never as an invented code default --
      // the monitoring path must agree with the fail-closed enforcement.
      source.includes("internalBudgetSource: ProviderBudgetConfigSource") &&
      source.includes('"unconfigured"') &&
      source.includes("Provider budget unconfigured") &&
      source.includes("providerBillingHeadroomMicroUsd") &&
      source.includes("internalBudgetHeadroomMicroUsd") &&
      source.includes("Math.min(providerBillingLimitMicroUsd, monthBudgetMicroUsd)") &&
      source.includes('"provider_not_configured"'),
  },
  {
    name: "Admin provider panel labels DB reference and enforced cap explicitly",
    file: "components/admin/AdminProviderHealthPanel.tsx",
    test: (source) =>
      source.includes('label="Provider billing limit (DB reference)"') &&
      source.includes('label="Tomverse enforced monthly cap"') &&
      source.includes('label="Expected effective ceiling (lower limit)"') &&
      source.includes("CHAT_PROVIDER_${provider.provider.toUpperCase()}_COST_MICROUSD_PER_MONTH") &&
      source.includes("Not enforced by Tomverse") &&
      source.includes("Request blocking"),
  },
  {
    name: "Image provider budget has no silent production default",
    file: "lib/imageProviderBudget.ts",
    test: (source) =>
      // Names are derived per provider now (see the multi-provider check
      // below); what this check pins is the fail-closed behaviour.
      source.includes("IMAGE_PROVIDER_${namespace}_COST_MICROUSD_PER_DAY") &&
      source.includes("IMAGE_PROVIDER_${namespace}_COST_MICROUSD_PER_MONTH") &&
      source.includes('"missing_in_production"') &&
      source.includes('"partial_configuration"') &&
      source.includes("imageProviderBudgetFloorMicroUsd"),
  },
  {
    name: "Image model registry keeps an unrunnable model registered but disabled",
    file: "lib/imageModelRegistry.ts",
    test: (source) =>
      // Policy section 12: a model that cannot be priced or cannot be run is
      // registered with an empty price list and a fail-closed hold, never
      // priced from memory. Pinned as the invariant rather than as one
      // reason string -- the reasons are a union and which one applies moves
      // as verification progresses, while these guards must not.
      //
      // maxImageRequestCostMicroUsd returns null when the thinking cap is
      // unknown, so no fixed credit price can be derived from an unbounded
      // worst case; getImageModelPrice refuses any disabled model outright.
      source.includes('| "price_unverified"') &&
      source.includes('| "worst_case_cost_unbounded"') &&
      source.includes('| "operational_hold"') &&
      source.includes("thinkingCapMicroUsd: null") &&
      source.includes("if (thinkingCap === null) return null") &&
      source.includes("model.disabledReason !== null) return null"),
  },
  {
    name: "xAI image requests pin a mapped size and trust the returned MIME",
    file: "lib/xaiImageRequest.ts",
    test: (source) =>
      // Two ways this path could silently overcharge or corrupt a stored
      // asset: sending a resolution the approved credits did not price, and
      // filing JPEG bytes under an assumed PNG. Both fail closed by returning
      // null so the caller refuses and refunds.
      source.includes("if (!mapped) return null") &&
      source.includes("MIME_ALLOWLIST.has(reported.trim())") &&
      source.includes("if (!mimeType) return null") &&
      source.includes('response_format: "b64_json"'),
  },
  {
    name: "Image pricing check enforces what each disabled reason claims",
    file: "scripts/check-image-pricing.mjs",
    test: (source) =>
      // Three reasons that state three different facts. Without per-reason
      // enforcement they degrade into interchangeable labels, and a model
      // could be relabelled past the verification rule instead of satisfying
      // it -- `operational_hold` in particular asserts that the price question
      // is settled.
      source.includes('model.disabledReason === "price_unverified" && verification.verifiedAt') &&
      source.includes('model.disabledReason === "worst_case_cost_unbounded"') &&
      source.includes("verification.thinkingCapMicroUsd !== null") &&
      source.includes('model.disabledReason === "operational_hold"') &&
      source.includes("marked operational_hold without a price verification date"),
  },
  {
    name: "The Google image path speaks Interactions, never GenerateContent",
    file: "lib/googleImageRequest.ts",
    test: (source) => {
      // GenerateContent's vocabulary is allowed in prose -- the header comment
      // names it precisely so the boundary is legible -- and forbidden in
      // code, because a body that mixes the two is valid-looking and wrong.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      return (
        source.includes("/v1beta/interactions") &&
        source.includes('"x-goog-api-key"') &&
        source.includes("max_output_tokens: input.maxOutputTokens") &&
        source.includes("total_thought_tokens") &&
        !code.includes("generationConfig") &&
        !code.includes("inlineData") &&
        !code.includes("usageMetadata") &&
        // Only the delivered answer is read. A thinking model emits images
        // while reasoning, and storing a working sketch as the paid result is
        // the failure nobody would notice -- both are plausible pictures.
        source.includes('=== "model_output"') &&
        source.includes("if (images.length !== 1) return null") &&
        // An open-ended request is refused rather than sent (§12 cond. 2).
        source.includes(
          "if (!input.maxOutputTokens || input.maxOutputTokens <= 0) return null"
        )
      );
    },
  },
  {
    name: "A request audit snapshot strips every provider's prompt field",
    file: "lib/imageProviderAdapter.ts",
    test: (source) =>
      // OpenAI and xAI name it `prompt`; Google's Interactions API names it
      // `input`. Filtering only `prompt` was correct until it silently stopped
      // being: the Google body would have copied the user's prompt into the
      // stored audit blob, a second place every deletion path has to reach.
      source.includes('PROMPT_FIELD_NAMES = new Set(["prompt", "input"])') &&
      source.includes("!PROMPT_FIELD_NAMES.has(key)") &&
      !source.includes('([key]) => key !== "prompt"'),
  },
  {
    name: "A CSP violation is excused only for extension schemes",
    file: "lib/cspReportCore.ts",
    test: (source) => {
      // The tempting shortcut is "not http(s)", and it would make the endpoint
      // silent about `data:` and `blob:` sources -- which is what injected
      // script looks like, and the case this endpoint exists for.
      const start = source.indexOf("BROWSER_EXTENSION_SOURCE_SCHEMES");
      const block = source.slice(start, source.indexOf("\n]", start));
      return (
        start > -1 &&
        block.includes("chrome-extension:") &&
        !block.includes("data:") &&
        !block.includes("blob:") &&
        // A set membership test, never a scheme comparison that could invert.
        /BROWSER_EXTENSION_SOURCE_SCHEMES\.has\(/.test(source)
      );
    },
  },
  {
    name: "Only one module decides which deployment this is",
    file: "lib/deploymentEnvironment.ts",
    test: (source) => {
      // Five call sites each had their own chain, and the four that skipped
      // APP_ENV -- the variable staging actually sets -- disagreed with the
      // one that read it. Staging errors arrived in Sentry tagged
      // `environment: production`, error-report evidence was stamped
      // production on staging, and the admin console told an operator on
      // staging that they were in production. Verified from the outside:
      // staging's /api/build-info said "staging" while its own Sentry events
      // said "production" (2026-08-12).
      const files = [
        "sentry.server.config.ts",
        "sentry.edge.config.ts",
        "lib/traceErrorEvidence.ts",
        "lib/errorReportToken.ts",
        "lib/buildInfo.ts",
        "lib/securityEnvironment.ts",
        "app/(site)/(application)/admin/layout.tsx",
      ];
      return (
        source.includes("env.APP_ENV") &&
        source.includes("env.RAILWAY_ENVIRONMENT_NAME") &&
        files.every((file) => {
          // Comments are stripped: these files explain why they do not read
          // the Sentry alias, naming it to do so.
          const consumer = read(file)
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^[ \t]*\/\/.*$/gm, "");
          const resolves = file.startsWith("sentry.")
            ? consumer.includes("resolveSentryEnvironmentTag")
            : // Which deployment produced a record, and which rules apply to
              // it, are facts. A Sentry display alias must not answer either,
              // so these read the deployment and never SENTRY_ENVIRONMENT.
              consumer.includes("resolveDeploymentEnvironment") &&
              !consumer.includes("SENTRY_ENVIRONMENT");
          return (
            resolves &&
            // A bare RAILWAY_ENVIRONMENT_NAME read is a second chain starting
            // again.
            !consumer.includes("process.env.RAILWAY_ENVIRONMENT_NAME")
          );
        })
      );
    },
  },
  {
    name: "Stripe key mode is required per deployment, not per build mode",
    file: "lib/securityEnvironment.ts",
    test: (source) => {
      // Staging is a production build, so `!production || live` demanded a
      // live key there -- unsatisfiable, and the wrong thing to want. Its
      // readiness sat at 503 permanently, which meant it could no longer
      // report anything else breaking. Both directions are asserted now, so
      // this must keep reading the deployment.
      const check = source.slice(source.indexOf("stripeLiveMode:"));
      const body = check.slice(0, check.indexOf("\n    providerUsageSyncSecret"));
      return (
        source.includes("resolveDeploymentEnvironment()") &&
        body.includes('deployment === "production"') &&
        body.includes('deployment === "staging"') &&
        // The production branch still demands live, and staging still refuses
        // it: a live key in staging bills real cards from test flows.
        body.includes("=== true") &&
        body.includes("=== false") &&
        !/!production\s*\|\|\s*stripeKeyLiveMode/.test(source)
      );
    },
  },
  {
    name: "The image group creation guard decides kind through the helper",
    file: "lib/imageGenerationService.ts",
    test: (source) =>
      // Same answer as `kind !== "image"` today, and not the same decision: a
      // third conversation kind would leave every open-coded comparison
      // silently picking a side, in the transaction that reserves credits.
      source.includes("!isImageConversationKind(conversation.kind)") &&
      !/conversation\.kind\s*!==\s*"image"/.test(source),
  },
  {
    name: "The image history endpoint decides kind through the helper",
    file: "app/api/conversations/[conversationId]/generations/route.ts",
    test: (source) =>
      source.includes("!isImageConversationKind(conversation.kind)") &&
      !/conversation\.kind\s*!==\s*"image"/.test(source),
  },
  {
    name: "An image asset reaches the client as a signed URL, never as a key",
    file: "lib/imageGenerationRead.ts",
    test: (source) =>
      // r2Key is a storage path into a bucket the user has no business naming,
      // and the edit that leaks it is the one that reads as harmless:
      // `{...asset, url}` instead of naming the three fields. The mapping is a
      // pure function now so the shape is pinned by a test as well.
      source.includes("serializeImageAssets(") &&
      !/\.\.\.asset\b/.test(source) &&
      // The select still reads r2Key -- it has to, to mint the URL -- so the
      // check is that nothing hands the row itself onward.
      !/assets:\s*generation\.assets\b/.test(source),
  },
  {
    name: "The image workspace borrows the rail's principles, not its code",
    file: "components/images/ImageGenerationWorkspace.tsx",
    test: (source) => {
      // Policy §1: an image conversation never mounts ChatInput, ChatApp or
      // the comparison action rail, and never enables AI Review. Importing
      // shouldShowVisualStatus would couple the two disclosure policies, so
      // the next change to the chat comparison would silently re-shape the
      // image composer. Comments may name them; imports may not.
      const imports = source
        .split("\n")
        .filter((line) => /^\s*(import|}?\s*from)\b/.test(line))
        .join("\n");
      return !/(ComparisonActionRail|shouldShowVisualStatus|comparisonReadiness|components\/chat\/ChatInput|components\/chat\/ChatApp)/.test(
        imports
      );
    },
  },
  {
    name: "A thrown image-budget check reads as not ready, never as healthy",
    file: "app/api/ready/route.ts",
    test: (source) =>
      // `status?.ready ?? true` made the loudest failure the quietest signal:
      // a missing environment variable was fatal, while the check that finds
      // missing environment variables throwing was reported healthy.
      source.includes("imageBudgetStatus.status?.ready ?? false") &&
      !source.includes("getImageProviderBudgetReadiness().catch"),
  },
  {
    name: "The image budget floor reads every enabled price, not one table",
    file: "lib/imageProviderBudget.ts",
    test: (source) => {
      // Two price lists exist -- gpt-image-2's original table and each newer
      // model's registry profile -- and reading only the first stayed correct
      // by luck. An enabled model with no proven worst case throws rather than
      // being skipped, because skipping computes the floor from everything
      // except what the floor exists to cover.
      const derivation = source.slice(
        source.indexOf("export const worstImageCostPerCreditFrom")
      );
      const body = derivation.slice(0, derivation.indexOf("\n};"));
      return (
        body.includes("maxRequestCostMicroUsd") &&
        body.includes("maxImageRequestCostMicroUsd") &&
        body.includes("throw new Error") &&
        source.includes("listEnabledImageModels()")
      );
    },
  },
  {
    name: "The thinking-cap measurement keeps usage from an unfinished image",
    file: "scripts/measure-google-image-thinking-cap.mjs",
    test: (source) =>
      // The sample where the limit actually bit has no finished image in it.
      // Reading the response only through the production parser -- which fails
      // closed on anything that is not exactly one image -- discarded exactly
      // those, so the run paid for its best evidence and threw it away.
      source.includes("readGoogleImageInteraction(payload)") &&
      source.includes("measured_without_image") &&
      // And it stops paying once the question is settled.
      source.includes('stopReason = "counterexample_found"'),
  },
  {
    name: "The adapter takes its delivery MIME type from the registry helper",
    file: "lib/imageProviderAdapter.ts",
    test: (source) =>
      // `outputMimeTypes` is the storage allowlist; `deliveryMimeType` is what
      // the request asks the provider for. Reading the head of the allowlist
      // instead sent every Google request asking for PNG, which its API
      // refuses -- and the two are only kept apart by going through one helper.
      source.includes("imageDeliveryMimeType(model)") &&
      !source.includes("outputMimeTypes["),
  },
  {
    name: "The thinking-cap measurement sends the adapter's own request",
    file: "scripts/measure-google-image-thinking-cap.mjs",
    test: (source) =>
      // This script exists to measure what production would be billed for, so
      // a request it builds differently from the adapter measures nothing. It
      // already drifted once: the adapter learned Google's delivery MIME type
      // and the script kept its own copy of the old expression.
      source.includes("imageDeliveryMimeType(model)") &&
      !source.includes("outputMimeTypes["),
  },
  {
    name: "A documented output limit never doubles as a proven cost cap",
    file: "lib/imageModelRegistry.ts",
    test: (source) => {
      // maxOutputTokens is what the model card publishes; thinkingCapMicroUsd
      // is whether the worst case is provably finite. Google states the first
      // and not the second, so the field must never be read as the cap -- and
      // maxImageRequestCostMicroUsd must keep deriving from the cap alone.
      const derivation = source.slice(
        source.indexOf("export const maxImageRequestCostMicroUsd")
      );
      const body = derivation.slice(0, derivation.indexOf("\n};"));
      return (
        source.includes("maxOutputTokens?: number") &&
        body.includes("thinkingCapMicroUsd") &&
        !body.includes("maxOutputTokens")
      );
    },
  },
  {
    name: "The thumbnail repair cannot destroy the original it derives from",
    file: "lib/imageAssetLifecycle.ts",
    test: (source) =>
      // readR2Object deletes an object whose metadata does not match what the
      // caller claimed -- correct for an untrusted upload, catastrophic for a
      // generated original the user paid for and cannot regenerate. The repair
      // reads through the non-destructive path, and only ever writes the
      // thumbnail key.
      source.includes("readOwnR2ObjectBytes(originalKey") &&
      !source.includes("readR2Object(") &&
      source.includes('writeR2Object(thumbKey, thumbBytes, "image/webp")') &&
      // Bounded, so one corrupt object cannot pull the maintenance process
      // over, and bounded in attempts so it stops rather than re-downloading
      // forever.
      source.includes("IMAGE_ORIGINAL_MAX_READ_BYTES") &&
      source.includes("thumbnailRetryCount: { lt: IMAGE_THUMBNAIL_MAX_RETRIES }"),
  },
  {
    name: "A non-destructive R2 read exists and stays non-destructive",
    file: "lib/r2.ts",
    test: (source) => {
      const start = source.indexOf("export async function readOwnR2ObjectBytes");
      if (start === -1) return false;
      const end = source.indexOf("export async function writeR2Object", start);
      const body = source.slice(start, end === -1 ? undefined : end);
      // The one thing this function must never grow: the delete-on-mismatch
      // branch that makes readR2Object right for uploads and wrong here.
      return (
        !body.includes("deleteInvalidObject") &&
        !body.includes("DeleteObjectCommand") &&
        body.includes("options.maxBytes")
      );
    },
  },
  {
    name: "The workbook writer cannot emit a formula, a macro or an external link",
    file: "lib/generatedArtifactXlsx.ts",
    test: (source) => {
      // Comments stripped first, and deliberately: the file's own header
      // *names* these parts to explain why they are absent, so matching the
      // raw text would fail on the documentation rather than on the code.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // The formula defence is structural: OOXML evaluates `<f>` and nothing
      // else, so a writer with no `<f>` in it cannot produce a spreadsheet
      // that executes anything. Same for the parts that would make a workbook
      // fetch or run something when it is opened.
      return (
        !code.includes("<f>") &&
        !code.includes("<f ") &&
        !code.includes("vbaProject") &&
        !code.includes("externalLink") &&
        !code.includes("connections.xml") &&
        !code.includes("relationships/hyperlink") &&
        // And the forced-text style stays a real quotePrefix attribute rather
        // than a comment claiming one.
        code.includes('quotePrefix="1"')
      );
    },
  },
  {
    name: "A model cannot ask for a formula, and its input is re-checked server-side",
    file: "lib/generatedArtifactTool.ts",
    test: (source) => {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // The provider is handed a JSON schema; nothing guarantees it enforces
      // one. The admission inside `execute` is what actually decides, so every
      // tool must route through the handler table's `admit` rather than
      // trusting the parsed input -- and each of the five must be in it.
      const admissions = [
        "admitWorkbookSpecSafely",
        "admitDocumentSpec",
        "admitPresentationSpec",
        "admitTextFileSpec",
        "admitArchiveSpec",
      ];
      return (
        admissions.every((admission) => code.includes(`admit: ${admission},`)) &&
        code.includes("const admission = handler.admit(rawInput);") &&
        code.includes("inputSchema: workbookSpecSchema") &&
        code.includes("inputSchema: documentSpecSchema") &&
        code.includes("inputSchema: presentationSpecSchema") &&
        code.includes("inputSchema: textFileSpecSchema") &&
        code.includes("inputSchema: archiveSpecSchema") &&
        // Nothing the model is handed back may address the stored object.
        !code.includes("objectKey:") &&
        !code.includes("createR2ReadUrl")
      );
    },
  },
  {
    name: "No generated format is one that runs when it is opened",
    file: "lib/generatedArtifactFormats.ts",
    test: (source) => {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // The refusal has to be a list the code can state, not an absence: a
      // format nobody thought about is how ".exe" becomes "sure, here you go".
      // The same list governs archive entries, so a zip cannot deliver what a
      // direct request is refused.
      const refused = ["exe", "dll", "bat", "cmd", "msi", "vbs", "reg", "hta"];
      const refusedBlock = code.slice(
        code.indexOf("REFUSED_ARTIFACT_EXTENSIONS")
      );
      return (
        refused.every((extension) => refusedBlock.includes(`"${extension}"`)) &&
        // And none of them may also appear as a generated format.
        !refused.some((extension) =>
          code.includes(`id: "${extension}"`) ||
          code.includes(`text("${extension}"`)
        )
      );
    },
  },
  {
    name: "Authored text is validated, and an archive entry cannot escape the archive",
    file: "lib/generatedArtifactText.ts",
    test: (source) => {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Every archive entry goes through the same admission a direct request
      // does -- same extension table, same structural check, same ceiling --
      // and an SVG carrying script is refused rather than sanitised.
      return (
        code.includes("admitTextContent({") &&
        code.includes("findSvgScript(") &&
        code.includes("<script") &&
        code.includes("foreignObject") &&
        code.includes("javascript") &&
        // Paths are decided at admission and never rewritten here.
        !code.includes("replace(/\\.\\./g")
      );
    },
  },
  {
    name: "A generated document or deck carries no link, field or remote data",
    file: "lib/generatedArtifactDocx.ts",
    test: (source) => {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Structural, like the workbook's `<f>` rule: a writer that never emits
      // a field or a hyperlink relationship cannot produce a document that
      // fetches or runs anything when it is opened.
      return (
        !code.includes("w:fldChar") &&
        !code.includes("w:instrText") &&
        !code.includes("relationships/hyperlink") &&
        !code.includes("relationships/oleObject") &&
        !code.includes("vbaProject")
      );
    },
  },
  {
    name: "A generated PDF has no action, no script and no embedded file",
    file: "lib/generatedArtifactPdf.ts",
    test: (source) => {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // PDF's own execution surfaces. None of them is written, so none of them
      // can be present.
      return (
        !code.includes("/JavaScript") &&
        !code.includes("/OpenAction") &&
        !code.includes("/AA") &&
        !code.includes("/Launch") &&
        !code.includes("/EmbeddedFile") &&
        !code.includes("/URI")
      );
    },
  },
  {
    name: "An artifact download is scoped by owner and cannot destroy its own file",
    file: "app/api/artifacts/[artifactId]/route.ts",
    test: (source) => {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Ownership is part of the lookup, so there is no branch that could tell
      // "not yours" from "not there" -- and no signed URL is ever minted, so a
      // key cannot leak by being turned into a link.
      return (
        code.includes("where: { id: artifactId, userId }") &&
        code.includes("hasConversationUnlockGrant(") &&
        // The non-destructive read: `readR2Object` deletes on a metadata
        // mismatch, which would destroy a file the user paid for.
        code.includes("readOwnR2ObjectBytes(") &&
        !code.includes("readR2Object(") &&
        !code.includes("createR2ReadUrl") &&
        code.includes('"X-Content-Type-Options": "nosniff"') &&
        code.includes('"Cache-Control": "private, no-store"')
      );
    },
  },
  {
    name: "Stale image recovery can reclaim a stranded settlement",
    file: "lib/imageGenerationService.ts",
    test: (source) =>
      // `settling` is claimed OUTSIDE the settlement transaction, so any
      // rollback -- a deadlock, a dropped connection, a redeploy -- leaves the
      // row there with the user's credits still reserved. While the recovery
      // sweep and the failure path both matched only pending/processing, that
      // state was unreachable by anything: no refund, no terminal status, and
      // a client that polls it forever. Both halves of the fix are pinned
      // because either one alone leaves a door open.
      source.includes('{ status: "settling", updatedAt: { lt: settlingStaleBefore } }') &&
      source.includes("reclaimSettling: settlingStaleBefore") &&
      source.includes('reclaimSettling: "owned"') &&
      // The reclaim stays bounded: an unconditional one would race a live
      // settler, and only the caller that already owns the claim may skip the
      // wait.
      source.includes('input.reclaimSettling === "owned"') &&
      source.includes("updatedAt: { lt: input.reclaimSettling }"),
  },
  {
    name: "Image settlement claims the reservation before it moves any credit",
    file: "lib/imageGenerationService.ts",
    test: (source) =>
      // What makes reclaiming a settling row safe at all: the money moves
      // behind the reservation's own reserved -> settling claim, inside the
      // transaction that also finishes the generation. A settlement that
      // already committed refuses the second attempt instead of paying twice.
      source.includes('where: { generationId, status: "reserved" },') &&
      source.includes('data: { status: "settling" },') &&
      source.includes("if (reservationClaim.count === 0) return"),
  },
  {
    // The same claim-before-you-pay rule as the image settler above, on the
    // other reservation table. Extraction runs in the background now: nothing
    // is watching when a run reaches a terminal state, so a settlement that
    // could run twice would refund twice with no one to notice (import/memory
    // policy §11).
    name: "Extraction settlement claims the reservation before it moves any credit",
    file: "lib/memoryExtractionCredits.ts",
    test: (source) =>
      source.includes('where: { runId: input.runId, status: "reserved" }') &&
      source.includes('data: { status: "settling" }') &&
      source.includes("if (claim.count === 0)"),
  },
  {
    // A run that exists without a reservation is a run nobody paid for, and it
    // also blocks the account from starting another (one active run per user).
    // Reserving inside the creation transaction is what makes both impossible:
    // a refused reservation leaves no run, no chunks and no charge.
    name: "An extraction run cannot exist without the reservation that paid for it",
    file: "lib/memoryExtractionService.ts",
    test: (source) =>
      source.includes("reserveExtractionRunCredits({") &&
      source.includes("tx,") &&
      source.includes("await tx.memoryExtractionChunk.createMany"),
  },
  {
    // Entitlement, not the operational guardrail. AGENTS.md keeps the two
    // layers apart in names, codes and metrics, and the extraction reservation
    // is entitlement: it allocates plan and add-on credits and must not read or
    // write a provider budget.
    name: "Extraction entitlement stays out of the provider budget layer",
    file: "lib/memoryExtractionCredits.ts",
    test: (source) =>
      source.includes("getChatCreditAllocation") &&
      source.includes("reserveAddOnCredits") &&
      !source.includes("providerCostBudget") &&
      !source.includes("PROVIDER_BUDGET_EXHAUSTED"),
  },
  {
    // No raw internal USD in anything a user sees. The extraction reservation
    // knows the run's estimated cost in micro-USD and must never put it in the
    // error it throws when the balance is short.
    name: "Extraction credit errors carry no internal cost figure",
    file: "lib/memoryExtractionCredits.ts",
    test: (source) =>
      source.includes("CREDIT_BALANCE_INSUFFICIENT") &&
      !/CREDIT_BALANCE_INSUFFICIENT[\s\S]{0,400}(costMicroUsd|MicroUsd)/.test(
        source
      ),
  },
  {
    name: "Image provider budgets are per provider and cover every active one",
    file: "lib/imageProviderBudget.ts",
    test: (source) =>
      source.includes("imageProviderBudgetEnvNames") &&
      source.includes("IMAGE_PROVIDER_${namespace}_COST_MICROUSD_PER_DAY") &&
      source.includes("resolveActiveImageProviderBudgets") &&
      source.includes("listActiveImageProviders"),
  },
  {
    name: "Readiness gates on the image provider budget while the flag is on",
    file: "app/api/ready/route.ts",
    test: (source) =>
      source.includes("getImageProviderBudgetReadiness") &&
      source.includes("IMAGE_PROVIDER_COST_BUDGET_NOT_READY") &&
      source.includes("imageProviderBudget"),
  },
  {
    name: "Product analytics payload is strict and content-free",
    file: "lib/productAnalyticsShared.ts",
    test: (source) =>
      source.includes("analyticsPropertiesSchema") &&
      source.includes(".strict()") &&
      !source.includes("prompt:") &&
      !source.includes("response:") &&
      !source.includes("file_name:") &&
      !source.includes("file_content:"),
  },
  {
    name: "Help analytics is bounded and excludes conversation content",
    file: "lib/productAnalyticsShared.ts",
    test: (source) =>
      source.includes('"help_opened"') &&
      source.includes('"help_article_viewed"') &&
      source.includes('"ui_help_opened"') &&
      source.includes('"sidebar_tour_started"') &&
      source.includes('"sidebar_tour_completed"') &&
      source.includes('"sidebar_tour_skipped"') &&
      source.includes("help_source:") &&
      source.includes("help_topic:") &&
      source.includes('help_article_id: z.enum(["chat_workspace"])'),
  },
  {
    name: "Chat sidebar exposes accessible new-tab workspace help",
    file: "components/chat/ChatSidebar.tsx",
    test: (source) =>
      source.includes("chatWorkspaceGuideHref(lang)") &&
      source.includes('target="_blank"') &&
      source.includes('rel="noopener noreferrer"') &&
      source.includes('trackProductEvent("help_opened"') &&
      source.includes('help_source: "sidebar_header"'),
  },
  {
    name: "Chat sidebar separates status, labels, and projects with contextual help",
    file: "components/chat/ChatSidebar.tsx",
    test: (source) =>
      source.includes('data-testid="sidebar-status-filters"') &&
      source.includes('data-testid="sidebar-label-filters"') &&
      source.includes('data-testid="sidebar-projects"') &&
      source.includes('topic="locked"') &&
      source.includes('topic="label"') &&
      source.includes('topic="project"') &&
      source.includes("SIDEBAR_TOUR_STORAGE_KEY") &&
      source.includes('trackProductEvent("sidebar_tour_completed")'),
  },
  {
    name: "Product analytics API uses bounded input and trusted plan resolution",
    file: "app/api/analytics/events/route.ts",
    test: (source) =>
      source.includes("readLimitedJson") &&
      source.includes("8 * 1024") &&
      source.includes("consumeApiRateLimit") &&
      source.includes("select: { plan: true }") &&
      source.includes("analyticsCountryFromHeaders"),
  },
  {
    name: "GA4 loads only after consent or a resolved notice-and-opt-out policy",
    file: "components/analytics/AnalyticsProvider.tsx",
    test: (source) =>
      source.includes('consent === "accepted" ||') &&
      source.includes('resolvedPolicy.mode === "notice_opt_out"') &&
      source.includes("analyticsEnabled && analyticsClientReady && measurementId") &&
      source.includes("googletagmanager.com/gtag/js") &&
      source.includes("disableAnalyticsClient"),
  },
  {
    name: "Pre-consent campaign attribution and events survive navigation without cookies",
    file: "lib/productAnalyticsClient.ts",
    test: (source) =>
      source.includes("PRECONSENT_ATTRIBUTION_STORAGE_KEY") &&
      source.includes("PENDING_EVENTS_STORAGE_KEY") &&
      source.includes("window.sessionStorage.setItem") &&
      source.includes("capturePreConsentAttribution()") &&
      source.includes("mergePendingEvents(readPendingEvents(), pendingEvents)") &&
      source.includes("preConsentAttribution.hasUtm") &&
      source.includes("analyticsConsent() === \"declined\"") &&
      source.includes(
        "window.sessionStorage.removeItem(PRECONSENT_ATTRIBUTION_STORAGE_KEY)"
      ),
  },
  {
    name: "Go-live acquisition, onboarding, limit, signup, and checkout events are wired",
    file: "lib/productAnalyticsShared.ts",
    test: (source) => {
      const requiredEvents = [
        "pricing_view",
        "plan_selected",
        "signup_page_view",
        "onboarding_shown",
        "onboarding_completed",
        "onboarding_skipped",
        "credit_limit_hit",
        "upgrade_prompt_view",
        "checkout_failed",
      ];
      const pricing = read("components/marketing/PricingPageContent.tsx");
      const checkout = read("components/marketing/UpgradeInterestButton.tsx");
      // The sign-in route is a server component that resolves `?lang=` before
      // rendering (VAL-003); the interactive half, and the page-view event,
      // live in its client child.
      const signup = read("app/(site)/(application)/auth/signin/SignInPageContent.tsx");
      const chatInput = read("components/chat/ChatInput.tsx");
      const migration = read(
        "prisma/migrations/00000000000000_baseline/migration.sql"
      );
      const purchase = read("lib/stripeWebhookProcessing.ts");
      return (
        requiredEvents.every(
          (eventName) =>
            source.includes(`\"${eventName}\"`) &&
            migration.includes(`'${eventName}'`)
        ) &&
        pricing.includes('trackProductEvent("pricing_view")') &&
        pricing.includes('trackProductEvent("plan_selected"') &&
        checkout.includes('trackProductEvent("checkout_failed"') &&
        signup.includes('trackProductEvent("signup_page_view")') &&
        chatInput.includes('"onboarding_shown"') &&
        chatInput.includes('trackProductEvent("credit_limit_hit"') &&
        chatInput.includes('trackProductEvent("upgrade_prompt_view"') &&
        purchase.includes('eventName: "purchase_completed"')
      );
    },
  },
  {
    name: "Server purchase analytics keeps GA4 API secret server-side",
    file: "lib/productAnalyticsServer.ts",
    test: (source) =>
      source.includes("process.env.GA4_API_SECRET") &&
      source.includes("region1.google-analytics.com/mp/collect") &&
      source.includes('ad_user_data: "DENIED"') &&
      source.includes('ad_personalization: "DENIED"'),
  },
  {
    name: "Model Finder keeps defaults Standard, stores only bounded preferences, and requires explicit high-cost selection",
    file: "app/api/user/model-finder/route.ts",
    test: (source) => {
      const rules = read("lib/modelFinder.ts");
      const component = read("components/onboarding/ModelFinder.tsx");
      const input = read("components/chat/ChatInput.tsx");
      const schema = read("prisma/schema.prisma");
      const migration = read(
        "prisma/migrations/00000000000000_baseline/migration.sql"
      );
      // Migration assertions split by what they are actually about. Anything
      // structural -- a table, a column, a CHECK constraint -- is read from
      // prisma/migrations/00000000000000_baseline, because that is what a
      // freshly provisioned database gets. One-off ALTER and data steps only
      // ever existed in the replaced history, so they are read from
      // prisma/migrations-archive/, which is frozen.
      const dismissalMigration = read(
        "prisma/migrations-archive/20260715220000_add_model_finder_dismissed_at/migration.sql"
      );
      return (
        source.includes("getServerSession(authOptions)") &&
        source.includes("readLimitedJson(req, 8 * 1024, actionSchema)") &&
        source.includes('consumeApiRateLimit(req, userId, "model-finder-save"') &&
        // "accept_default" takes no client-supplied model id at all -- the
        // server always picks its own Standard-tier default.
        source.includes("isModelFinderDefaultId(APP_DEFAULTS.defaultModelId)") &&
        // "complete" is bounded to at most 3 model ids and every one of them
        // must be re-validated against the server-computed recommendation
        // combination, not trusted from the client.
        source.includes(
          "modelIds: z.array(z.string().trim().min(1).max(100)).min(1).max(3)"
        ) &&
        source.includes("getModelFinderCombination(body.answers)") &&
        source.includes("comboModelIds.has(modelId)") &&
        rules.includes('canUseModelWithPlan("Guest", model)') &&
        rules.includes('category === "Standard"') &&
        component.includes('"model_finder_started"') &&
        component.includes('"recommended_model_accepted"') &&
        component.includes('"advanced_model_selected"') &&
        input.includes("getContextualModelSuggestion") &&
        input.includes("const added = onToggleModel(contextualModel.id)") &&
        schema.includes("preferredTasks") &&
        schema.includes("preferredPriority") &&
        schema.includes("usesFilesFrequently") &&
        schema.includes("modelFinderCompletedAt") &&
        schema.includes("modelFinderDismissedAt") &&
        migration.includes("model_finder_viewed") &&
        migration.includes("advanced_model_selected") &&
        dismissalMigration.includes('ADD COLUMN "modelFinderDismissedAt"') &&
        dismissalMigration.includes('"modelFinderCompletedAt" = NULL')
      );
    },
  },
  {
    name: "Subscription cancellation analytics is recorded after Stripe accepts it",
    file: "app/api/billing/cancel-subscription/route.ts",
    test: (source) =>
      source.indexOf("subscriptions.update") <
        source.indexOf('eventName: "subscription_cancelled"') &&
      source.includes("analyticsAttributionSchema.optional()") &&
      source.includes("recordProductAnalyticsEvent") &&
      source.includes("sendToGa4: true"),
  },
  {
    name: "Public billing config exposes only the active featured code, not the promotion catalogue",
    file: "lib/billingConfig.ts",
    test: (source) => {
      const publicConfig = source.slice(
        source.indexOf("export async function getPublicBillingConfig")
      );
      return (
        publicConfig.includes("codesListed: false") &&
        publicConfig.includes('validation: "server_only"') &&
        publicConfig.includes('getBillingPromotionByCode("TOMVERSE50")') &&
        publicConfig.includes("featuredPromotion: publicFeaturedPromotion") &&
        !publicConfig.includes("getBillingPromotions()") &&
        !publicConfig.includes("promotions:")
      );
    },
  },
  {
    name: "Promotion validation accepts only bounded input and is rate limited",
    file: "app/api/billing/promotion/validate/route.ts",
    test: (source) =>
      source.includes("readLimitedJson") &&
      source.includes("consumeApiRateLimit") &&
      source.includes("validatePromotionForCheckout") &&
      source.includes('"Cache-Control": "private, no-store, max-age=0"'),
  },
  {
    name: "Billing UI validates entered codes without downloading a promotion list",
    file: "components/marketing/UpgradeInterestButton.tsx",
    test: (source) =>
      source.includes('fetch("/api/billing/promotion/validate"') &&
      source.includes("requestPromotionValidation") &&
      source.includes("normalizedInputCode !== appliedPromoCode") &&
      source.includes("promotionPolicyCopy") &&
      !source.includes("billingConfig.promotions"),
  },
  {
    name: "TOMVERSE50 is bounded, advertised from live config, and auto-validated",
    file: "prisma/migrations-archive/20260714190000_configure_tomverse50_public_launch/migration.sql",
    test: (source) =>
      source.includes("'TOMVERSE50'") &&
      source.includes('"discountPercent" = 50') &&
      source.includes('"durationMonths" = 1') &&
      source.includes('"maxRedemptions" = 100000') &&
      source.includes("2026-08-31 00:00:00+10") &&
      source.includes('"allowAnnualStacking" = false') &&
      source.includes('"isActive" = true') &&
      read("components/marketing/PricingPageContent.tsx").includes(
        "featuredPromotion.code"
      ) &&
      read("components/marketing/UpgradeInterestButton.tsx").includes(
        "normalizedFeaturedCode,"
      ),
  },
  {
    name: "TOMFRIEND100 is a bounded 60-day non-renewing Pro pass",
    file: "prisma/migrations-archive/20260716150000_founding_tester_pass/migration.sql",
    test: (source) => {
      const checkout = read("app/api/billing/checkout/route.ts");
      const maintenance = read("lib/maintenance.ts");
      const entitlements = read("lib/billingEntitlements.ts");
      return (
        source.includes("'TOMFRIEND100'") &&
        source.includes("'internal_pass'") &&
        source.includes("'[\"pro\"]'") &&
        /\r?\n  25,\r?\n/.test(source) &&
        /\r?\n  60,\r?\n/.test(source) &&
        source.includes("redemption.\"redeemedAt\" + INTERVAL '60 days'") &&
        source.includes('app_user.\"stripeSubscriptionId\" IS NULL') &&
        checkout.includes("activateInternalPass") &&
        checkout.includes("addUtcDays(accessStartsAt, promotion.accessDurationDays)") &&
        checkout.includes("isInternalPassPromotion(appliedPromotion)") &&
        !checkout.includes("if (finalPriceMinor <= 0)") &&
        maintenance.includes("sendFoundingTesterPassReminders") &&
        maintenance.includes("expireFoundingTesterPasses") &&
        entitlements.includes("effectivePlanForAccess")
      );
    },
  },
  {
    name: "Public billing configuration responses are not cached",
    file: "app/api/billing/config/route.ts",
    test: (source) =>
      source.includes('"Cache-Control": "no-store, max-age=0"'),
  },
  {
    // Two separate guarantees, and the fix for the promotion-checkout outage
    // sits between them. Stripe refuses a Session that carries both
    // `allow_promotion_codes` and `discounts` -- it tests for the parameter
    // being present, not for its value -- so sending `false` next to a discount
    // is the same 400 as sending `true`, and that is what made every promotion
    // checkout return a 500.
    //
    // What must NOT come back is the customer-entered code box: the discount
    // has to be the server-validated promotion id, and any path that omits a
    // discount has to keep saying `allow_promotion_codes: false` out loud.
    // `allow_promotion_codes: true` must appear nowhere at all.
    name: "Checkout disables Stripe code bypass and applies validated promotion IDs",
    file: "app/api/billing/checkout/route.ts",
    test: (source) =>
      source.includes("validatePromotionForCheckout") &&
      source.includes("allow_promotion_codes: false") &&
      !source.includes("allow_promotion_codes: true") &&
      // The exclusive form: a discount, or the explicit opt-out, never both.
      /\.\.\.\(discount\s*\r?\n?\s*\?\s*\{ discounts: \[discount\] \}\s*\r?\n?\s*:\s*\{ allow_promotion_codes: false \}\)/.test(
        source
      ) &&
      source.includes("ensureStripePromotionDiscount") &&
      source.includes("reservePromotionCheckout") &&
      !source.includes("promoCode: appliedPromotion"),
  },
  {
    // The discount handed to Checkout is always a Stripe object this promotion
    // owns. Adopting an object found by code search without checking its
    // metadata, its coupon and its mode would let an unrelated -- or hostile --
    // promotion code become the discount a Tomverse plan is sold at.
    name: "Stripe promotion provisioning verifies ownership before reuse and never deletes live objects",
    file: "lib/stripePromotionProvisioning.ts",
    test: (source) =>
      source.includes("canAdoptStripePromotionCode") &&
      source.includes("canUseStripePromotionCode") &&
      source.includes("idempotencyKey: promotionCouponIdempotencyKey") &&
      source.includes("idempotencyKey: promotionCodeIdempotencyKey") &&
      // Conditional linkage write: never blind-overwrite another writer's ids.
      source.includes("db.billingPromotion.updateMany") &&
      !/\.(del|update)\s*\(\s*[^)]*active:\s*false/.test(source) &&
      !source.includes("promotionCodes.del(") &&
      !source.includes("coupons.del("),
  },
  {
    name: "Active promotions require redemption caps, expiry, and explicit annual stacking",
    file: "app/api/admin/billing/route.ts",
    test: (source) =>
      source.includes("Active promotions require a maximum redemption count") &&
      source.includes("allowAnnualStacking") &&
      source.includes("maxRedemptions") &&
      source.includes("endsAt"),
  },
  {
    name: "Promotion abuse signals use keyed IP and payment-method hashes",
    file: "lib/billingPromotionSecurity.ts",
    test: (source) =>
      source.includes('createHmac("sha256", securitySecret())') &&
      source.includes('hashPromotionValue("ip"') &&
      source.includes('hashPromotionValue("payment-method"') &&
      source.includes('"shared_ip"') &&
      source.includes('"shared_payment_method"'),
  },
  {
    name: "Robots policy exposes the sitemap and blocks private application routes",
    file: "app/robots.ts",
    test: (source) =>
      source.includes('sitemap: `${SITE_ORIGIN}/sitemap.xml`') &&
      source.includes('"/admin"') &&
      source.includes('"/api"') &&
      source.includes('"/auth"') &&
      source.includes('"/chat$"') &&
      source.includes('"/chat/"') &&
      !source.includes('"/chat",') &&
      source.includes('"/share"'),
  },
  {
    name: "Sitemap lists canonical public pages and localized search-intent URLs",
    file: "app/sitemap.ts",
    test: (source) =>
      source.includes("LOCALIZED_SEO_PATHS") &&
      source.includes("localizedLanguageAlternates") &&
      source.includes('path: "/status"') &&
      !source.includes('path: "/chat"') &&
      !source.includes('path: "/admin"') &&
      !source.includes('path: "/share"'),
  },
  {
    // RECON-I18N-001. The metadata moved out of the deleted `app/layout.tsx`
    // into one module, so the two root layouts cannot drift on canonical
    // origin or social cards. Both roots are checked to actually export it --
    // a root that forgot to would silently lose every card and the canonical
    // base for its whole tree.
    name: "Global metadata provides canonical origin, social cards, and optional webmaster verification",
    file: "lib/rootMetadata.ts",
    test: (source) =>
      source.includes("metadataBase: new URL(SITE_ORIGIN)") &&
      source.includes('card: "summary_large_image"') &&
      source.includes('url: `${SITE_ORIGIN}/opengraph-image`') &&
      source.includes('url: `${SITE_ORIGIN}/twitter-image`') &&
      source.includes("GOOGLE_SITE_VERIFICATION") &&
      source.includes("BING_SITE_VERIFICATION") &&
      [read("app/(site)/layout.tsx"), read("app/[locale]/layout.tsx")].every(
        (layout) => layout.includes("export const metadata = rootMetadata")
      ),
  },
  {
    name: "Marketing routes are static while application routes retain request-time rendering",
    file: "app/(site)/(marketing)/layout.tsx",
    test: (source) => {
      const applicationLayout = read("app/(site)/(application)/layout.tsx");
      // RECON-I18N-001. There is no single `app/layout.tsx` any more: the
      // localized marketing routes need `<html lang>` to come from their own
      // route param, which only a root layout at or below `[locale]` can see.
      // Both roots are checked, because the property this rule protects is
      // "nothing above a whole route tree pulls per-user state", and that has
      // to hold for each root independently rather than for one file.
      const rootLayouts = [
        read("app/(site)/layout.tsx"),
        read("app/[locale]/layout.tsx"),
      ];
      const requestReadsIn = (layout) =>
        [
          ...layout.matchAll(
            /(?:\(await headers\(\)\)|requestHeaders)\.get\(([^)]*)\)/g
          ),
        ].map((match) => match[1].trim());
      const siteReads = requestReadsIn(rootLayouts[0]);
      const localeReads = requestReadsIn(rootLayouts[1]);
      const proxySource = read("proxy.ts");
      // VAL-004 narrowed this rule rather than relaxing it, and UI-001 narrows
      // it again on the same terms. A root layout may read values the *proxy*
      // resolved for this request and nothing else: reading a session, a
      // cookie or the database there would put per-user state above every
      // route under that root, which is what the assertions further down still
      // forbid outright.
      //
      // UI-001 adds the theme. It is per-visitor, so the property that keeps it
      // safe is not in this layout but in the proxy: THEME_HEADER is set only
      // when the request is *not* a static marketing request, so the
      // prerendered, publicly cached HTML is never rendered with one visitor's
      // theme. That guard is asserted here rather than assumed, because
      // deleting it is what would turn this into a cache-poisoning bug.
      const allowedSiteReads = new Set([
        "DOCUMENT_LANGUAGE_HEADER",
        "THEME_HEADER",
        '"x-nonce"',
      ]);
      return (
        source.includes('export const dynamic = "force-static"') &&
        source.includes("export const revalidate = false") &&
        applicationLayout.includes('export const dynamic = "force-dynamic"') &&
        applicationLayout.includes("getServerSession(authOptions)") &&
        siteReads.length > 0 &&
        siteReads.every((entry) => allowedSiteReads.has(entry)) &&
        siteReads.includes("DOCUMENT_LANGUAGE_HEADER") &&
        proxySource.includes("if (!isStaticMarketingRequest) {") &&
        proxySource.includes("requestHeaders.set(THEME_HEADER, theme)") &&
        rootLayouts[0].includes('import { headers } from "next/headers"') &&
        // The localized root takes its language from `params`, so it needs no
        // request-time read at all and must stay prerenderable: an accidental
        // header read there would drop 45 SEO pages out of the prerender, and
        // lib/staticMarketingCsp.ts hashes that built HTML.
        localeReads.length === 0 &&
        !rootLayouts[1].includes('from "next/headers"') &&
        rootLayouts[1].includes('export const dynamic = "force-static"') &&
        rootLayouts.every(
          (layout) =>
            !layout.includes("cookies()") &&
            !layout.includes("getServerSession") &&
            !layout.includes("prisma")
        )
      );
    },
  },
  {
    name: "Static marketing CSP hashes generated HTML while dynamic routes retain nonces",
    file: "lib/staticMarketingCsp.ts",
    test: (source) => {
      const proxy = read("proxy.ts");
      const csp = read("lib/csp.ts");
      const nextConfig = read("next.config.ts");
      return (
        source.includes('createHash("sha384")') &&
        source.includes('readFileSync(htmlPath, "utf8")') &&
        source.includes("htmlPath.startsWith") &&
        proxy.includes("getStaticMarketingCspHashes") &&
        proxy.includes("createStaticMarketingCsp(staticMarketingHashes") &&
        proxy.includes("Static security policy unavailable") &&
        proxy.includes(
          '"public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"'
        ) &&
        csp.includes("scriptHashes.join") &&
        nextConfig.includes('algorithm: "sha384"')
      );
    },
  },
  {
    name: "Static marketing route allowlist excludes private and live-status surfaces",
    file: "lib/marketingRoutes.ts",
    test: (source) =>
      source.includes('"/pricing"') &&
      source.includes('"/support/help-centre"') &&
      source.includes('"/ai-answer-review"') &&
      source.includes('"chatgpt-vs-claude"') &&
      !source.includes('"/chat"') &&
      !source.includes('"/admin"') &&
      !source.includes('"/status"') &&
      !source.includes('"/share"'),
  },
  {
    name: "Locale launch policy labels incomplete coverage and excludes it from paid acquisition",
    file: "lib/localeLaunchPolicy.ts",
    test: (source) => {
      const switcher = read(
        "components/marketing/MarketingLanguageSwitcher.tsx"
      );
      const notice = read("components/marketing/LocaleSupportNotice.tsx");
      const infoPage = read("components/marketing/MarketingInfoPage.tsx");
      const privacy = read("components/legal/PrivacyPolicy.tsx");
      const analyticsClient = read("lib/productAnalyticsClient.ts");
      const analyticsServer = read("lib/productAnalyticsServer.ts");
      return (
        source.includes(
          'export const PAID_MARKETING_LOCALES: readonly Language[] = ["en", "ko"]'
        ) &&
        source.includes('marketTier: "limited"') &&
        source.includes('marketTier: "preview"') &&
        source.includes("paidMarketingEligible: false") &&
        switcher.includes("localeLaunchPolicy[language].selectorLabel") &&
        switcher.includes("MARKETING_LOCALE_NOTICE_ID") &&
        notice.includes("localizedContentAvailable") &&
        notice.includes("data-paid-marketing-eligible") &&
        infoPage.includes("Boolean(localizedPage)") &&
        infoPage.includes('localizedPage ? lang : "en"') &&
        privacy.includes("localizedContentAvailable") &&
        analyticsClient.includes("localeMarketingAnalyticsProperties") &&
        analyticsServer.includes("localeMarketingAnalyticsProperties")
      );
    },
  },
  {
    // RECON-I18N-001. The graph moved into MarketingShell so the English and
    // localized marketing roots render the same one.
    name: "Structured data is sanitized and identifies the organization and software application",
    file: "components/marketing/MarketingShell.tsx",
    test: (source) =>
      source.includes('"@type": "Organization"') &&
      source.includes('"@type": "SoftwareApplication"') &&
      source.includes('"@type": "Offer"') &&
      read("components/seo/StructuredData.tsx").includes(
        'JSON.stringify(data).replace(/</g, "\\\\u003c")'
      ),
  },
  {
    name: "Search-intent pages have localized content and server metadata",
    file: "app/[locale]/[intent]/page.tsx",
    test: (source) =>
      source.includes("generateStaticParams") &&
      source.includes("createPageMetadata") &&
      source.includes("localizedBasePath") &&
      read("components/marketing/searchIntentContent.ts").includes(
        '"compare-ai-models"'
      ) &&
      read("components/marketing/searchIntentContent.ts").includes(
        '"ai-answer-review"'
      ) &&
      read("components/marketing/searchIntentContent.ts").includes(
        '"chatgpt-vs-claude"'
      ) &&
      read("components/marketing/searchIntentContent.ts").includes(
        '"ai-for-file-analysis"'
      ),
  },
  {
    name: "AI Review marketing describes cross-review without claiming fact verification",
    file: "components/marketing/AiReviewDemo.tsx",
    test: (source) =>
      source.includes("common ground") &&
      source.includes("Contradiction") &&
      source.includes("Missing point") &&
      source.includes("does not browse, externally verify facts, or decide the correct answer") &&
      source.includes("position bias") &&
      read("components/marketing/searchIntentContent.ts").includes(
        '"ai-answer-review"'
      ) &&
      read("lib/comparisonReview.ts").includes("const ordered = shuffled(responses)"),
  },
  {
    name: "Authenticated application surfaces are explicitly noindex",
    file: "app/(site)/(application)/chat/layout.tsx",
    test: (source) =>
      source.includes("index: false") &&
      read("app/(site)/(application)/auth/layout.tsx").includes("index: false") &&
      read("app/(site)/(application)/admin/layout.tsx").includes("index: false") &&
      read("app/(site)/(application)/share/[shareToken]/page.tsx").includes("index: false"),
  },
  {
    name: "Paid-launch legal pages disclose recurring billing, refunds, and operator contact",
    file: "components/marketing/marketingInfoContent.ts",
    test: (source) =>
      source.includes("Monthly and annual subscriptions; automatic renewal") &&
      source.includes("Cancellation and end of paid access") &&
      source.includes("Monthly credits and additional credits") &&
      source.includes("Additional-credit refunds, partial refunds, and chargebacks") &&
      source.includes("12 months (365 days)") &&
      source.includes("Starter Credit Pack") &&
      source.includes("Promotional purchases") &&
      source.includes("Provider incidents and credit restoration") &&
      source.includes("Australian Consumer Law") &&
      source.includes("Queensland, Australia") &&
      source.includes("support@tomverse.app") &&
      !source.includes("Billing is not currently enabled") &&
      !source.includes("before paid launch") &&
      !source.includes("유료 출시 전") &&
      !source.includes("결제 준비"),
  },
  {
    name: "Checkout discloses renewal and links paid users to legal policies",
    file: "components/marketing/UpgradeInterestButton.tsx",
    test: (source) =>
      source.includes('href="/terms"') &&
      source.includes('href="/refund"') &&
      source.includes("automatic renewal") &&
      source.includes("자동 갱신") &&
      source.includes("discount period") &&
      !source.includes("Discounts apply to the first month of Pro and Max"),
  },
  {
    name: "Chat model picker hides internal classes and shows exact credit costs",
    file: "components/chat/ChatInput.tsx",
    test: (source) => {
      const panel = read("components/chat/ModelPickerPanel.tsx");
      const catalogue = read("components/chat/ModelCatalogue.tsx");
      // STG-F008 moved the 30+ model catalogue behind an "All models" step.
      // The 2026-07-17 version of that idea was reverted because the collapsed
      // state also hid the search box, leaving a beginner with three models and
      // no way to look for a fourth -- so the search entry point must render
      // before the branch that swaps in the catalogue, on both steps.
      const searchIndex = panel.indexOf('data-testid="model-search-input"');
      const catalogueBranchIndex = panel.indexOf("showCatalogue ? (");
      return (
        catalogue.includes('testId="model-credit-badge"') &&
        catalogue.includes("CreditCostBadge") &&
        panel.includes("CreditCostBadge") &&
        read("components/credits/CreditCostBadge.tsx").includes(
          'data-testid="credit-coin-icon"'
        ) &&
        catalogue.includes("getModelPickerDescription") &&
        catalogue.includes("getModelPickerFeatures") &&
        // Recommendation reasons come from the task-language label table, never
        // from provider names or an absolute quality ranking.
        panel.includes("modelPickerUseCaseLabels") &&
        panel.includes('data-testid="model-recommendations"') &&
        panel.includes('data-testid="recommended-model-option"') &&
        panel.includes('data-testid="model-picker-open-all"') &&
        panel.includes('data-testid="model-selection-summary"') &&
        searchIndex > 0 &&
        catalogueBranchIndex > 0 &&
        searchIndex < catalogueBranchIndex &&
        // The advanced filters were moved into a sheet, not deleted.
        catalogue.includes('data-testid="model-filter-sheet"') &&
        catalogue.includes('data-testid="model-filter-reset-all"') &&
        catalogue.includes('data-testid="model-catalogue-result-count"') &&
        source.includes('data-testid="request-credit-estimate"') &&
        !panel.includes('data-testid="show-all-models"') &&
        !catalogue.includes('option value="Research"') &&
        !catalogue.includes("usageClassFilter") &&
        read("components/auth/AuthButton.tsx").includes(
          "getModelUsageProfile(model)"
        )
      );
    },
  },
  {
    name: "Model picker analytics records funnel steps without search terms",
    file: "components/chat/ModelPickerPanel.tsx",
    test: (source) => {
      const shared = read("lib/productAnalyticsShared.ts");
      const migration = read(
        "prisma/migrations/00000000000000_baseline/migration.sql"
      );
      const searchTracking = source.slice(
        source.indexOf("const handleSearchChange"),
        source.indexOf("const handleFilterSheetOpenChange")
      );
      return (
        // Only the fact that a search happened is sent -- the query never
        // reaches trackProductEvent.
        searchTracking.includes('onTrackEvent("model_picker_search_used")') &&
        !searchTracking.includes("search_query") &&
        !searchTracking.includes("onTrackEvent(\"model_picker_search_used\", {") &&
        shared.includes('"model_picker_opened"') &&
        shared.includes('"model_picker_all_opened"') &&
        shared.includes('"model_picker_selection_confirmed"') &&
        shared.includes('"model_picker_abandoned"') &&
        shared.includes("recommendation_rank: z.number().int().min(1).max(8)") &&
        migration.includes("'model_picker_opened'") &&
        migration.includes("'model_picker_abandoned'")
      );
    },
  },
  {
    name: "Guest chat entry uses a non-blocking inline guide with truthful capabilities",
    file: "components/chat/ChatInput.tsx",
    test: (source) => {
      const guide = source.slice(
        source.indexOf('data-testid="guest-quick-start"'),
        source.indexOf("isNewConversation && !value.trim() && attachments.length === 0")
      );
      return (
        guide.includes('t("chat.guestQuickLine")') &&
        guide.includes('t("chat.guestQuickLineHelpBody")') &&
        !source.includes('t("auth.signIn")') &&
        !guide.includes("fixed inset-0") &&
        !guide.includes('aria-modal="true"') &&
        source.includes('onFocus={() => dismissGuestQuickStart("completed")}') &&
        source.includes('tomverse_guest_quick_start_seen_v2') &&
        !read("app/(site)/(application)/chat/page.tsx").includes("GoLiveOnboarding")
      );
    },
  },
  {
    name: "Analytics consent is compact and waits for the guest quick-start guide",
    file: "components/analytics/AnalyticsProvider.tsx",
    test: (source) => {
      // UI-P1-02 extracted the decline/accept button markup into a shared
      // `consentButtonClass` string instead of repeating an inline className
      // literal -- check the shared class itself carries the 44px WCAG 2.2
      // target size and pill shape, in place of the old
      // `className="min-h-11 rounded-lg` literal-string check. UI-P2-01 then
      // moved both buttons behind one builder that applies that class, so the
      // "both buttons use it" half is asserted as "the single builder applies
      // it and is used exactly twice, once per decision".
      //
      // REAUDIT-P1-01 turned that builder from a render-time helper call into
      // a module-scope `ConsentAction` component, because the handlers now
      // close over the control that opened the preferences notice and
      // `react-hooks/refs` refuses a ref-reading function passed into a
      // function call during render. The property being guarded is unchanged
      // -- one shared 44px class, applied to exactly the two consent
      // decisions -- so only the shape it is matched in moves here.
      const buttonClassMatch = source.match(
        /const consentButtonClass =\s*\n?\s*"([^"]+)"/
      );
      const buttonClass = buttonClassMatch ? buttonClassMatch[1] : "";
      const buttonClassUsages = (
        source.match(/className=\{consentButtonClass\}/g) || []
      ).length;
      const consentDecisions = (
        source.match(/<ConsentAction\s*\n?\s*kind="(decline|accept)"/g) || []
      ).length;

      return (
        source.includes("usePathname") &&
        source.includes('tomverse:guest-quick-start') &&
        source.includes("consentPromptReady") &&
        source.includes("GUEST_QUICK_START_ACTIVE_KEY") &&
        // UI-P1-02 also moved the fixed-fallback notice from a bottom-center
        // full-width bar to a bottom-right corner toast, narrowing its
        // viewport-relative width cap accordingly.
        source.includes("calc(100vw-1.5rem)") &&
        // STG-F001 replaced the rigid grid-cols layout with flex-wrap (so long
        // translated labels wrap instead of overflowing). UI-P2-01 additionally
        // dropped the viewport-keyed `sm:flex-nowrap`, which re-introduced
        // overflow whenever the notice's *container* was narrower than the
        // viewport (the max-w-sm sign-in card on a 1440px desktop): the row is
        // now sized by container queries and may always wrap as a last resort.
        // The gap value itself is spacing, not a guarantee -- it was retuned
        // when the Latin UI face changed and the copy needed the width back --
        // so match the wrap-capable, container-query-driven row instead of a
        // literal gap step.
        /flex-wrap items-center gap-[\d.]+ @md\/notice:/.test(source) &&
        source.includes("@container/notice") &&
        // Matched inside a className only -- the paragraph above deliberately
        // names the old utility while explaining why it went away.
        !/className="[^"]*sm:flex-nowrap/.test(source) &&
        buttonClass.includes("min-h-11") &&
        buttonClass.includes("rounded-lg") &&
        buttonClassUsages === 1 &&
        consentDecisions === 2 &&
        // The component has to stay at module scope: defined inside the
        // provider it would be a new type on every render, remounting both
        // buttons (and dropping focus) whenever the notice re-renders.
        /^function ConsentAction\(/m.test(source) &&
        source.includes("env(safe-area-inset-bottom)")
      );
    },
  },
  {
    name: "Regional analytics defaults fail closed and preserve strict opt-in countries",
    file: "lib/analyticsConsentPolicy.ts",
    test: (source) => {
      const provider = read("components/analytics/AnalyticsProvider.tsx");
      const client = read("lib/productAnalyticsClient.ts");
      const route = read("app/api/analytics/consent-policy/route.ts");
      return (
        source.includes('const DEFAULT_ENABLED_COUNTRIES = "AU"') &&
        source.includes("STRICT_OPT_IN_COUNTRIES") &&
        source.includes('"GB"') &&
        source.includes('"DE"') &&
        source.includes('country === "ZZ"') &&
        provider.includes('fetch("/api/analytics/consent-policy"') &&
        provider.includes('resolvedPolicy.mode === "notice_opt_out"') &&
        provider.includes("analyticsEnabled && analyticsClientReady && measurementId") &&
        client.includes('analytics_storage: analyticsStorage') &&
        client.includes('ad_storage: "denied"') &&
        client.includes('ad_user_data: "denied"') &&
        client.includes('ad_personalization: "denied"') &&
        route.includes("ANALYTICS_DEFAULT_ENABLED_COUNTRIES") &&
        route.includes('"Cache-Control": "private, no-store, max-age=0"')
      );
    },
  },
  {
    name: "Purchase analytics separates subscriptions and credit packs with balance context",
    file: "lib/productAnalyticsShared.ts",
    test: (source) =>
      source.includes('purchase_type: z.enum(["subscription", "credit_pack"])') &&
      source.includes("product_id:") &&
      source.includes("pack_id:") &&
      source.includes("credits_purchased:") &&
      source.includes("current_plan:") &&
      source.includes("plan_credits_remaining:") &&
      source.includes("addon_credits_remaining:") &&
      source.includes('"limit_hit"') &&
      source.includes('"usage_widget"') &&
      source.includes('"account"') &&
      source.includes('"proactive"'),
  },
  {
    name: "Landing uses one state-aware chat CTA and defers signup until after value",
    file: "components/marketing/LandingPageContent.tsx",
    test: (source) => {
      const copy = read("components/marketing/landingContent.ts");
      return (
        copy.includes('primaryCta: "Start chatting free"') &&
        copy.includes('primaryCta: "무료로 채팅 시작하기"') &&
        copy.includes(
          'guestNote: "No sign-up required—compare GPT, Claude, and Gemini side by side."'
        ) &&
        copy.includes("Get a one-minute recommendation after sign-up") &&
        source.includes('data-testid="landing-guest-note"') &&
        !source.includes('data-testid="landing-guest-cta"') &&
        // The account CTA belongs to the post-comparison section, never the
        // hero: signup is still offered only after the page has shown what an
        // account is for.
        !source.includes('data-testid="landing-signup-cta"') &&
        read("components/marketing/WorkflowContinuitySection.tsx").includes(
          'href="/auth/signin?callbackUrl=%2Fchat"'
        ) &&
        source.includes("const primaryChatHref =") &&
        source.includes('cta_location: "landing_hero_chat"')
      );
    },
  },
  {
    name: "Landing hero carries Tomverse Insight brand messaging and no stale single-model guest copy",
    file: "components/marketing/LandingPageContent.tsx",
    test: (source) => {
      const copy = read("components/marketing/landingContent.ts");
      return (
        copy.includes('badge: "Tomverse Insight · Multi-AI Comparison & Review"') &&
        copy.includes(
          'brandNote: "Tomverse Insight is the multi-AI comparison and review experience from Tomverse."'
        ) &&
        copy.includes(
          'heroSignupNote: "No sign-up required—start with three models."'
        ) &&
        source.includes('data-testid="landing-brand-note"') &&
        source.includes('data-testid="landing-hero-signup-note"') &&
        !copy.includes("try a free model") &&
        !copy.includes("adds more models, higher daily limits")
      );
    },
  },
  {
    name: "ChatGPT versus Claude search page contains a full comparison guide and prepared CTA",
    file: "components/marketing/ChatGptVsClaudeGuide.tsx",
    test: (source) =>
      source.includes('id="task-comparison"') &&
      source.includes('id="methodology"') &&
      source.includes('id="prompt-examples"') &&
      source.includes('id="comparison-faq"') &&
      source.includes('"Writing"') &&
      source.includes('"Coding"') &&
      source.includes('"Long documents"') &&
      source.includes('"Summarization"') &&
      source.includes('"Instruction following"') &&
      source.includes('reviewedDate: "14 July 2026"') &&
      source.includes('models: comparisonModelIds.join(",")') &&
      source.includes('source: "chatgpt-vs-claude"') &&
      source.includes('/model-icons/chatgpt.png') &&
      source.includes('/model-icons/claude.png') &&
      read("app/(site)/(marketing)/chatgpt-vs-claude/page.tsx").includes(
        'template="chatgpt-vs-claude"'
      ),
  },
  {
    name: "Prepared chat comparison validates and bounds URL presets",
    // STG-F006 split the old monolithic page.tsx into a thin server component
    // (just resolving the guest default model) plus this client component,
    // which now holds all the state and logic this check protects.
    file: "app/(site)/(application)/chat/ChatPageClient.tsx",
    test: (source) =>
      source.includes("comparisonPresetAppliedRef") &&
      source.includes(".filter(isEnabledModelId)") &&
      source.includes(".slice(0, APP_DEFAULTS.maxSelectedModels)") &&
      source.includes('.trim().slice(0, 1200)') &&
      source.includes("clampGuestSelectedModels(requestedModels)") &&
      source.includes("clampSelectedModels(requestedModels).slice(0, maxSelectableModels)") &&
      source.includes('params.delete("models")') &&
      source.includes('params.delete("prompt")'),
  },
  {
    name: "Public product proof metrics are thresholded aggregate counts only",
    file: "app/api/public/proof-metrics/route.ts",
    test: (source) =>
      source.includes("PUBLIC_COUNT_THRESHOLD = 20") &&
      source.includes("productAnalyticsEvent.count") &&
      source.includes('eventName: "multi_model_compare_completed"') &&
      source.includes('eventName: "file_attached"') &&
      source.includes("Math.floor(count / 10) * 10") &&
      source.includes('"Cache-Control": "public, s-maxage=300') &&
      !source.includes("findMany") &&
      !source.includes("userId") &&
      !source.includes("anonymousIdHash"),
  },
  {
    name: "Landing product proof covers comparison, AI Review, and permission-safe evidence",
    file: "components/marketing/ProductProofSection.tsx",
    test: (source) => {
      const copy = read("components/marketing/landingContent.ts");
      const landing = read("components/marketing/LandingPageContent.tsx");
      const trust = read("components/marketing/TrustSection.tsx");
      const evidence = read("components/marketing/EvidenceSection.tsx");
      return (
        // Every section the page promises actually gets rendered.
        landing.includes("<ComparisonBasicsSection />") &&
        landing.includes("<EvidenceSection />") &&
        landing.includes("<ProductProofSection />") &&
        landing.includes("<WorkflowContinuitySection />") &&
        landing.includes("<ModelCatalogueSection />") &&
        landing.includes("<TrustSection />") &&
        // The public usage counts keep their threshold-and-rounding
        // disclosure, and still come from the permission-safe endpoint.
        trust.includes('fetch("/api/public/proof-metrics"') &&
        copy.includes(
          "Only privacy-safe counts above the public threshold are shown, rounded down to the nearest ten."
        ) &&
        // The AI Review boundary survives, and now says where a web check is
        // actually available instead of implying none exists.
        copy.includes("AI Review compares only the supplied answers") &&
        copy.includes("you can run a separate web check on it from the review") &&
        // Evidence features are named with their real conditions.
        evidence.includes('"landing-deep-research-card"') &&
        evidence.includes('"landing-web-search-card"') &&
        evidence.includes('"landing-source-grounding-card"') &&
        evidence.includes('"landing-item-verification-card"') &&
        copy.includes("Pro plan and above. Uses credits.") &&
        copy.includes("It measures quote matching") &&
        // The walkthrough is an illustration, not a stale capture: the
        // 2026-07-27 recording showed a superseded credit figure and the
        // pre-rename "Review confidence" label, so the landing page must not
        // embed it and must not claim to be a product recording.
        !source.includes('src="/marketing-proof/') &&
        !source.includes('poster="/marketing-proof/') &&
        !source.includes("<video") &&
        !copy.includes("Real product UI") &&
        !copy.includes("Review confidence") &&
        !copy.includes("4 credits used") &&
        copy.includes("Illustrative diagram, not a product recording") &&
        // Claims the product does not make: no source-linked extraction
        // guarantee on the file case.
        !copy.includes("source-linked")
      );
    },
  },
  {
    name: "No customer surface embeds the superseded walkthrough capture",
    file: "components/marketing/ChatWorkspaceGuide.tsx",
    test: (source) => {
      const landing = read("components/marketing/ProductProofSection.tsx");
      // The 2026-07-27 recording showed "4 credits used" (a cost corrected two
      // days later, because two independent reviewers run) and "Review
      // confidence" (renamed to source grounding). Both are server-side, so no
      // recording of them can stay true -- the guard is that nothing embeds it,
      // not that it keeps existing.
      const embedsCapture = (file) =>
        file.includes('src="/marketing-proof/') ||
        file.includes('poster="/marketing-proof/') ||
        file.includes("<video");
      return (
        !embedsCapture(source) &&
        !embedsCapture(landing) &&
        // Both surfaces explain the same flow from the same shared stage copy.
        source.includes('data-testid="guide-review-workflow"') &&
        source.includes("workflowStages.map") &&
        source.includes("workflowDisclosure") &&
        landing.includes('data-testid="landing-workflow-diagram"')
      );
    },
  },
  {
    name: "Pricing explains credit value using the production model weights",
    file: "components/marketing/PricingPageContent.tsx",
    test: (source) => {
      const models = read("lib/models.ts");
      return (
        source.includes('data-testid="pricing-credit-guide"') &&
        source.includes("getTypicalShortRequestCapacities(monthlyCredits)") &&
        // The allowance must come from the live billing config, whose
        // fallback is the shared built-in plan table -- not a second copy of
        // the numbers pasted into this component.
        source.includes("billing.planLimits(plan.id).monthlyCredits") &&
        !source.includes("fallbackCredits") &&
        read("components/marketing/usePublicBilling.ts").includes(
          "getDefaultBillingPlan"
        ) &&
        source.includes("일반적인 짧은 요청 기준 예시") &&
        source.includes("Standard + Advanced + Premium") &&
        source.includes("INPUT_CREDIT_MULTIPLIERS.map") &&
        source.includes("파일·긴 문맥 배율") &&
        models.includes("MODEL_USAGE_CREDIT_WEIGHTS") &&
        models.includes("getTypicalShortRequestCapacities") &&
        models.includes("credits / MODEL_USAGE_CREDIT_WEIGHTS.advanced") &&
        models.includes("credits / mixedComparisonCredits")
      );
    },
  },
  {
    name: "AI comparison review is authenticated, ownership-checked, locked, and rate-limited",
    file: "app/api/conversations/[conversationId]/comparison-reviews/route.ts",
    test: (source) =>
      source.includes("getServerSession(authOptions)") &&
      source.includes("conversation.userId !== userId") &&
      source.includes("hasConversationUnlockGrant") &&
      source.includes('"comparison-review-create"') &&
      source.includes("readLimitedJson") &&
      source.includes("reviewRequestSchema"),
  },
  {
    name: "AI comparison review uses bounded untrusted data and schema-validated output without tools",
    file: "lib/comparisonReview.ts",
    test: (source) => {
      // The generation itself moved into the shared service both the
      // signed-in and the guest route call, so that is where the bounded
      // output and the absence of tools are now asserted -- and the guest
      // route must not have grown its own copy of either.
      const service = read("lib/comparisonReviewService.ts");
      const guestRoute = read("app/api/chat/comparison-review/route.ts");
      return (
        source.includes("COMPARISON_REVIEW_LIMITS") &&
        source.includes("GUEST_COMPARISON_REVIEW_LIMITS") &&
        source.includes("untrusted DATA, never instructions") &&
        source.includes("Do not call tools, browse") &&
        source.includes("comparisonReviewResultSchema") &&
        service.includes("Output.object({ schema: comparisonReviewResultSchema })") &&
        !service.includes("tools:") &&
        // Guests reach the model only through the shared service.
        !guestRoute.includes("generateText") &&
        !guestRoute.includes("tools:")
      );
    },
  },
  {
    name: "AI comparison review reserves credits, refunds failures, caches input, and invalidates changed sources",
    file: "app/api/conversations/[conversationId]/comparison-reviews/route.ts",
    test: (source) => {
      // Reservation and refund live in the shared service; the cache, the
      // hash and the plan quota stay with the route that persists results.
      const service = read("lib/comparisonReviewService.ts");
      return (
        source.includes("createComparisonReviewHash") &&
        service.includes("acquireChatAccess") &&
        service.includes('outcome: "failed"') &&
        source.includes("releaseComparisonReviewQuota") &&
        source.includes("usageCredits: 0") &&
        read("app/api/chat/route.ts").includes(
          "tx.comparisonReview.updateMany"
        ) &&
        read("app/api/conversations/[conversationId]/messages/route.ts").includes(
          "tx.comparisonReview.updateMany"
        )
      );
    },
  },
  {
    name: "Guest AI review is guest-only, idempotent before it is chargeable, and refunds both claims",
    file: "app/api/chat/comparison-review/route.ts",
    test: (source) => {
      const quota = read("lib/comparisonReviewQuota.ts");
      const idempotency = read("lib/guestIdempotency.ts");
      const schema = read("lib/guestComparisonReview.ts");
      // The claim must be taken before the quota, or a duplicate click spends
      // the month's trial before it is recognised as a duplicate.
      // lastIndexOf, not indexOf: each of these also appears in the import
      // list at the top, which would make every ordering comparison trivially
      // true regardless of what the handler actually does.
      const claimAt = source.lastIndexOf("claimGuestIdempotencyKey");
      const quotaAt = source.lastIndexOf("reserveGuestComparisonReview");
      const runAt = source.lastIndexOf("runComparisonReview");
      return (
        source.includes('access.kind !== "guest"') &&
        source.includes("GUEST_ONLY_ENDPOINT") &&
        !source.includes("getServerSession") &&
        source.includes("ensureGuestVerified") &&
        source.includes("consumeApiRateLimit") &&
        claimAt > 0 &&
        quotaAt > claimAt &&
        runAt > quotaAt &&
        // Neither the trial nor the retry may be consumed by a run that
        // produced nothing.
        source.includes("releaseComparisonReviewQuota") &&
        source.includes("releaseGuestIdempotencyKey") &&
        // Both claims are single conditional statements, not read-then-write.
        quota.includes('WHERE "ChatUsageBucket"."count" < ${limit}') &&
        idempotency.includes('WHERE "ChatUsageBucket"."count" < ${SINGLE_USE_LIMIT}') &&
        // The client names none of cost, quota or reviewer: the schema is
        // strict, so an unknown field is a rejected request.
        schema.includes(".strict()") &&
        !source.includes("body.usageCredits") &&
        !source.includes("body.reviewerModelId")
      );
    },
  },
  {
    name: "Guest attachments are allowlisted, session-scoped, ephemeral and never logged",
    file: "app/api/chat/guest-attachment/route.ts",
    test: (source) => {
      const policy = read("lib/guestAttachments.ts");
      const chat = read("app/api/chat/route.ts");
      const maintenance = read("lib/maintenance.ts");
      return (
        source.includes('access.kind !== "guest"') &&
        source.includes("ensureGuestVerified") &&
        source.includes("consumeApiRateLimit") &&
        source.includes("reserveDailyUploadBytes") &&
        // Validated and parsed with the same hardened parsers the signed-in
        // path uses, never a lenient guest-only copy.
        source.includes("normalizeImageSafely") &&
        source.includes("extractPdfTextSafely") &&
        source.includes("parseOfficeSafely") &&
        source.includes("assertGuestAttachmentType") &&
        source.includes("assertGuestTextPayload") &&
        // Storage scope is derived from the caller's own signed identity.
        source.includes("isOwnGuestAttachmentKey") &&
        policy.includes("createHmac") &&
        chat.includes("isOwnGuestAttachmentKey") &&
        chat.includes("GUEST_MAX_ATTACHMENTS_PER_MESSAGE") &&
        // No file content, extracted text or filename reaches the log.
        !/console\.(error|warn|log)\([^)]*\b(text|extracted|buffer|payload)\b/.test(
          source
        ) &&
        // The retention promise has an actual sweep behind it.
        maintenance.includes("sweepExpiredGuestAttachments") &&
        maintenance.includes("GUEST_ATTACHMENT_PREFIX")
      );
    },
  },
  {
    name: "Credit-pack refunds and disputes record unrecovered debt under an account lock",
    file: "lib/creditPurchase.ts",
    test: (source) =>
      source.includes("lockCreditAccount(tx, candidate.userId)") &&
      source.includes('type: disputed ? "dispute_unrecovered" : "refund_unrecovered"') &&
      source.includes('billingRiskStatus: "disputed_hold"') &&
      source.includes("unrecoveredCredits: { increment: unrecoveredCredits }") &&
      source.includes("previouslyProcessedAmount") &&
      source.includes("handleCreditPackDisputeReinstated") &&
      source.includes('source: "dispute_reinstatement"') &&
      read("lib/stripeWebhookProcessing.ts").includes(
        'case "charge.dispute.funds_reinstated"'
      ) &&
      read("prisma/schema.prisma").includes("model CreditDebtEntry") &&
      read(
        "prisma/migrations/00000000000000_baseline/migration.sql"
      ).includes('CREATE TABLE "CreditDebtEntry"'),
  },
  {
    name: "Future plan and purchased credits offset debt before becoming available",
    file: "lib/chatSecurity.ts",
    test: (source) => {
      const purchase = read("lib/creditPurchase.ts");
      const debt = read("lib/creditDebt.ts");
      return (
        source.includes('"BILLING_DISPUTE_HOLD"') &&
        source.includes('type: "plan_offset"') &&
        source.includes("rawPlanRemaining - debtOffset.offsetCredits") &&
        purchase.includes('type: "purchase_offset"') &&
        purchase.includes('type: "debt_offset"') &&
        debt.includes("unrecoveredCredits: { decrement: allocatedCredits }")
      );
    },
  },
  {
    name: "Billing holds and refund credit reviews require admin billing permission and audit evidence",
    file: "app/api/admin/users/[userId]/billing-risk/route.ts",
    test: (source) => {
      const refund = read(
        "app/api/admin/refund-requests/[requestId]/route.ts"
      );
      const creditRefund = read(
        "app/api/admin/credit-purchases/[purchaseId]/refund/route.ts"
      );
      return (
        source.includes('hasAdminPermission(session, "billing:write")') &&
        source.includes('z.literal("RELEASE BILLING HOLD")') &&
        source.includes('action: "billing_risk.hold_released"') &&
        refund.includes("confirmCreditReview") &&
        refund.includes("Review the purchased credit balance and consumed AI cost") &&
        refund.includes("creditDebtCostMicroUsd") &&
        creditRefund.includes('hasAdminPermission(session, "billing:write")') &&
        creditRefund.includes('z.literal("REFUND CREDIT PURCHASE")') &&
        creditRefund.includes("expectedRemainingCredits") &&
        creditRefund.includes('action: "credit_purchase.refunded"')
      );
    },
  },
  {
    name: "Chat credit reservations are durable, expiring, and idempotently finalized",
    file: "lib/chatSecurity.ts",
    test: (source) => {
      const schema = read("prisma/schema.prisma");
      const migration = read(
        "prisma/migrations/00000000000000_baseline/migration.sql"
      );
      return (
        schema.includes("model ChatCreditReservation") &&
        schema.includes("idempotencyKey") &&
        schema.includes("expiresAt") &&
        migration.includes('CREATE TABLE "ChatCreditReservation"') &&
        source.includes("tx.chatCreditReservation.create") &&
        source.includes('status: "reserved"') &&
        source.includes("pg_advisory_xact_lock") &&
        source.includes("durable.idempotencyKey") &&
        source.includes('const terminalStatus = actualCredits > 0 ? "settled" : "refunded"') &&
        source.includes("reconcileExpiredChatCreditReservations") &&
        source.includes('reason: "reservation_expired"')
      );
    },
  },
  {
    name: "Provider correlation and fifteen-minute reservation reconciliation are wired",
    file: "app/api/internal/maintenance/credit-reservations/route.ts",
    test: (source) => {
      const chat = read("app/api/chat/route.ts");
      const review = read(
        "app/api/conversations/[conversationId]/comparison-reviews/route.ts"
      );
      const cron = read("railway.credit-reconciliation.json");
      const runner = read("scripts/run-credit-reconciliation.mjs");
      return (
        source.includes("MAINTENANCE_SECRET") &&
        source.includes("timingSafeEqual") &&
        source.includes("reconcileExpiredChatCreditReservations") &&
        chat.includes("linkChatReservationProviderRequest") &&
        chat.includes('responseHeaders?.["x-request-id"]') &&
        // The review's correlation moved into the shared service both routes
        // call, so a guest run is reconciled by exactly the same path.
        read("lib/comparisonReviewService.ts").includes(
          "linkChatReservationProviderRequest"
        ) &&
        review.includes("runComparisonReview") &&
        cron.includes('"cronSchedule": "*/15 * * * *"') &&
        cron.includes('"startCommand": "npm run maintenance:credit-reservations"') &&
        runner.includes("/api/internal/maintenance/credit-reservations")
      );
    },
  },
  {
    name: "Full admin user export remains admin-only, rate-limited, and non-cacheable",
    file: "app/api/admin/users/export/route.ts",
    test: (source) =>
      source.includes("isAdminSession(session)") &&
      source.includes('"admin-users-export"') &&
      source.includes('"Cache-Control": "private, no-store, max-age=0"') &&
      source.includes("getAdminUsersExportBatch") &&
      source.includes("new ReadableStream") &&
      source.includes('"X-Accel-Buffering": "no"'),
  },
  {
    name: "Daily full security audit is isolated from pull requests and main pushes",
    file: ".github/workflows/daily-security-audit.yml",
    test: (source) => {
      const reporter = read("scripts/send-security-audit-report.mjs");
      const resendEndpoint = reporter.match(
        /const sendEmails[\s\S]*?fetch\(\s*"([^"]+)"\s*,/
      )?.[1];
      return (
        source.includes("name: Daily Security Audit") &&
        source.includes('cron: "0 21 * * *"') &&
        source.includes("workflow_dispatch:") &&
        !source.includes("pull_request:") &&
        !source.includes("push:") &&
        source.includes("actions: read") &&
        source.includes("gitleaks/gitleaks-action@v3") &&
        source.includes("actions/checkout@v6") &&
        source.includes("actions/setup-node@v6") &&
        source.includes("actions/cache@v5") &&
        source.includes("actions/upload-artifact@v7") &&
        source.includes("fetch-depth: 0") &&
        source.includes("npm audit --omit=dev --json") &&
        source.includes("npm run typecheck") &&
        source.includes("npm run check") &&
        // Both browsers, through the retry wrapper. The literal command was
        // pinned here until 2026-08-05, when an apt transaction that nothing
        // retried started costing whole jobs; what this guard cares about is
        // unchanged -- this workflow installs the two browsers it runs.
        source.includes("scripts/ci/install-playwright.sh chromium webkit") &&
        source.includes("npm run test:e2e:run") &&
        // Under tsx since 2026-08-21: the reporter resolves its From through
        // lib/emailSendingIdentityCore.ts rather than its own literal, and that
        // module is TypeScript. Sharing the resolver is the point -- a second
        // copy of the rules is what left this sender on the old domain when the
        // transactional domain moved (docs/ops/email-sending-domains.md §1.2).
        source.includes(
          "node --import tsx scripts/send-security-audit-report.mjs"
        ) &&
        source.includes('check_result "Unit and API policy tests"') &&
        source.includes('check_result "Independent TypeScript validation"') &&
        source.includes('check_result "Full desktop and mobile E2E"') &&
        source.includes("SECURITY_AUDIT_SLACK_WEBHOOK_URL") &&
        source.includes("SECURITY_AUDIT_EMAILS") &&
        source.includes("RESEND_API_KEY") &&
        reporter.includes("<!channel>") &&
        reporter.includes("SECURITY_AUDIT_TYPECHECK_STATUS") &&
        reporter.includes("SECURITY_AUDIT_E2E_STATUS") &&
        resendEndpoint === "https://api.resend.com/emails" &&
        reporter.includes("Australia/Brisbane") &&
        read("package.json").includes(
          '"test:unit": "node scripts/run-unit-tests.mjs"'
        ) &&
        read("scripts/run-unit-tests.mjs").includes(
          'name.endsWith(".test.mjs") || name.endsWith(".test.ts")'
        ) &&
        !source.includes("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION")
      );
    },
  },
  {
    name: "CodeQL can read workflow metadata and upload code-scanning results",
    file: ".github/workflows/codeql.yml",
    test: (source) =>
      source.includes("actions: read") &&
      source.includes("contents: read") &&
      source.includes("security-events: write") &&
      source.includes("github/codeql-action/init@v4") &&
      source.includes("github/codeql-action/analyze@v4"),
  },
  {
    // PR Fast Gate runs the `@smoke` tier rather than the whole
    // desktop-chromium project. That is only sound while the tier is
    // manifest-verified before it runs, and while the tests it no longer
    // runs still execute unfiltered on main push and nightly -- so those
    // are asserted here together, as one invariant.
    name: "PR, main, and nightly workflows split browser coverage without rebuilding E2E",
    file: "playwright.config.ts",
    test: (source) => {
      const packageSource = read("package.json");
      const prWorkflow = read(".github/workflows/pr-fast-gate.yml");
      const mainWorkflow = read(".github/workflows/e2e.yml");
      const dailyWorkflow = read(".github/workflows/daily-security-audit.yml");
      const visualWorkflow = read(".github/workflows/nightly-visual-regression.yml");
      const recorderWorkflow = read(
        ".github/workflows/visual-baseline-record.yml"
      );
      const smokeVerifier = read("scripts/verify-smoke-coverage.mjs");
      // Every assertion below is a substring match, and a substring match
      // cannot tell a live workflow from a dead one. Structure is checked
      // first so the rest means something.
      const structurallyBroken = workflowFiles().filter(
        (path) => unparseableWorkflowLines(read(path)).length > 0
      );
      if (structurallyBroken.length > 0) {
        console.error(
          `Workflow files break out of a YAML block: ${structurallyBroken.join(", ")}`
        );
        return false;
      }
      return (
        source.includes("tomverse-e2e-nextauth-secret-only-2026") &&
        source.includes("NEXTAUTH_SECRET: e2eNextAuthSecret") &&
        source.includes('name: "mobile-safari"') &&
        packageSource.includes(
          '"test:e2e:run": "playwright test"'
        ) &&
        packageSource.includes(
          '"test:e2e:pr": "playwright test --project=desktop-chromium"'
        ) &&
        packageSource.includes(
          '"test:e2e:smoke": "playwright test --project=desktop-chromium --grep=@smoke"'
        ) &&
        // UI-008: the high-risk UI tier. It must stay a *tag* filter over the
        // two Chromium projects -- desktop for the contrast and typography
        // checks, mobile for the coarse-pointer and keyboard ones, because
        // useIsMobileShell needs a coarse pointer before the mobile branch
        // renders at all.
        packageSource.includes(
          '"test:e2e:ui-risk": "playwright test --project=desktop-chromium --project=mobile-chromium --grep=@ui-risk"'
        ) &&
        packageSource.includes(
          '"check": "eslint . --max-warnings=0 && next build"'
        ) &&
        packageSource.includes(
          '"typecheck": "next typegen && tsc --noEmit --incremental false"'
        ) &&
        prWorkflow.includes("pull_request:") &&
        !prWorkflow.includes("push:") &&
        prWorkflow.includes("actions: read") &&
        prWorkflow.includes("pull-requests: read") &&
        // Branch protection on develop and main references check runs by
        // name, and this is the required one. PR Fast Gate aggregates three
        // parallel jobs, so the aggregating job must keep this exact name --
        // renaming it leaves every open PR waiting on a check that no longer
        // reports.
        prWorkflow.includes(
          "name: Security, unit, build, and Chromium smoke tests"
        ) &&
        // The aggregating job must treat anything other than `success` as a
        // failure. A skipped or cancelled upstream job has verified nothing,
        // and accepting either is how an aggregating gate goes green without
        // gating.
        prWorkflow.includes('if [ "$result" != "success" ]') &&
        // Secret scanning stays in this workflow: the aggregating job is the
        // only required status check on develop and main, so dropping the
        // scan would take gitleaks off the merge-blocking path.
        prWorkflow.includes("gitleaks/gitleaks-action@v3") &&
        prWorkflow.includes('GITLEAKS_ENABLE_COMMENTS: "false"') &&
        prWorkflow.includes("fetch-depth: 0") &&
        prWorkflow.includes("npm run security:regression") &&
        prWorkflow.includes("npm run test:unit") &&
        prWorkflow.includes("npm run check:encoding:strict") &&
        // `npm run check` is split into its two halves here for step-level
        // timing; both halves must still run, at the same strictness.
        prWorkflow.includes("npx eslint . --max-warnings=0") &&
        prWorkflow.includes("npm run build") &&
        // The smoke manifest is verified before the smoke tests run, so a
        // tier that has silently lost its billing/credit/auth contracts
        // fails instead of passing an empty gate.
        prWorkflow.includes("npm run verify:smoke-coverage") &&
        prWorkflow.includes("npm run test:e2e:smoke") &&
        // The server-contract suite runs in its own process, so it is easy to
        // leave out of a workflow and impossible to notice: it was absent from
        // CI entirely until 2026-08-02, named only in audit write-ups. It
        // carries the guard on #250's cost-basis disclosure and on "a rejected
        // chat request reaches no provider", so it fails closed here.
        prWorkflow.includes("npm run test:server-contract") &&
        packageSource.includes(
          '"test:server-contract": "node scripts/run-server-contract-tests.mjs"'
        ) &&
        // The UI-001/002/003/006/007 regressions are merge-blocking on
        // develop, not something main finds after the fact.
        //
        // The tier is sharded by Chromium project, so "it runs" and "it gates"
        // are two separate facts and both are checked. A substring match on
        // the run command alone would still pass if the shard job were dropped
        // from the required check's `needs` -- the tier would run and block
        // nothing, which is the failure this assertion exists to catch.
        prWorkflow.includes("npm run test:e2e:ui-risk:shard") &&
        packageSource.includes(
          '"test:e2e:ui-risk:shard": "node scripts/run-ui-risk-shard.mjs"'
        ) &&
        prWorkflow.includes("UI_RISK: ${{ needs.ui-risk.result }}") &&
        prWorkflow.includes('"ui-risk=$UI_RISK"') &&
        // UI-012: accent colours stay addressed by role, checked before the
        // browser tier because it needs neither a build nor a browser.
        prWorkflow.includes("npm run check:accent-tokens") &&
        packageSource.includes(
          '"check:accent-tokens": "node scripts/check-accent-tokens.mjs"'
        ) &&
        prWorkflow.includes("scripts/ci/install-playwright.sh chromium") &&
        !prWorkflow.includes("chromium webkit") &&
        // No tier that *judges* a golden may rewrite one.
        !prWorkflow.includes("--update-snapshots") &&
        !visualWorkflow.includes("--update-snapshots") &&
        !mainWorkflow.includes("--update-snapshots") &&
        !dailyWorkflow.includes("--update-snapshots") &&
        // Recording is allowed in exactly one workflow, and only under the
        // conditions that make it reviewable: run by hand, on the canonical
        // image, onto a throwaway branch. Without these it would be an
        // automatic way to overwrite the baseline that the tiers above exist
        // to defend.
        recorderWorkflow.includes("workflow_dispatch:") &&
        !/^\s{2}(push|pull_request|schedule):/m.test(recorderWorkflow) &&
        recorderWorkflow.includes("runs-on: ubuntu-24.04") &&
        recorderWorkflow.includes("--update-snapshots") &&
        recorderWorkflow.includes('branch="visual-baseline/') &&
        !/git push origin (main|develop)\b/.test(recorderWorkflow) &&
        // The smoke tier is a reviewed manifest, not a tag count, and it is
        // capped so it cannot grow back into a second regression suite.
        smokeVerifier.includes("MANIFEST") &&
        smokeVerifier.includes("MAX_SMOKE_TESTS") &&
        smokeVerifier.includes("creditPreflight") &&
        smokeVerifier.includes("chat-state-visual-regression.spec.ts") &&
        // Which spec runs in which tier is documented, and the document is
        // the thing reviewers read -- so it has to exist.
        read(".github/audits/ui-test-tiers.md").includes("@ui-risk") &&
        // Everything the PR tier stopped running still runs here, unfiltered.
        mainWorkflow.includes("push:") &&
        !mainWorkflow.includes("pull_request:") &&
        mainWorkflow.includes("npm run build") &&
        mainWorkflow.includes("npm run test:e2e:chromium") &&
        !mainWorkflow.includes("--grep") &&
        dailyWorkflow.includes("npm run test:e2e:run") &&
        dailyWorkflow.includes("chromium webkit") &&
        !dailyWorkflow.includes("--grep") &&
        // The visual-regression suite dropped from the PR tier has an
        // explicit nightly home of its own, and the zero-retry bar it is
        // gated on lives there with it. `--retries=0` overrides the config's
        // CI `retries: 2`; without it a flaky golden passes on retry and the
        // one workflow that exists to catch that reports green.
        visualWorkflow.includes("npm run test:e2e:visual") &&
        visualWorkflow.includes("--retries=0") &&
        visualWorkflow.includes("schedule:") &&
        visualWorkflow.includes("contents: read") &&
        // ...and it must not creep back into the PR gate. The smoke-tier
        // manifest already refuses the @smoke tag on this file, but naming
        // the spec directly in a workflow step bypasses that check entirely,
        // which is how it previously ended up costing every PR ~82s.
        !prWorkflow.includes("chat-state-visual-regression") &&
        !prWorkflow.includes("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION") &&
        !mainWorkflow.includes("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION") &&
        // Every push to main is a release and needs its own verdict, so this
        // run must not cancel its predecessor. `cancel-in-progress: false` is
        // half of it: the default group still holds only one pending run, and
        // a third arrival evicts it, so a release burst loses the middle of
        // the sequence. `queue: max` is the half that preserves a verdict per
        // SHA. Asserted together because either alone is a silent regression
        // -- nothing fails at the time, the runs simply stop existing.
        //
        // Read from the workflow-level `concurrency:` block rather than from
        // the file, because the header comment above it quotes the forbidden
        // combination in prose; a whole-file match reads that as the setting.
        workflowConcurrencyBlock(mainWorkflow).includes(
          "cancel-in-progress: false"
        ) &&
        workflowConcurrencyBlock(mainWorkflow).includes("queue: max") &&
        // Not merely wrong together: GitHub rejects the workflow outright,
        // which would take the canonical run offline rather than weaken it.
        !workflowConcurrencyBlock(mainWorkflow).includes(
          "cancel-in-progress: true"
        )
      );
    },
  },
  {
    // The third way a golden stops judging anything, after the two below: not
    // a flag in a workflow and not a substitute browser, but the config's own
    // default. `updateSnapshots` defaults to "missing", which writes a
    // baseline that does not exist yet and reports the test passed -- so a
    // platform with no goldens produces a green run and a directory of files
    // nobody reviewed, and the two are indistinguishable afterwards.
    //
    // Asserted here rather than left to review because the failure is
    // invisible in CI: the canonical image always has its baselines, so the
    // setting only matters on the runs that are not it, and those are the
    // runs whose output gets committed.
    name: "A missing visual baseline fails instead of being written",
    file: "playwright.config.ts",
    test: (source) =>
      /^\s*updateSnapshots:\s*"none",$/m.test(source) &&
      // Recording still has to work, or the guard would leave no way to move
      // a baseline at all. The recorder passes the CLI flag, which overrides
      // the config -- the assertion that only that one workflow carries it
      // lives in the workflow entry above.
      read(".github/workflows/visual-baseline-record.yml").includes(
        "--update-snapshots"
      ),
  },
  {
    // The goldens report `Not verified` on a substitute browser instead of a
    // red diff (tests/e2e/support/canonical-visual.ts). That is only safe
    // while no workflow can put CI into the substitute case: a runner with
    // PLAYWRIGHT_CHROMIUM_EXECUTABLE set would skip every golden and still
    // report green, which is a quieter version of the `--update-snapshots`
    // failure the checks above already refuse.
    name: "Goldens are skipped as Not verified off-canonical, and no workflow can put CI there",
    file: "tests/e2e/support/canonical-visual.ts",
    test: (source) => {
      const setsExecutable = workflowFiles().filter((path) =>
        read(path).includes("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
      );
      if (setsExecutable.length > 0) {
        console.error(
          `Workflows must not set PLAYWRIGHT_CHROMIUM_EXECUTABLE -- it would skip every golden: ${setsExecutable.join(", ")}`
        );
        return false;
      }
      return (
        source.includes("PLAYWRIGHT_CHROMIUM_EXECUTABLE") &&
        source.includes("Not verified -- non-canonical browser") &&
        source.includes("docs/qa/canonical-visual-baseline.md") &&
        // Skipping is the whole mechanism; re-recording from here is the
        // outcome the policy exists to prevent, so the guard must never
        // reach for it.
        !source.includes("--update-snapshots") &&
        // Both golden surfaces are wired to it. A guard nothing calls is
        // indistinguishable from no guard.
        //
        // For the chat-state suite the wiring is `expectStableScreenshot`, the
        // single choke point every golden in that file captures through. It
        // used to be a `test.beforeEach` on the file, which is the same
        // mistake this entry already refuses one line down for the composer
        // spec -- and it cost more here: 18 of that file's 81 tests take no
        // screenshot, and all 18 were skipped on any substitute browser,
        // including the credit-pack dialog's focus assertion the nightly used
        // to catch the focus race on 18d1e891.
        chatStateGateIsAtTheCapture() &&
        // Scoped to the visual-record block, not the file. Hoisting the gate
        // to the top level would read identically as a substring while
        // silently taking the 30 geometry and behaviour tests out of every
        // substitute environment -- and those are exactly the coverage the
        // PLAYWRIGHT_CHROMIUM_EXECUTABLE fallback exists to buy back. The
        // import above the block is not a call and does not count.
        composerGateIsScopedToTheVisualBlock() &&
        read("docs/qa/canonical-visual-baseline.md").includes(
          "skipUnlessCanonicalVisualBrowser"
        )
      );
    },
  },
  {
    // #232 replaced a manual recovery step with this workflow, and the release
    // checklist now says to verify rather than perform it. What makes that
    // safe is the `verify` job: without it, a back-merge that conflicted or was
    // refused would leave main outside develop's ancestry silently, which is
    // the exact failure the manual step used to catch by being on a checklist.
    // `if: always()` is load-bearing -- verify runs *because* the back-merge
    // may have failed, so a `needs:` without it would skip precisely when the
    // invariant most needs reporting.
    name: "The main-into-develop back-merge is automated and its ancestry check cannot be skipped",
    file: ".github/workflows/back-merge-main-to-develop.yml",
    test: (source) => {
      const checklist = read(".github/RELEASE_CHECKLIST.md");
      // Both strings below appear more than once in this file -- in the header
      // commentary as well as in the steps -- so a whole-file substring match
      // passes while the step that matters has been gutted. Measured: rewriting
      // the merge step's `--no-ff` and the verify step's ancestry command both
      // left a whole-file check green. Slice to the job that has to carry each.
      const verifyAt = source.indexOf("\n  verify:");
      const backMergeAt = source.indexOf("\n  back-merge:");
      if (verifyAt < 0 || backMergeAt < 0 || backMergeAt > verifyAt) {
        console.error(
          "back-merge-main-to-develop.yml no longer has a back-merge job followed by a verify job."
        );
        return false;
      }
      const backMergeJob = source.slice(backMergeAt, verifyAt);
      const verifyJob = source.slice(verifyAt);
      return (
        // Fires on the event that opens the gap, not on a schedule.
        /^on:\s*$/m.test(source) &&
        source.includes("push:") &&
        source.includes("      - main") &&
        // A merge commit is the entire point: the second parent is what
        // carries the ancestry, so this must not become a fast-forward or a
        // rebase, either of which would leave nothing recording it.
        backMergeJob.includes("git merge --no-ff origin/main") &&
        !backMergeJob.includes("--ff-only") &&
        !backMergeJob.includes("git rebase") &&
        // The guard, and the one command that decides the invariant. Both have
        // to be in the verify job itself: `if: always()` anywhere else does
        // not make this one run after a failed back-merge, which is the only
        // time it matters.
        verifyJob.includes("if: always()") &&
        verifyJob.includes(
          "git merge-base --is-ancestor origin/main origin/develop"
        ) &&
        // A refused push -- the merge already succeeded, so there is nothing
        // to judge -- recovers into a pull request.
        backMergeJob.includes("automation/back-merge-main-") &&
        // A *conflict* does not. It aborts and exits non-zero, pushing no
        // branch and opening no pull request, because a machine cannot know
        // which side to keep. Pinned because "recover from both" is the
        // intuitive reading and the documentation drifted into it once
        // already: the checklist, this workflow's header and the automated
        // pull request's own body all claimed a conflict opened a pull
        // request, which it never did.
        //
        // Read from the fallback step alone, and as an *ordering*: the
        // conflict exit has to come before the push. `git merge --abort`
        // appears in the earlier merge step too, so a job-wide substring
        // match stays green with the fallback's own abort deleted -- measured,
        // which is why this is not a substring match.
        conflictExitsBeforeAnyPush(backMergeJob) &&
        // It may only ever move develop. A back-merge that could push main
        // would be a way to move the release branch outside a review.
        !/git push (-u )?origin main\b/.test(source) &&
        // The checklist has to agree that this is automated, or an operator
        // following it by hand races the workflow for the same ref.
        checklist.includes("back-merge-main-to-develop.yml") &&
        // Matched across a line wrap: the checklist is hard-wrapped, so the
        // sentence moves whenever the paragraph above it is edited.
        /Do not perform\s+the back-merge by hand/.test(checklist) &&
        // ...and it has to state the conflict path correctly. The wrong
        // version sent an operator looking for a pull request that is never
        // opened, on the one path where the recovery is entirely manual.
        /does not\s+open a pull request/.test(checklist) &&
        !/On a merge conflict, or when the push/.test(checklist)
      );
    },
  },
  {
    name: "Financial DB gate is path-scoped on PRs but always available on main and manual runs",
    file: ".github/workflows/credit-finance-db-integration.yml",
    test: (source) =>
      source.includes("pull_request:") &&
      source.includes("paths:") &&
      source.includes('"prisma/**"') &&
      source.includes('"lib/chatSecurity.ts"') &&
      source.includes('"lib/credit*.ts"') &&
      source.includes('"lib/billing*.ts"') &&
      source.includes('"lib/stripe*.ts"') &&
      source.includes('"app/api/billing/**"') &&
      source.includes('"tests/integration/**"') &&
      source.includes("push:") &&
      source.includes("- main") &&
      source.includes("workflow_dispatch:") &&
      source.includes("actions/checkout@v6") &&
      source.includes("actions/setup-node@v6"),
  },
  {
    // One branch must never grow two PRs. The automation namespaces open
    // their own PRs (cron-auto-fix -> main, feedback-autofix -> develop), so
    // the generic auto-PR workflow has to stay out of them -- a PAT push
    // does trigger workflows, which is exactly how the duplicate happened.
    // Was: "excludes the automation branch namespaces", asserting two entries
    // in a `branches-ignore` list. An exclusion list can only name the cases
    // someone has already been surprised by, and on 2026-08-15 it missed one
    // -- a branch pushed for a `main` PR got a develop PR (#573) with
    // auto-merge enabled, against a base where its change did nothing.
    //
    // The rule is now opt-in: a `to-develop` path segment. What this asserts
    // is that both halves are still in force, because either alone reopens the
    // hole -- a glob without the module cannot refuse `autofix/to-develop/...`,
    // and the module without the glob would run the job on every push.
    name: "Auto PR to Develop opens a PR only for branches that name develop as their target",
    file: ".github/workflows/auto-pr-to-develop.yml",
    test: (source) => {
      const policy = read("scripts/auto-pr-branch-policy.mjs");
      // The whole list, not a match inside it. A pattern that only asserted
      // the two entries were present would pass with `- "claude/**"` appended
      // underneath them, which is the opt-out rule restored one line at a
      // time.
      const listed = (() => {
        const at = source.search(/^\s*branches:\s*$/m);
        if (at === -1) return null;
        const entries = [];
        for (const line of source.slice(at).split("\n").slice(1)) {
          const item = /^\s+-\s+(.*\S)\s*$/.exec(line);
          if (!item) break;
          entries.push(item[1].replace(/^"|"$/g, ""));
        }
        return entries;
      })();
      return (
        !/^\s*branches-ignore:/m.test(source) &&
        listed !== null &&
        listed.length === 2 &&
        listed[0] === "to-develop/**" &&
        listed[1] === "**/to-develop/**" &&
        source.includes('node scripts/auto-pr-branch-policy.mjs "$BRANCH"') &&
        // Every step that creates a pull request or arranges its merge, plus
        // the diff check they both read. A step left ungated would run on a
        // widened glob alone.
        (source.match(/steps\.target\.outputs\.create == 'true'/g) ?? []).length === 3 &&
        // The namespaces that open their own PRs are still refused, and still
        // refused ahead of the marker -- `feedback-autofix` records the number
        // of the PR its own workflow created, so a second one is not a
        // duplicate but a wrong answer.
        policy.includes('"dependabot"') &&
        policy.includes('"autofix"') &&
        policy.includes('"feedback-autofix"') &&
        policy.indexOf("AUTOMATION_NAMESPACES") < policy.indexOf("TARGET_MARKER") &&
        policy.includes('PRODUCTION_NAMESPACES = ["to-main", "release", "hotfix"]')
      );
    },
  },
  {
    // Phase 3 fix workflow supply chain and trigger surface: dispatch-only
    // (a schedule is a §9 go-live decision), never pull_request_target, and
    // every third-party executable pinned by SHA or integrity hash.
    name: "Feedback auto-fix workflow is dispatch-only with pinned supply chain",
    file: ".github/workflows/feedback-autofix.yml",
    test: (source) =>
      source.includes("workflow_dispatch:") &&
      !source.includes("pull_request_target") &&
      !source.includes("schedule:") &&
      source.includes(
        "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"
      ) &&
      source.includes(
        "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"
      ) &&
      source.includes("CLAUDE_CODE_INTEGRITY"),
  },
  {
    // Token separation: the LLM step must not see the GitHub PAT or the sync
    // secret, and the PR step must not see the LLM key. Checked per step
    // block so a refactor cannot silently co-locate them.
    name: "Feedback auto-fix workflow separates its credentials by step",
    file: ".github/workflows/feedback-autofix.yml",
    test: (source) => {
      const steps = source.split(/\n {6}- name: /);
      const fixStep = steps.find((step) => step.startsWith("Attempt the fix"));
      const prStep = steps.find((step) =>
        step.startsWith("Push the branch and open the develop PR")
      );
      return (
        Boolean(fixStep) &&
        Boolean(prStep) &&
        fixStep.includes("FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY") &&
        !fixStep.includes("GH_AUTOMATION_PAT") &&
        !fixStep.includes("FEEDBACK_AUTOFIX_SYNC_SECRET") &&
        prStep.includes("GH_AUTOMATION_PAT") &&
        !prStep.includes("ANTHROPIC") &&
        !prStep.includes("FEEDBACK_AUTOFIX_SYNC_SECRET") &&
        !prStep.includes("--auto")
      );
    },
  },
  {
    // The auto-PR guard decides whether a branch gets a pull request at all,
    // and it used to answer that question from a measurement it had broken
    // itself: a `--depth=1` fetch re-shallowed the full history
    // actions/checkout had just fetched, `merge-base` then had nothing to
    // walk once develop moved on, and the three-dot diff failed rather than
    // reporting "no changes". The `if` read the failure as a diff and opened
    // PR #467 for work already merged.
    //
    // Pinned as three separate properties, because dropping any one of them
    // brings the same false positive back: no shallow fetch of develop, an
    // explicit containment test, and an unanswerable merge-base treated as an
    // error instead of as a yes.
    name: "Auto PR guard cannot mistake a broken merge-base for a diff",
    file: ".github/workflows/auto-pr-to-develop.yml",
    test: (source) => {
      // Comment lines are stripped first: the comment above the step quotes
      // the old `--depth=1` command on purpose, and a check that read it
      // would fail on the very explanation of what it is guarding.
      const script = source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      return (
        !/git fetch origin develop\s+--depth/.test(script) &&
        script.includes("git merge-base --is-ancestor HEAD origin/develop") &&
        script.includes(
          "if ! git merge-base origin/develop HEAD >/dev/null 2>&1; then"
        )
      );
    },
  },
  {
    name: "image provider budgets follow who bills us, never who made the model",
    file: "lib/imageProviderBudget.ts",
    // Nano Banana 2 is Google's model bought from fal, so those two answers
    // came apart. The budget module must keep asking the first question: a fal
    // request drawing down IMAGE_PROVIDER_GOOGLE_COST_* still adds up, it just
    // adds up against an envelope with no money in it while fal's real spend
    // goes unwatched -- and every number downstream stays plausible.
    //
    // Reading for the *absence* of the brand field rather than the presence of
    // the right one, because the mistake is additive: someone reaches for
    // `imageModelOwner()` here to make a metric read nicely, and nothing else
    // in the system objects.
    test: (source) => {
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      return (
        !code.includes("modelOwner") &&
        !code.includes("imageModelOwner") &&
        code.includes("ImageModelProvider")
      );
    },
  },
  {
    name: "readiness checks the provider that holds the credential",
    file: "lib/imageModelRegistry.ts",
    // `listActiveImageProviders` is what readiness and the budget guard walk.
    // It must map over `provider`; mapping over the owner would have readiness
    // demand a Google budget for a model Google never bills us for.
    test: (source) =>
      /listActiveImageProviders[\s\S]{0,220}map\(\(model\) => model\.provider\)/.test(
        source
      ),
  },
  {
    name: "the fal adapter never retries a request that may already have been billed",
    file: "lib/imageProviderAdapter.ts",
    // The other three adapters retry, and correctly: an unbilled failure costs
    // nothing to attempt again. Here a generation that succeeded and lost its
    // response is indistinguishable from a transport failure, and retrying it
    // buys a second image at a second charge while the user pays one fixed
    // price. Read as the absence of a loop in this function, because the
    // mistake would arrive as consistency -- someone making all four adapters
    // look alike.
    test: (source) => {
      const start = source.indexOf("const generateWithFal");
      if (start < 0) return false;
      const end = source.indexOf("\nconst ", start + 10);
      const body = source.slice(start, end < 0 ? undefined : end);
      return (
        !/\bfor\s*\(|\bwhile\s*\(|lastError/.test(body) &&
        body.includes('"X-Fal-No-Retry"') === false &&
        body.includes("falPlatformHeaders()")
      );
    },
  },
  {
    name: "fal asset downloads are host-checked after redirects, not only before",
    file: "lib/imageProviderAdapter.ts",
    // An allowlisted URL that redirects elsewhere walks straight past the
    // check it just passed, which turns the provider's response body into a
    // request we make on its behalf. `redirect: "manual"` plus a check on the
    // resolved response is what closes it.
    test: (source) => {
      const start = source.indexOf("const generateWithFal");
      if (start < 0) return false;
      const end = source.indexOf("\nconst ", start + 10);
      const body = source.slice(start, end < 0 ? undefined : end);
      return (
        body.includes('redirect: "manual"') &&
        body.includes("isFalAssetUrl(asset.url)") &&
        body.includes("falAssetLengthRefused(asset.headers.get")
      );
    },
  },
  {
    name: "the fal request pins every field its approved price was computed from",
    file: "lib/falImageRequest.ts",
    // 120 credits rest on a floor of 97, and that floor is arithmetic over a
    // specific request. A field quietly dropped here does not break anything
    // visible -- it just makes the audit trail describe a request the product
    // no longer makes.
    test: (source) =>
      [
        "num_images: 1",
        'aspect_ratio: "1:1"',
        'thinking_level: "high"',
        "enable_web_search: false",
        "limit_generations: true",
        'system_prompt: ""',
      ].every((field) => source.includes(field)),
  },
  {
    name: "the fal thinking cap and the fal request agree about thinking",
    file: "lib/falImageRequest.ts",
    // These two drifted apart within a day of being written: the cap was
    // described as a bound that held "whatever the request asks", while the
    // request had already been pinned to ask for `high`, and the policy text
    // still said high thinking was off. The number and the field are one
    // decision -- 2,000 microUSD of a 87,000 worst case and a floor of 97 --
    // and nothing but a check keeps them saying the same thing.
    test: (source) => source.includes('thinking_level: "high"'),
  },
];

const failures = [];
for (const check of checks) {
  const source = read(check.file);
  if (!check.test(source)) {
    failures.push(`${check.name} (${check.file})`);
  }
}

if (failures.length > 0) {
  console.error("Security regression checks failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Security regression checks passed (${checks.length} checks).`);
