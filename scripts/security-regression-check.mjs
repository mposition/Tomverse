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
      source.includes("select: { plan: true }") &&
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
      source.includes("oauthTokensEncrypted"),
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
    name: "Public share reads require strong tokens, rate limit, cache headers",
    file: "app/api/public/shares/[shareToken]/route.ts",
    test: (source) =>
      source.includes("isStrongShareToken") &&
      source.includes("public-share-read") &&
      source.includes("Cloudflare-CDN-Cache-Control"),
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
