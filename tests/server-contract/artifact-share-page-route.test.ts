// Contract: the public page a share link opens (docs/policy/generated-artifacts.md section 19).
//
//   * It reads no session and no cookie: the session resolvers, next-auth and
//     next/headers are all replaced with functions that fail the test if
//     called, and a request carrying a session cookie gets the same page as
//     one without.
//   * Its headers are the conversation share's cache and robots policy, no
//     referrer, no framing, and its own enforced CSP -- the preview frame's
//     policy with `sandbox allow-scripts` and `frame-ancestors 'none'`.
//   * Every refusal (bad token, switch off, no live share) is the same 404.
//   * The proxy leaves this path's CSP to the route and still sets the strict
//     policy on the conversation share page.
//
// Only the route's collaborators are replaced. The route and the proxy are real.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "artifact-share-page-contract-2026";
process.env.PUBLIC_APP_URL = "http://127.0.0.1:3100";

const ORIGIN = "http://127.0.0.1:3100";
const PAGE = "<h1>Quarterly chart</h1><script>document.body.dataset.ran = '1'</script>";

const world = {
  enabled: true,
  share: null as null | { previewKind: "html" | "svg" | "react"; language: string; title: string | null; content: string; expiresAt: Date },
  rateLimitKeys: [] as string[],
  sessionReads: [] as string[],
};

const reset = () => {
  world.enabled = true;
  world.share = { previewKind: "html", language: "html", title: "chart.html", content: PAGE, expiresAt: new Date("2026-12-28T00:00:00.000Z") };
  world.rateLimitKeys = [];
  world.sessionReads = [];
};

const forbidden = (name: string) => () => {
  world.sessionReads.push(name);
  throw new Error(`the public share page must not read ${name}`);
};

let installed = false;
const load = async () => {
  if (!installed) {
    installed = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async (_req: Request, key: string) => {
          world.rateLimitKeys.push(key);
        },
      },
    });
    mock.module(mod("lib/artifactShareSettings.ts"), {
      namedExports: { isArtifactSharingEnabled: async () => world.enabled, isArtifactSharingSwitchOn: async () => world.enabled, setArtifactSharingEnabled: async () => {} },
    });
    mock.module(mod("lib/artifactShareService.ts"), {
      namedExports: { readPublicArtifactShare: async () => world.share },
    });
    mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: forbidden("resolveChatRouteSession") } });
    mock.module("next-auth/next", { namedExports: { getServerSession: forbidden("getServerSession") } });
    mock.module("next-auth", { namedExports: { getServerSession: forbidden("getServerSession") }, defaultExport: forbidden("NextAuth") });
    mock.module("next/headers", { namedExports: { cookies: forbidden("cookies()"), headers: forbidden("headers()"), draftMode: forbidden("draftMode()") } });
  }
  return import(mod("app/(site)/(application)/share/a/[shareToken]/route.ts"));
};

const TOKEN = randomBytes(24).toString("base64url");
const request = (headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/share/a/${TOKEN}`, { headers: { "accept-language": "ko-KR,ko;q=0.9", ...headers } });
const context = (shareToken = TOKEN) => ({ params: Promise.resolve({ shareToken }) });

test("the page is built from the token alone: a signed-in visitor's cookie changes nothing and no session is read", async () => {
  reset();
  const { GET } = await load();
  const signedOut = await GET(request(), context());
  const signedIn = await GET(
    request({ cookie: "__Secure-next-auth.session-token=SESSION-SECRET-123; tomverse_lang=en", authorization: "Bearer TOKEN-SECRET-456" }),
    context()
  );
  assert.equal(signedOut.status, 200);
  assert.equal(signedIn.status, 200);
  const [outBody, inBody] = [await signedOut.text(), await signedIn.text()];
  assert.equal(inBody, outBody);
  assert.doesNotMatch(inBody, /SESSION-SECRET-123|TOKEN-SECRET-456/);
  assert.deepEqual(world.sessionReads, []);
  // Keyed on the link, as the conversation share's public read is.
  assert.deepEqual(world.rateLimitKeys, [`artifact-share:${TOKEN}`, `artifact-share:${TOKEN}`]);
  // The visitor's own language, from Accept-Language and not from the language cookie.
  assert.match(outBody, /<html lang="ko">/);
  assert.ok(outBody.includes("사용자가 만든 콘텐츠이며 Tomverse가 만든 것이 아닙니다. 비밀번호나 결제 정보를 입력하지 마세요."));
});

test("the page carries its own enforced policy and the conversation share's cache and robots headers", async () => {
  reset();
  const { GET } = await load();
  const response = await GET(request(), context());
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.ok(csp.startsWith("sandbox allow-scripts; default-src 'none'; "), csp);
  assert.ok(csp.endsWith("; frame-ancestors 'none'"), csp);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.ok(csp.includes(`script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com ${ORIGIN}/vendor/artifact-preview/;`));
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "unsafe-none");
  assert.equal(response.headers.get("set-cookie"), null);

  const body = await response.text();
  assert.match(body, /<iframe data-testid="artifact-share-frame"[^>]* sandbox="allow-scripts"/);
  assert.doesNotMatch(body, /<script/);
  assert.ok(body.includes(`href="${ORIGIN}/support"`));
});

test("a wrong token, the switch off and a link that is not live are the same 404", async () => {
  reset();
  const { GET } = await load();
  const bodies: string[] = [];
  for (const [label, setup, token] of [
    ["weak token", () => {}, "short"],
    ["switch off", () => { world.enabled = false; }, TOKEN],
    ["no live share", () => { world.share = null; }, TOKEN],
  ] as const) {
    reset();
    setup();
    const response = await GET(request(), context(token));
    assert.equal(response.status, 404, label);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0", label);
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox; default-src 'none';/, label);
    const body = await response.text();
    assert.doesNotMatch(body, /<iframe|<script/, label);
    bodies.push(body);
  }
  assert.equal(new Set(bodies).size, 1);
});

test("the proxy leaves the share page's policy to the route and still sets the strict one elsewhere", async () => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import(mod("proxy.ts"));
  const sharePage = proxy(new NextRequest(`${ORIGIN}/share/a/${TOKEN}`, { headers: { host: "127.0.0.1:3100" } }));
  assert.equal(sharePage.status, 200);
  assert.equal(sharePage.headers.get("content-security-policy"), null);
  assert.equal(sharePage.headers.get("content-security-policy-report-only"), null);

  const conversationShare = proxy(new NextRequest(`${ORIGIN}/share/${TOKEN}`, { headers: { host: "127.0.0.1:3100" } }));
  const strict =
    conversationShare.headers.get("content-security-policy") ?? conversationShare.headers.get("content-security-policy-report-only");
  assert.match(strict ?? "", /'nonce-/);
});
