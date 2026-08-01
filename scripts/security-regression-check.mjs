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
        decisions.includes("futureResetAt") &&
        source.includes("safeDailyResetAt")
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
    name: "Provider error events expire through maintenance cleanup",
    file: "lib/maintenance.ts",
    test: (source) =>
      source.includes("providerErrorEvent.deleteMany") &&
      source.includes("30 * 24 * 60 * 60 * 1000") &&
      source.includes("providerErrorEvents.count"),
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
    name: "Liveness and readiness bypass canonical host protection",
    file: "proxy.ts",
    test: (source) =>
      source.includes('request.nextUrl.pathname === "/api/health"') &&
      source.includes('request.nextUrl.pathname === "/api/ready"'),
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
      source.includes('internalBudgetSource: "railway_environment" | "code_default"') &&
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
    name: "Checkout disables Stripe code bypass and applies validated promotion IDs",
    file: "app/api/billing/checkout/route.ts",
    test: (source) =>
      source.includes("validatePromotionForCheckout") &&
      source.includes("allow_promotion_codes: false") &&
      source.includes("promotion_code:") &&
      source.includes("reservePromotionCheckout") &&
      !source.includes("promoCode: appliedPromotion"),
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
        [...layout.matchAll(/\(await headers\(\)\)\.get\(([^)]*)\)/g)].map(
          (match) => match[1].trim()
        );
      const siteReads = requestReadsIn(rootLayouts[0]);
      const localeReads = requestReadsIn(rootLayouts[1]);
      return (
        source.includes('export const dynamic = "force-static"') &&
        source.includes("export const revalidate = false") &&
        applicationLayout.includes('export const dynamic = "force-dynamic"') &&
        applicationLayout.includes("getServerSession(authOptions)") &&
        // VAL-004 narrowed this rule rather than relaxing it. A root layout may
        // read the document language the proxy resolved and nothing else --
        // reading a session, a cookie or the database there would put per-user
        // state above every route under that root.
        siteReads.length === 1 &&
        siteReads[0] === "DOCUMENT_LANGUAGE_HEADER" &&
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
        source.includes("playwright install --with-deps chromium webkit") &&
        source.includes("npm run test:e2e:run") &&
        source.includes("node scripts/send-security-audit-report.mjs") &&
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
        // The UI-001/002/003/006/007 regressions are merge-blocking on
        // develop, not something main finds after the fact.
        prWorkflow.includes("npm run test:e2e:ui-risk") &&
        // UI-012: accent colours stay addressed by role, checked before the
        // browser tier because it needs neither a build nor a browser.
        prWorkflow.includes("npm run check:accent-tokens") &&
        packageSource.includes(
          '"check:accent-tokens": "node scripts/check-accent-tokens.mjs"'
        ) &&
        prWorkflow.includes("playwright install --with-deps chromium") &&
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
        !mainWorkflow.includes("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION")
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
