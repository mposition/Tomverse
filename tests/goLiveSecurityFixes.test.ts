import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  sessionRevocationReason,
  isSessionRevoked,
} from "../lib/sessionRevocationCore.ts";
import {
  isRecentAdminAuthentication,
  resolveRecentAuthMinutes,
} from "../lib/adminReauthenticationCore.ts";
import {
  guestMessageKeysForConversation,
  guestMessagesStorageKey,
  guestMessagesConversationPrefix,
} from "../lib/guestConversationStorage.ts";
import {
  hasValidMutationOrigin,
  requiresMutationOriginCheck,
} from "../lib/requestOrigin.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (relativePath: string) =>
  readFileSync(join(repoRoot, relativePath), "utf8");

/**
 * Drops comments so an assertion cannot be satisfied - or broken - by prose.
 * Several of the checks below search for the absence of a dangerous pattern, and
 * the code that fixed it documents that pattern by name in a comment.
 */
const readRepoCode = (relativePath: string) =>
  readRepoFile(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ---------------------------------------------------------------------------
// SEC-002 - session revocation must work without a Session table.
// Sessions use `session.strategy = "jwt"`, so nothing is stored server-side and
// prisma.session.deleteMany() could never revoke anything.
// ---------------------------------------------------------------------------

const active = (sessionsRevokedAt: Date | string | null = null) => ({
  accountStatus: "active",
  sessionsRevokedAt,
});

test("a token issued before the revocation epoch is rejected", () => {
  const revokedAt = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(
    sessionRevocationReason({
      issuedAt: new Date("2026-07-30T11:59:59.000Z").getTime(),
      snapshot: active(revokedAt),
    }),
    "revoked"
  );
});

test("a token issued exactly at the revocation epoch is rejected", () => {
  const revokedAt = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(
    sessionRevocationReason({
      issuedAt: revokedAt.getTime(),
      snapshot: active(revokedAt),
    }),
    "revoked"
  );
});

test("a token issued after the revocation epoch stays valid", () => {
  assert.equal(
    sessionRevocationReason({
      issuedAt: new Date("2026-07-30T12:00:01.000Z").getTime(),
      snapshot: active(new Date("2026-07-30T12:00:00.000Z")),
    }),
    null
  );
});

test("revocation accepts an ISO issued-at, so pre-existing tokens are still covered", () => {
  assert.equal(
    sessionRevocationReason({
      issuedAt: "2026-07-30T11:00:00.000Z",
      snapshot: active(new Date("2026-07-30T12:00:00.000Z")),
    }),
    "revoked"
  );
});

test("revocation fails closed when the issue time is unusable", () => {
  for (const issuedAt of [null, undefined, "", "not-a-date"]) {
    assert.equal(
      sessionRevocationReason({
        issuedAt,
        snapshot: active(new Date("2026-07-30T12:00:00.000Z")),
      }),
      "missing-issued-at",
      `expected rejection for issuedAt=${String(issuedAt)}`
    );
  }
});

test("a non-active account loses its session regardless of issue time", () => {
  for (const accountStatus of ["suspended", "pending_deletion", "deleted"]) {
    assert.equal(
      sessionRevocationReason({
        issuedAt: Date.now(),
        snapshot: { accountStatus, sessionsRevokedAt: null },
      }),
      "account-not-active",
      `expected rejection for accountStatus=${accountStatus}`
    );
  }
});

test("an active account with nothing revoked keeps its session", () => {
  assert.equal(
    sessionRevocationReason({ issuedAt: Date.now(), snapshot: active() }),
    null
  );
  assert.equal(
    isSessionRevoked({ issuedAt: Date.now(), snapshot: active() }),
    false
  );
});

test("a failed snapshot lookup rejects the session", () => {
  assert.equal(
    sessionRevocationReason({
      issuedAt: Date.now(),
      snapshot: { lookupStatus: "lookup-error" },
    }),
    "lookup-error"
  );
});

test("a token whose user no longer exists is rejected", () => {
  assert.equal(
    sessionRevocationReason({
      issuedAt: Date.now(),
      snapshot: { lookupStatus: "user-not-found" },
    }),
    "user-not-found"
  );
});

test("the isolated E2E database bypass remains explicit", () => {
  assert.equal(
    sessionRevocationReason({ issuedAt: Date.now(), snapshot: null }),
    null
  );
});

test("revokeAllUserSessions bumps the revocation epoch rather than deleting rows only", () => {
  const source = readRepoFile("lib/sessionSecurity.ts");
  assert.match(
    source,
    /sessionsRevokedAt: revokedAt/,
    "revokeAllUserSessions must stamp User.sessionsRevokedAt"
  );
});

test("session resolution consults the revocation epoch", () => {
  const source = readRepoFile("lib/auth.ts");
  assert.match(source, /sessionRevocationReason\(/);
  assert.match(
    source,
    /strategy:\s*"jwt"/,
    "if the session strategy changes, revisit the revocation mechanism"
  );
});

// ---------------------------------------------------------------------------
// SEC-003 - step-up admin auth must be satisfiable. It previously looked the
// session up in the never-populated Session table and so failed closed forever,
// permanently blocking dual-control admin actions and user account deletion.
// ---------------------------------------------------------------------------

test("a fresh sign-in satisfies the step-up authentication check", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(
    isRecentAdminAuthentication({
      authenticatedAt: new Date("2026-07-30T11:45:00.000Z").toISOString(),
      recentAuthMinutes: 30,
      now,
    }),
    true
  );
});

test("an authentication older than the window requires re-authentication", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(
    isRecentAdminAuthentication({
      authenticatedAt: new Date("2026-07-30T11:29:00.000Z").toISOString(),
      recentAuthMinutes: 30,
      now,
    }),
    false
  );
});

