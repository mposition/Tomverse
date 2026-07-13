import { readFileSync } from "node:fs";

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
    name: "/api/chat has guest verification and model tier checks",
    file: "app/api/chat/route.ts",
    test: (source) =>
      source.includes("assertModelAccess(access, modelConfig)") &&
      source.includes("getUserBillingPlan") &&
      source.includes("verifyGuestTurnstile"),
  },
  {
    name: "Chat usage limits reserve tokens, cost, provider budget, and lease",
    file: "lib/chatSecurity.ts",
    test: (source) =>
      source.includes("CHAT_USER_TOKENS_PER_DAY") &&
      source.includes("CHAT_USER_COST_MICROUSD_PER_DAY") &&
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
      source.includes("strategy: \"database\"") &&
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
      source.includes("setProviderCreditCheckpoint") &&
      source.includes("writeAdminAuditLog") &&
      source.includes('action: "provider_credit.checkpoint_updated"'),
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
    name: "Production health fails closed on weak security configuration",
    file: "app/api/health/route.ts",
    test: (source) =>
      source.includes("getSecurityEnvironmentStatus") &&
      source.includes("status: ready ? 200 : 503"),
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
