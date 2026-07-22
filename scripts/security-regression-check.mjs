import { readFileSync, statSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

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
    test: (source) =>
      source.includes("CHAT_USER_TOKENS_PER_DAY") &&
      source.includes("getPlanEstimatedCostLimits") &&
      source.includes("CHAT_FREE_COST_MICROUSD_PER_DAY") &&
      source.includes("CHAT_PRO_COST_MICROUSD_PER_DAY") &&
      source.includes("CHAT_MAX_COST_MICROUSD_PER_DAY") &&
      source.includes("provider-cost-month") &&
      source.includes("ChatRequestLease"),
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
        "cachedInputPriceMultiplier: profile.cachedInputPriceMultiplier"
      ) &&
      source.includes("usage.cachedInputTokens") &&
      source.includes("pricingSnapshot: costBreakdown") &&
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
        read("lib/models.ts").includes('"deepseek-v4-flash": {') &&
        read("lib/models.ts").includes('"deepseek-v4-pro": {')
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
    test: (source) =>
      source.includes("providerErrorEvent.create") &&
      source.includes("options.includeErrorEvents") &&
      source.includes('"Bearer [REDACTED]"') &&
      source.includes("safeText(event.message, 500)") &&
      source.includes("safeText(event.traceId, 120)"),
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
      const signup = read("app/(application)/auth/signin/page.tsx");
      const chatInput = read("components/chat/ChatInput.tsx");
      const migration = read(
        "prisma/migrations/20260714233000_expand_product_analytics_funnel/migration.sql"
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
        "prisma/migrations/20260715093000_add_model_finder_preferences/migration.sql"
      );
      const dismissalMigration = read(
        "prisma/migrations/20260715220000_add_model_finder_dismissed_at/migration.sql"
      );
      return (
        source.includes("getServerSession(authOptions)") &&
        source.includes("readLimitedJson(req, 8 * 1024, actionSchema)") &&
        source.includes("isModelFinderDefaultId(body.defaultModelId)") &&
        source.includes("getModelFinderRecommendations(body.answers)") &&
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
        source.includes('body.action === "dismiss"') &&
        source.includes("shouldAutoShowModelFinder") &&
        component.includes('action: method === "default" ? "accept_default" : "dismiss"') &&
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
    file: "prisma/migrations/20260714190000_configure_tomverse50_public_launch/migration.sql",
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
    file: "prisma/migrations/20260716150000_founding_tester_pass/migration.sql",
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
    name: "Global metadata provides canonical origin, social cards, and optional webmaster verification",
    file: "app/layout.tsx",
    test: (source) =>
      source.includes("metadataBase: new URL(SITE_ORIGIN)") &&
      source.includes('card: "summary_large_image"') &&
      source.includes('url: "/opengraph-image"') &&
      source.includes('url: "/twitter-image"') &&
      source.includes("GOOGLE_SITE_VERIFICATION") &&
      source.includes("BING_SITE_VERIFICATION"),
  },
  {
    name: "Marketing routes are static while application routes retain request-time rendering",
    file: "app/(marketing)/layout.tsx",
    test: (source) => {
      const rootLayout = read("app/layout.tsx");
      const applicationLayout = read("app/(application)/layout.tsx");
      return (
        source.includes('export const dynamic = "force-static"') &&
        source.includes("export const revalidate = false") &&
        applicationLayout.includes('export const dynamic = "force-dynamic"') &&
        applicationLayout.includes("getServerSession(authOptions)") &&
        !rootLayout.includes('from "next/headers"') &&
        !rootLayout.includes("getServerSession") &&
        !rootLayout.includes("prisma")
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
    name: "Structured data is sanitized and identifies the organization and software application",
    file: "app/(marketing)/layout.tsx",
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
    file: "app/(marketing)/[locale]/[intent]/page.tsx",
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
    file: "app/(application)/chat/layout.tsx",
    test: (source) =>
      source.includes("index: false") &&
      read("app/(application)/auth/layout.tsx").includes("index: false") &&
      read("app/(application)/admin/layout.tsx").includes("index: false") &&
      read("app/(application)/share/[shareToken]/page.tsx").includes("index: false"),
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
    test: (source) =>
      source.includes('testId="model-credit-badge"') &&
      source.includes("CreditCostBadge") &&
      read("components/credits/CreditCostBadge.tsx").includes(
        'data-testid="credit-coin-icon"'
      ) &&
      source.includes("getModelPickerDescription") &&
      source.includes("getModelPickerFeatures") &&
      source.includes('data-testid="model-recommendations"') &&
      source.includes('data-testid="recommended-model-option"') &&
      source.includes('data-testid="model-search-input"') &&
      source.includes('data-testid="model-selection-summary"') &&
      source.includes('data-testid="request-credit-estimate"') &&
      !source.includes('data-testid="show-all-models"') &&
      !source.includes('option value="Research"') &&
      !source.includes("usageClassFilter") &&
      read("components/auth/AuthButton.tsx").includes(
        "getModelUsageProfile(model)"
      ),
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
        guide.includes('t("onboarding.compareTitle")') &&
        guide.includes('t("onboarding.privateBody")') &&
        guide.includes('t("auth.login")') &&
        !source.includes('t("auth.signIn")') &&
        !guide.includes("fixed inset-0") &&
        !guide.includes('aria-modal="true"') &&
        source.includes('onFocus={() => dismissGuestQuickStart("completed")}') &&
        source.includes('tomverse_guest_quick_start_seen_v2') &&
        !read("app/(application)/chat/page.tsx").includes("GoLiveOnboarding")
      );
    },
  },
  {
    name: "Analytics consent is compact and waits for the guest quick-start guide",
    file: "components/analytics/AnalyticsProvider.tsx",
    test: (source) =>
      source.includes("usePathname") &&
      source.includes('tomverse:guest-quick-start') &&
      source.includes("consentPromptReady") &&
      source.includes("GUEST_QUICK_START_ACTIVE_KEY") &&
      source.includes("calc(100vw-1rem)") &&
      source.includes("grid-cols-[minmax(0,1fr)_auto]") &&
      source.includes('className="h-8 rounded-lg') &&
      source.includes("env(safe-area-inset-bottom)"),
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
    test: (source) =>
      source.includes('primaryCta: "Start chatting free"') &&
      source.includes('primaryCta: "무료로 채팅 시작하기"') &&
      source.includes('guestNote: "No sign-up required to try a free model."') &&
      source.includes('data-testid="landing-guest-note"') &&
      !source.includes('data-testid="landing-guest-cta"') &&
      source.includes("const primaryChatHref =") &&
      source.includes('cta_location: "landing_hero_chat"') &&
      source.includes("Get a one-minute recommendation after sign-up"),
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
      read("app/(marketing)/chatgpt-vs-claude/page.tsx").includes(
        'template="chatgpt-vs-claude"'
      ),
  },
  {
    name: "Prepared chat comparison validates and bounds URL presets",
    file: "app/(application)/chat/page.tsx",
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
      const capture = read("scripts/capture-marketing-proof.mjs");
      return (
        source.includes("/marketing-proof/tomverse-review-workflow.webm") &&
        source.includes("/marketing-proof/tomverse-review-workflow-poster.png") &&
        source.includes('fetch("/api/public/proof-metrics"') &&
        source.includes("controlled demo data") &&
        source.includes("18-page readiness brief") &&
        source.includes("AI Review compares only the supplied answers") &&
        read("components/marketing/LandingPageContent.tsx").includes(
          "<ProductProofSection />"
        ) &&
        capture.includes('page.route("**/api/chat"') &&
        capture.includes("comparison-reviews") &&
        capture.includes("All three answers recommend measurable launch gates") &&
        capture.includes("One question. Multiple AI answers") &&
        capture.includes('"gpt-5-4-mini"') &&
        capture.includes('"claude-haiku-4-5"') &&
        capture.includes('"gemini-2-5-flash"') &&
        capture.includes("posterPath") &&
        !capture.includes("api.openai.com") &&
        !capture.includes("api.anthropic.com") &&
        statSync("public/marketing-proof/tomverse-review-workflow.webm").size >
          100_000 &&
        statSync("public/marketing-proof/tomverse-review-workflow-poster.png").size >
          20_000
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
        source.includes("configuredPlan.id === plan.id") &&
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
      const route = read(
        "app/api/conversations/[conversationId]/comparison-reviews/route.ts"
      );
      return (
        source.includes("COMPARISON_REVIEW_LIMITS") &&
        source.includes("untrusted DATA, never instructions") &&
        source.includes("Do not call tools, browse") &&
        source.includes("comparisonReviewResultSchema") &&
        route.includes("Output.object({ schema: comparisonReviewResultSchema })") &&
        !route.includes("tools:")
      );
    },
  },
  {
    name: "AI comparison review reserves credits, refunds failures, caches input, and invalidates changed sources",
    file: "app/api/conversations/[conversationId]/comparison-reviews/route.ts",
    test: (source) =>
      source.includes("createComparisonReviewHash") &&
      source.includes("acquireChatAccess") &&
      source.includes('outcome: "failed"') &&
      source.includes("releaseFreeComparisonReview") &&
      source.includes("usageCredits: 0") &&
      read("app/api/chat/route.ts").includes(
        "tx.comparisonReview.updateMany"
      ) &&
      read("app/api/conversations/[conversationId]/messages/route.ts").includes(
        "tx.comparisonReview.updateMany"
      ),
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
        "prisma/migrations/20260715193000_add_credit_debt_and_billing_risk/migration.sql"
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
        "prisma/migrations/20260715213000_add_durable_chat_credit_reservations/migration.sql"
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
        review.includes("linkChatReservationProviderRequest") &&
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
    name: "PR, main, and nightly workflows split browser coverage without rebuilding E2E",
    file: "playwright.config.ts",
    test: (source) => {
      const packageSource = read("package.json");
      const prWorkflow = read(".github/workflows/pr-fast-gate.yml");
      const mainWorkflow = read(".github/workflows/e2e.yml");
      const dailyWorkflow = read(".github/workflows/daily-security-audit.yml");
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
          '"check": "eslint . --max-warnings=0 && next build"'
        ) &&
        packageSource.includes(
          '"typecheck": "next typegen && tsc --noEmit --incremental false"'
        ) &&
        prWorkflow.includes("pull_request:") &&
        !prWorkflow.includes("push:") &&
        prWorkflow.includes("actions: read") &&
        prWorkflow.includes("pull-requests: read") &&
        prWorkflow.includes("gitleaks/gitleaks-action@v3") &&
        prWorkflow.includes('GITLEAKS_ENABLE_COMMENTS: "false"') &&
        prWorkflow.includes("npm run security:regression") &&
        prWorkflow.includes("npm run test:unit") &&
        prWorkflow.includes("npm run check") &&
        prWorkflow.includes("npm run test:e2e:pr") &&
        prWorkflow.includes("playwright install --with-deps chromium") &&
        !prWorkflow.includes("chromium webkit") &&
        mainWorkflow.includes("push:") &&
        !mainWorkflow.includes("pull_request:") &&
        mainWorkflow.includes("npm run build") &&
        mainWorkflow.includes("npm run test:e2e:chromium") &&
        dailyWorkflow.includes("npm run test:e2e:run") &&
        dailyWorkflow.includes("chromium webkit") &&
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