test("step-up authentication fails closed for a missing or malformed claim", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  for (const authenticatedAt of [null, undefined, "", "nonsense"]) {
    assert.equal(
      isRecentAdminAuthentication({ authenticatedAt, recentAuthMinutes: 30, now }),
      false,
      `expected rejection for authenticatedAt=${String(authenticatedAt)}`
    );
  }
});

test("a future-dated authentication claim cannot buy an unlimited step-up window", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(
    isRecentAdminAuthentication({
      authenticatedAt: new Date("2026-07-30T13:00:00.000Z").toISOString(),
      recentAuthMinutes: 30,
      now,
    }),
    false
  );
});

test("the step-up window is clamped to a sane range", () => {
  assert.equal(resolveRecentAuthMinutes(undefined), 30);
  assert.equal(resolveRecentAuthMinutes("not-a-number"), 30);
  assert.equal(resolveRecentAuthMinutes("1"), 5);
  assert.equal(resolveRecentAuthMinutes("100000"), 240);
  assert.equal(resolveRecentAuthMinutes("45"), 45);
});

test("step-up authentication no longer depends on the unused Session table", () => {
  const source = readRepoCode("lib/adminReauthentication.ts");
  assert.doesNotMatch(
    source,
    /prisma\.session\.findUnique/,
    "the Session table is never populated under the JWT strategy"
  );
  assert.match(source, /isRecentAdminAuthentication\(/);
});

// ---------------------------------------------------------------------------
// SEC-001 - the proxy is the single enforcement point for the host allowlist,
// the Cloudflare origin secret, the CSRF mutation-origin check and CSP. A
// `missing:` clause in its matcher let any caller skip all four with one header.
// ---------------------------------------------------------------------------

test("the proxy matcher cannot be bypassed by a request header", () => {
  const source = readRepoCode("proxy.ts");
  const configBlock = source.slice(source.indexOf("export const config"));
  assert.doesNotMatch(
    configBlock,
    /missing\s*:/,
    "a `missing:` clause lets callers skip the entire edge security layer"
  );
  assert.doesNotMatch(
    configBlock,
    /\bhas\s*:/,
    "a `has:` clause would make proxy execution conditional on client input"
  );
});

test("the proxy runs its security checks before any prefetch fast path", () => {
  const source = readRepoCode("proxy.ts");
  const hostCheck = source.indexOf("isAllowedRequestHost");
  const originSecretCheck = source.indexOf("hasRequiredOriginSecret");
  const mutationCheck = source.indexOf("hasValidMutationOrigin");
  const prefetchFastPath = source.indexOf("isRouterPrefetch(request)");
  for (const [name, index] of Object.entries({
    hostCheck,
    originSecretCheck,
    mutationCheck,
    prefetchFastPath,
  })) {
    assert.ok(index > 0, `expected to find ${name} in proxy.ts`);
  }
  assert.ok(hostCheck < prefetchFastPath, "host allowlist must run first");
  assert.ok(originSecretCheck < prefetchFastPath, "origin secret must run first");
  assert.ok(mutationCheck < prefetchFastPath, "CSRF check must run first");
});

// ---------------------------------------------------------------------------
// SEC-005 - anonymous rate limits must be per-caller. A literal "guest" subject
// collapsed every anonymous visitor into one bucket, so a single client could
// 429 the public pricing, waitlist and support endpoints for everyone.
// ---------------------------------------------------------------------------

test("no public route rate-limits anonymous callers with a shared literal subject", () => {
  for (const route of [
    "app/api/feedback/route.ts",
    "app/api/waitlist/route.ts",
    "app/api/billing/config/route.ts",
  ]) {
    const source = readRepoCode(route);
    // Look only at what is passed to the limiter, so unrelated `x || "guest"`
    // fallbacks elsewhere in the file cannot mask or trip this check.
    const subjectExpressions = [
      ...source.matchAll(/consumeApiRateLimit\(\s*req,\s*([^,]+),/g),
    ].map((match) => match[1].trim());
    const inlineSubjects = [
      ...source.matchAll(/const subject\s*=\s*([\s\S]*?);/g),
    ].map((match) => match[1].trim());
    const allSubjects = [...subjectExpressions, ...inlineSubjects];
    assert.ok(
      allSubjects.length > 0,
      `${route} should rate-limit its anonymous callers`
    );
    for (const subject of allSubjects) {
      assert.doesNotMatch(
        subject,
        /\|\|\s*"(guest|anonymous)"\s*$/,
        `${route} must key its anonymous rate limit per caller, got: ${subject}`
      );
    }
    assert.match(
      source,
      /getAnonymousClientKey\(req\)/,
      `${route} must derive an anonymous rate-limit key`
    );
  }
});

// ---------------------------------------------------------------------------
// SEC-006 - billing market must fail closed. Falling back to a client-supplied
// country let a caller pick a cheaper market, and the webhook amount check
// inherited the same forged value so it could not catch it.
// ---------------------------------------------------------------------------

test("billing market selection never trusts a client-declared country", () => {
  const source = readRepoCode("lib/billingCurrency.ts");
  const start = source.indexOf("export function validateBillingMarketRequest");
  assert.ok(start > 0, "validateBillingMarketRequest must exist");
  const body = source.slice(start, source.indexOf("\nexport", start + 1));
  assert.match(
    body,
    /const selectedCountry = trustedCountry \|\| DEFAULT_BILLING_COUNTRY;/,
    "an absent edge country must fall back to the default market, not to client input"
  );
  assert.doesNotMatch(
    body,
    /trustedCountry\s*\|\|\s*requestedCountry/,
    "requestedCountry must not be able to become the charged billing market"
  );
});

// ---------------------------------------------------------------------------
// SEC-007 - the Playwright short-circuits must be unreachable in production,
// not merely discouraged by an environment variable convention.
// ---------------------------------------------------------------------------

test("every E2E short-circuit is gated on a non-deployable origin, not the flag alone", () => {
  const source = readRepoCode("lib/e2eTestMode.ts");
  // NODE_ENV is unusable here: the Playwright server runs `next start`, which
  // sets NODE_ENV=production. The guard is that the app must be serving from a
  // loopback origin, which a real deployment never is.
  assert.match(source, /isLoopbackDeployment\(\)/);
  assert.match(source, /NEXTAUTH_URL/);
  assert.match(source, /127\.0\.0\.1/);

  const guardedFiles = [
    "app/(site)/(application)/layout.tsx",
    // The Playwright-only admin mount. It is the one *route* the flags gate,
    // so it must go through the same helper as every other short-circuit
    // rather than reading the environment variables itself.
    "app/(site)/(application)/e2e/admin-console-fixture/page.tsx",
    "app/api/billing/config/route.ts",
    "app/api/public/proof-metrics/route.ts",
    "app/api/models/status/route.ts",
    "lib/appSettings.ts",
    "lib/modelRegistry.ts",
    "lib/billingCurrency.ts",
  ];
  for (const file of guardedFiles) {
    const contents = readRepoCode(file);
    assert.doesNotMatch(
      contents,
      /process\.env\.E2E_(AUTH_BYPASS|DISABLE_DATABASE)\s*===/,
      `${file} must go through lib/e2eTestMode.ts so the NODE_ENV guard applies`
    );
    assert.match(
      contents,
      /from "@\/lib\/e2eTestMode"/,
      `${file} must import the guarded helper`
    );
  }
});

// ---------------------------------------------------------------------------
// UX-012 - deleting a guest conversation must actually delete its transcripts.
// The delete path used `guest_messages_<id>` while transcripts were stored under
// `guest_messages_<id>_<modelId>`, so nothing was removed and the "deleted"
// conversation reappeared on the next send.
// ---------------------------------------------------------------------------

test("guest transcript keys are built from one shared helper", () => {
  assert.equal(
    guestMessagesStorageKey("conv-1", "gpt-4o"),
    "guest_messages_conv-1_gpt-4o"
  );
  assert.equal(
    guestMessagesConversationPrefix("conv-1"),
    "guest_messages_conv-1_"
  );
  assert.ok(
    guestMessagesStorageKey("conv-1", "gpt-4o").startsWith(
      guestMessagesConversationPrefix("conv-1")
    ),
    "the write key must match the delete prefix"
  );
});

test("deleting a guest conversation selects every per-model transcript", () => {
  const keys = [
    "guest_messages_conv-1_gpt-4o",
    "guest_messages_conv-1_claude-sonnet",
    "guest_messages_conv-1",
    "guest_messages_conv-2_gpt-4o",
    "guest_conversations",
    "tomverse_theme_preference",
  ];
  assert.deepEqual(guestMessageKeysForConversation(keys, "conv-1").sort(), [
    "guest_messages_conv-1",
    "guest_messages_conv-1_claude-sonnet",
    "guest_messages_conv-1_gpt-4o",
  ]);
});

test("deleting one guest conversation leaves other conversations intact", () => {
  const keys = ["guest_messages_conv-1_gpt-4o", "guest_messages_conv-2_gpt-4o"];
  assert.deepEqual(guestMessageKeysForConversation(keys, "conv-2"), [
    "guest_messages_conv-2_gpt-4o",
  ]);
});

test("a conversation id that prefixes another is not over-matched", () => {
  const keys = ["guest_messages_conv-1_gpt-4o", "guest_messages_conv-10_gpt-4o"];
  assert.deepEqual(guestMessageKeysForConversation(keys, "conv-1"), [
    "guest_messages_conv-1_gpt-4o",
  ]);
});

// ---------------------------------------------------------------------------
// UX-001 - the composer must never submit mid-IME-composition. Korean is a
// primary launch locale, and Enter there commits a syllable rather than sending.
// ---------------------------------------------------------------------------

test("both chat composers guard Enter against IME composition", () => {
  for (const file of [
    "components/chat/ChatInput.tsx",
    "components/chat/ChatApp.tsx",
  ]) {
    const source = readRepoFile(file);
    assert.match(
      source,
      /isComposingKeydown\(/,
      `${file} must decide Enter through lib/chatKeyboardPolicy.ts`
    );
    assert.match(
      source,
      /getChatEnterKeyAction\(/,
      `${file} must not reimplement the Enter policy locally`
    );
  }

  // The rule itself lives in one place, so assert it there rather than once per
  // composer: a composition in progress never submits, including on the
  // browsers that fire the confirming keydown with isComposing already false.
  const policy = readRepoFile("lib/chatKeyboardPolicy.ts");
  assert.match(
    policy,
    /nativeEvent\?\.isComposing/,
    "the Enter policy must consult nativeEvent.isComposing"
  );
  assert.match(
    policy,
    /keyCode === 229/,
    "the Enter policy must handle browsers that omit isComposing"
  );
});

// ---------------------------------------------------------------------------
// UI-004 - env(safe-area-inset-*) resolves to 0px without viewport-fit=cover,
// which silently disabled every safe-area accommodation in the app.
// ---------------------------------------------------------------------------

test("the root layout opts into safe-area insets and a themed browser chrome", () => {
  // There is more than one root layout here (the localized marketing routes
  // need their own <html lang>), so the viewport is shared from lib rather than
  // declared per root -- the same reason rootMetadata lives there.
  const source = readRepoFile("lib/rootMetadata.ts");
  assert.match(source, /export const rootViewport: Viewport/);
  assert.match(source, /viewportFit: "cover"/);
  assert.match(source, /interactiveWidget: "resizes-content"/);
  assert.match(source, /themeColor:/);
  // A shared constant nothing exports is inert, so check every root uses it.
  for (const layout of ["app/(site)/layout.tsx", "app/[locale]/layout.tsx"]) {
    assert.match(
      readRepoFile(layout),
      /export const viewport = rootViewport;/,
      `${layout} must export the shared viewport`
    );
  }
});

// ---------------------------------------------------------------------------
// UI-005 - error and not-found boundaries existed only for /admin.
// ---------------------------------------------------------------------------

test("the app ships branded not-found and error boundaries", () => {
  for (const file of [
    "app/not-found.tsx",
    "app/global-error.tsx",
    "app/(site)/(application)/chat/error.tsx",
  ]) {
    assert.ok(readRepoFile(file).length > 0, `${file} must exist`);
  }
  assert.match(
    readRepoFile("app/global-error.tsx"),
    /<html/,
    "global-error replaces the root layout and must render its own document"
  );
});

// ---------------------------------------------------------------------------
// UI-002 - mobile confirmations rendered underneath the z-[80] drawer overlay.
// ---------------------------------------------------------------------------

test("mobile drawer actions that open a page-level dialog close the drawer first", () => {
  const source = readRepoFile("components/chat/MobileChatShell.tsx");
  for (const handler of ["onDelete", "onUnlock", "onRevokeShare"]) {
    const pattern = new RegExp(
      `${handler}=\\{\\(id\\) => \\{\\s*setIsDrawerOpen\\(false\\);`
    );
    assert.match(source, pattern, `${handler} must close the drawer before opening a dialog`);
  }
});

test("blocking dialogs stack above the mobile drawer and the context menu", () => {
  const source = readRepoCode("app/(site)/(application)/chat/ChatPageClient.tsx");
  assert.doesNotMatch(
    source,
    /fixed inset-0 z-50 flex items-center justify-center bg-black\/60/,
    "a z-50 dialog paints underneath the z-[80] mobile drawer overlay"
  );
  assert.ok(
    source.includes("z-[130]"),
    "dialogs must sit above the drawer (z-[80]) and context menu (z-[120])"
  );
});

// ---------------------------------------------------------------------------
// Accessibility fixes that are enforceable from source.
// ---------------------------------------------------------------------------

test("credit costs are exposed to assistive technology", () => {
  const source = readRepoFile("components/credits/CreditCostBadge.tsx");
  assert.match(
    source,
    /role="img"/,
    "aria-label is ignored on a roleless span, so the badge must declare a role"
  );
  assert.match(
    source,
    /aria-label=\{accessibleLabel\}/,
    "the cost must reach the accessibility tree as the badge's accessible name"
  );
});

test("the response lifecycle is announced without streaming into a live region", () => {
  const source = readRepoCode("components/chat/ChatMessageList.tsx");
  assert.match(source, /data-testid="chat-response-status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-atomic="true"/);
  // The typing indicator must still expose a text alternative.
  assert.match(source, /<span className="sr-only">\{label\}<\/span>/);
  assert.doesNotMatch(
    source,
    /data-testid="chat-message-list"[\s\S]{0,200}aria-live/,
    "the transcript itself must not be a live region - it would flood the reader"
  );
});

test("the conversation list is reachable and operable by keyboard", () => {
  const source = readRepoFile("components/chat/ChatSidebar.tsx");
  assert.match(source, /role="button"\s*\n\s*tabIndex=\{0\}/);
  assert.match(source, /event\.key === "Enter" \|\| event\.key === " "/);
});

test("a baseline focus indicator and reduced-motion policy exist globally", () => {
  const source = readRepoFile("app/globals.css");
  assert.match(source, /:focus-visible/, "outline-none controls need a fallback ring");
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /highlight\.js\/styles/, "rehype-highlight needs a theme to do anything");
  // The `:where(:lang(ko), :lang(zh)) { word-break: keep-all; overflow-wrap:
  // anywhere }` rule this test also asserted is deliberately not in this
  // release. `overflow-wrap: anywhere` licenses a break inside a Korean word
  // exactly when the line would overflow, which is the 200% zoom case
  // tests/e2e/korean-typography.spec.ts pins: the landing hero's 비교하세요 split
  // across lines on all three Chromium projects, and eight Korean chat goldens
  // moved with it. Removing the rule turns all 21 Korean typography specs green
  // again, so it is a real regression rather than a stale baseline -- and the
  // release checklist forbids re-recording goldens as part of a release.
  // Korean line-breaking wants its own change with its own reviewed re-record.
});

test("assistant markdown restores block-level typography reset by preflight", () => {
  const source = readRepoFile("components/chat/ChatMessageList.tsx");
  for (const tag of ["h1", "h2", "h3", "h4", "blockquote", "table", "th", "td"]) {
    assert.ok(
      new RegExp(`\\b${tag}: \\(`).test(source),
      `markdown ${tag} needs an explicit override under Tailwind preflight`
    );
  }
  assert.match(
    source,
    /overflow-x-auto[^"]*"[\s\S]{0,120}<table/,
    "a wide table must scroll inside its own container, not the message list"
  );
});

// ---------------------------------------------------------------------------
// STG-R002 - the administrator provider verification and recovery endpoints
// spend provider money and clear a provider's failure block. Both are ordinary
// mutations, so they must go through the same cross-origin rejection every
// other mutation does. A future exemption added to EXEMPT_MUTATION_PATHS would
// silently open them to cross-site submission, which is precisely the kind of
// change this suite exists to catch.
// ---------------------------------------------------------------------------

test("the admin verification and recovery mutations are CSRF-protected", () => {
  const paths = [
    "/api/admin/provider-health/verify",
    "/api/admin/provider-health/recover",
  ];
  for (const path of paths) {
    assert.equal(
      requiresMutationOriginCheck("POST", path),
      true,
      `${path} must require the mutation origin check`
    );
    assert.equal(
      requiresMutationOriginCheck("GET", path),
      false,
      `${path} reads are safe methods`
    );
    // The check itself must actually reject a cross-origin submission.
    assert.equal(
      hasValidMutationOrigin(
        new Request(`https://tomverse.app${path}`, {
          method: "POST",
          headers: { origin: "https://evil.example", host: "tomverse.app" },
        })
      ),
      false,
      `${path} must reject a foreign origin`
    );
    assert.equal(
      hasValidMutationOrigin(
        new Request(`https://tomverse.app${path}`, {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site", host: "tomverse.app" },
        })
      ),
      false,
      `${path} must reject a cross-site fetch with no origin header`
    );
  }
});

// ---------------------------------------------------------------------------
// SEC-010 - the session cookie's `Secure` attribute must not be inferred from
// an unvalidated string. next-auth v4 derives `useSecureCookies` from whether
// NEXTAUTH_URL starts with `https`, so a deployment served over http -- or one
// behind a proxy with NEXTAUTH_URL unset -- issued the session cookie without
// `Secure` and without the `__Secure-` prefix, and nothing reported it.
// `lib/auth.ts` now states the flag from the environment, and the readiness
// check fails closed on a production NEXTAUTH_URL that is not https.
// ---------------------------------------------------------------------------

test("the session cookie is marked Secure from the environment, not from a URL", () => {
  const source = readRepoCode("lib/auth.ts");
  assert.match(
    source,
    /useSecureCookies:\s*process\.env\.NODE_ENV\s*===\s*"production"/,
    "authOptions must state useSecureCookies rather than letting next-auth infer it"
  );
});

test("the readiness check rejects a production NEXTAUTH_URL that is not https", async () => {
  const { getSecurityEnvironmentStatus } = await import(
    "../lib/securityEnvironment.ts"
  );
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUrl = process.env.NEXTAUTH_URL;
  const nextAuthUrlCheck = (value: string | undefined) => {
    if (value === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = value;
    return getSecurityEnvironmentStatus().checks.nextAuthUrlIsHttps;
  };

  try {
    // @ts-expect-error NODE_ENV is typed as a literal union but is writable.
    process.env.NODE_ENV = "production";
    for (const rejected of [
      undefined,
      "",
      "   ",
      "http://tomverse.app",
      "http://localhost:3000",
      "tomverse.app",
      "//tomverse.app",
    ]) {
      assert.equal(
        nextAuthUrlCheck(rejected),
        false,
        `NEXTAUTH_URL=${JSON.stringify(rejected)} must fail readiness in production`
      );
    }
    assert.equal(nextAuthUrlCheck("https://tomverse.app"), true);
    assert.equal(nextAuthUrlCheck("  https://tomverse.app  "), true);

    // Outside production the check must not block local development, which has
    // no certificate.
    // @ts-expect-error see above.
    process.env.NODE_ENV = "development";
    assert.equal(nextAuthUrlCheck("http://localhost:3000"), true);
  } finally {
    // @ts-expect-error see above.
    process.env.NODE_ENV = originalNodeEnv;
    if (originalUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalUrl;
  }
});

test("an unready security environment keeps /api/ready from reporting ready", async () => {
  const { getSecurityEnvironmentStatus } = await import(
    "../lib/securityEnvironment.ts"
  );
  // `ready` is the conjunction of every check, so a single false must sink it.
  // Asserted here rather than trusted, because the route publishes this value
  // to the load balancer.
  const status = getSecurityEnvironmentStatus();
  assert.equal(
    status.ready,
    Object.values(status.checks).every(Boolean)
  );
  assert.ok(
    "nextAuthUrlIsHttps" in status.checks,
    "the readiness payload must expose the NEXTAUTH_URL check by name"
  );
});
