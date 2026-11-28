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
// A pure module the route uses unreplaced; only its fixed script text is compared here.
const { ARTIFACT_SHARE_GATE_SCRIPT } = require(resolve(ROOT, "lib/artifactSharePage.ts")) as { ARTIFACT_SHARE_GATE_SCRIPT: string };

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
  readGates: [] as Array<{ sharingAvailable: boolean }>,
  rateLimited: false,
};

const reset = () => {
  world.enabled = true;
  world.share = { previewKind: "html", language: "html", title: "chart.html", content: PAGE, expiresAt: new Date("2026-12-28T00:00:00.000Z") };
  world.rateLimitKeys = [];
  world.sessionReads = [];
  world.readGates = [];
  world.rateLimited = false;
};

const forbidden = (name: string) => () => {
  world.sessionReads.push(name);
  throw new Error(`the public share page must not read ${name}`);
};

let installed = false;
const load = async () => {
  if (!installed) {
    installed = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown> & {
      ApiSecurityError: new (status: number, code: string, message: string) => Error;
    };
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async (_req: Request, key: string) => {
          world.rateLimitKeys.push(key);
          if (world.rateLimited) throw new realApiSecurity.ApiSecurityError(429, "RATE_LIMITED", "Too many requests");
        },
      },
    });
    mock.module(mod("lib/artifactShareSettings.ts"), {
      namedExports: { isArtifactSharingEnabled: async () => world.enabled, isArtifactSharingSwitchOn: async () => world.enabled, setArtifactSharingEnabled: async () => {} },
    });
    mock.module(mod("lib/artifactShareService.ts"), {
      // The real read refuses a closed switch first (tests/integration/artifact-share.db.test.ts); this records what the route passed.
      namedExports: {
        readPublicArtifactShare: async (_token: string, gates: { sharingAvailable: boolean }) => {
          world.readGates.push(gates);
          return gates.sharingAvailable ? world.share : null;
        },
      },
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
  assert.match(csp, /; webrtc 'block'; /);
  // This origin's three vendored preview files by exact URL (lib/htmlArtifactPreview.ts HTML_PREVIEW_VENDOR_FILES), not the directory.
  const vendor = ["react-18.3.1.production.min.js", "react-dom-18.3.1.production.min.js", "babel-standalone-7.26.2.min.js"]
    .map((file) => ` ${ORIGIN}/vendor/artifact-preview/${file}`)
    .join("");
  assert.ok(csp.includes(`script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com${vendor};`), csp);
  assert.ok(!csp.includes(`${ORIGIN}/vendor/artifact-preview/ `) && !csp.includes(`${ORIGIN}/vendor/artifact-preview/;`), csp);
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
  assert.ok(body.includes(`href="${ORIGIN}/support"`));
});

test("the response asks first: the confirmation is drawn and the frame waits, inert, until the visitor opens it", async () => {
  reset();
  const { GET } = await load();
  const body = await (await GET(request({ cookie: "__Secure-next-auth.session-token=SESSION-SECRET-123" }), context())).text();
  assert.deepEqual(world.sessionReads, []);
  // The visitor's language: the confirmation sentence and its button.
  assert.ok(body.includes("다른 사람이 만든 화면입니다. Tomverse가 만들거나 확인한 것이 아닙니다. 비밀번호·결제 정보·인증 코드를 입력하지 마세요."));
  assert.match(body, /<button type="button" id="artifact-share-open" data-testid="artifact-share-open">화면 보기<\/button>/);
  // The only frame is inside a template, after the confirmation; the top notice stays above both.
  const gate = body.indexOf('data-testid="artifact-share-gate"');
  const template = body.indexOf('<template id="artifact-share-frame-template"><iframe ');
  assert.ok(body.indexOf('data-testid="artifact-share-notice"') < gate && gate < template, "notice, then confirmation, then the inert frame");
  assert.equal(body.split("<iframe ").length, 2);
  assert.ok(body.indexOf("</template>") > body.indexOf("</iframe>"));
  // The one script is the fixed gate script: it moves the frame, and carries nothing of the shared page.
  assert.deepEqual(body.match(/<script[^>]*>[\s\S]*?<\/script>/g), [`<script>${ARTIFACT_SHARE_GATE_SCRIPT}</script>`]);
  assert.ok(!body.includes("SESSION-SECRET-123"));
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
    // The switch reaches the read's own decision; a weak token never gets that far.
    if (label === "switch off") assert.deepEqual(world.readGates, [{ sharingAvailable: false }], label);
    if (label === "weak token") assert.deepEqual(world.readGates, [], label);
  }
  assert.equal(new Set(bodies).size, 1);
});

test("the public read is rate limited before anything about the link is read", async () => {
  reset();
  world.rateLimited = true;
  const { GET } = await load();
  const response = await GET(request(), context());
  assert.equal(response.status, 429);
  assert.deepEqual(world.rateLimitKeys, [`artifact-share:${TOKEN}`]);
  assert.deepEqual(world.readGates, [], "the link is never read past a refused rate limit");
  assert.doesNotMatch(await response.text(), /<iframe|<script/);
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
