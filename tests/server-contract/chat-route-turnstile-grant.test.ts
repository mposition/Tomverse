import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Trace e81bb83c-… -- the "repeated TURNSTILE_REQUIRED" incident. A guest's
// token was verified successfully, the request then failed a LATER gate
// (CHAT_RATE_LIMITED, trace c7216139-…), and the grant cookie -- which the
// route only attached to the streaming success response -- was dropped with
// the error. The guest's next attempt therefore failed verification again,
// even though they had just solved a challenge.
//
// The contract pinned here: once ensureGuestVerified() has accepted a fresh
// token, EVERY response leaving POST /api/chat carries the grant cookie --
// downstream 4xx/5xx included -- while a request whose verification itself
// failed (missing token, rejected token) earns no grant at all.
//
// Runs under the server-contract runner: module mocks are process-global.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const original = (path: string) =>
  require(resolve(ROOT, path)) as Record<string, unknown>;

const realChatSecurity = original("lib/chatSecurity.ts");
const realTurnstile = original("lib/turnstile.ts") as unknown as {
  buildGuestTurnstileGrantCookie: (request: Request, action: string) => string;
};
const ChatAccessError = realChatSecurity.ChatAccessError as new (
  status: number,
  code: string,
  message: string
) => Error;

// Mutable per-test behaviour for the two mocked seams. The mocks are
// installed once (re-registering does not rebind an already-imported module),
// so they read these at call time.
const behaviour: {
  /** null = accept the token and mint a real grant cookie. */
  verificationError: Error | null;
  /** null = let acquireChatAccess succeed (not used by these tests). */
  admissionError: Error | null;
} = { verificationError: null, admissionError: null };

mock.module(mod("lib/turnstile.ts"), {
  namedExports: {
    ...original("lib/turnstile.ts"),
    ensureGuestVerified: async (
      request: Request,
      token: string | undefined
    ) => {
      if (!token) {
        throw new ChatAccessError(
          403,
          "TURNSTILE_REQUIRED",
          "Guest verification is required."
        );
      }
      if (behaviour.verificationError) throw behaviour.verificationError;
      // The real cookie builder, so the assertion below covers the attributes
      // (HttpOnly, SameSite, Path, Max-Age) the client actually receives.
      return realTurnstile.buildGuestTurnstileGrantCookie(request, "guest_chat");
    },
  },
});

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => {
      if (behaviour.admissionError) throw behaviour.admissionError;
      throw new Error("these tests always configure a downstream failure");
    },
  },
});

mock.module("ai", {
  namedExports: {
    streamText: () => {
      throw new Error("streamText must not be reached in these tests");
    },
  },
});

mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => null,
  },
});

const loadRoute = async () =>
  (await import(`${mod("app/api/chat/route.ts")}?grant=cached`)) as {
    POST: (req: Request) => Promise<Response>;
  };

const guestChatRequest = (turnstileToken?: string) =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      modelId: "claude-haiku-4-5",
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });

const grantCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith("tomverse_guest_verified_guest_chat="));

for (const downstream of [
  { status: 429, code: "CHAT_RATE_LIMITED" },
  { status: 429, code: "CHAT_CONCURRENCY_EXCEEDED" },
  { status: 402, code: "CREDIT_BALANCE_INSUFFICIENT" },
  { status: 503, code: "OPERATIONAL_COST_GUARDRAIL_TRIGGERED" },
] as const) {
  test(`a verified token keeps its grant cookie through a downstream ${downstream.status} ${downstream.code}`, async () => {
    behaviour.verificationError = null;
    behaviour.admissionError = new ChatAccessError(
      downstream.status,
      downstream.code,
      "Downstream gate refused the request."
    );

    const { POST } = await loadRoute();
    const response = await POST(guestChatRequest("a-freshly-solved-token"));

    assert.equal(response.status, downstream.status);
    const payload = (await response.json()) as { code?: string };
    assert.equal(payload.code, downstream.code);

    const grants = grantCookies(response);
    assert.equal(
      grants.length,
      1,
      `the grant cookie must survive a ${downstream.code} response -- without it the next attempt repeats TURNSTILE_REQUIRED`
    );
    // Same shape and protections as the success-path cookie.
    assert.match(grants[0]!, /HttpOnly/);
    assert.match(grants[0]!, /SameSite=Lax/);
    assert.match(grants[0]!, /Path=\//);
    assert.match(grants[0]!, /Max-Age=\d+/);
    // Trace id still travels with the error for support.
    assert.ok(response.headers.get("X-Request-ID"));
  });
}

test("a tokenless request is refused with TURNSTILE_REQUIRED and earns no grant", async () => {
  behaviour.verificationError = null;
  behaviour.admissionError = null;

  const { POST } = await loadRoute();
  const response = await POST(guestChatRequest());

  assert.equal(response.status, 403);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "TURNSTILE_REQUIRED");
  assert.deepEqual(
    grantCookies(response),
    [],
    "an unverified request must never receive a grant cookie"
  );
});

test("a rejected token earns no grant either", async () => {
  behaviour.verificationError = new ChatAccessError(
    403,
    "TURNSTILE_FAILED",
    "Guest verification failed."
  );
  behaviour.admissionError = null;

  const { POST } = await loadRoute();
  const response = await POST(guestChatRequest("a-replayed-or-bad-token"));

  assert.equal(response.status, 403);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "TURNSTILE_FAILED");
  assert.deepEqual(
    grantCookies(response),
    [],
    "a failed verification must never mint a grant"
  );
});

test("a verification outage (503 TURNSTILE_UNAVAILABLE) earns no grant", async () => {
  behaviour.verificationError = new ChatAccessError(
    503,
    "TURNSTILE_UNAVAILABLE",
    "Guest verification is temporarily unavailable."
  );
  behaviour.admissionError = null;

  const { POST } = await loadRoute();
  const response = await POST(guestChatRequest("a-token-nobody-could-check"));

  assert.equal(response.status, 503);
  assert.deepEqual(grantCookies(response), []);
});
