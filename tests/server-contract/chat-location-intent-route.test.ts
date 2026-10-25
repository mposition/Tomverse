import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e";
process.env.NEXTAUTH_SECRET ||= "test-location-intent-secret";
const security = require(resolve(root, "lib/chatSecurity.ts")) as typeof import("../../lib/chatSecurity");
const apiSecurity = require(resolve(root, "lib/apiSecurity.ts")) as Record<string, unknown>;
let user: string | null = "owner"; let refused = false; let verified = false; let limited = false; let analysed = 0;
const subjects: string[] = [];
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => refused
  ? { response: Response.json({ code: "TOKEN_INVALID" }, { status: 401 }) } : { session: user ? { user: { id: user } } : null } } });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: { ...security,
  assertUserOperationalAccess: async () => { if (refused) throw new security.ChatAccessError(403, "ACCOUNT_RESTRICTED", "Restricted"); },
  identifyChatCaller: security.identifyChatCaller,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...apiSecurity, consumeApiRateLimit: async (_request: Request, subject: string) => { subjects.push(subject); if (limited) throw Error("rate limited"); } } });
mock.module(mod("lib/chatLocationIntent.ts"), { namedExports: { detectChatLocationIntent: async () => { analysed++; return true; } } });
mock.module(mod("lib/turnstile.ts"), { namedExports: { ensureGuestVerified: async (_request: Request, token: string | undefined, action: string) => {
  assert.equal(action, "guest_chat"); if (!verified && token !== "valid-challenge") throw new security.ChatAccessError(403, "TURNSTILE_REQUIRED", "Verify");
  verified = true; return "synthetic-grant=1; HttpOnly; Secure";
} } });
const load = () => import(mod("app/api/chat/location-intent/route.ts"));
const ask = async (body: unknown = { text: "Where am I?" }, cookie?: string): Promise<Response> => (await load()).POST(new Request("https://tomverse.app/api/chat/location-intent", {
  method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
}));
const reset = () => { user = "owner"; refused = false; verified = false; limited = false; analysed = 0; subjects.length = 0; };
test("invalid bearer, rate refusal and malformed payload reach no model", async () => {
  reset(); refused = true; assert.equal((await ask()).status, 401); assert.equal(analysed, 0);
  reset(); limited = true; await ask(); assert.equal(analysed, 0);
  reset(); assert.equal((await ask({ text: "Where am I?", latitude: 1 })).status, 400); assert.equal(analysed, 0);
});
test("authenticated intent replies are private and contain no coordinates", async () => {
  reset(); const response = await ask(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { requiresLocation: true }); assert.equal(analysed, 1);
});
test("guests use the existing challenge before analysis, then reuse its grant", async () => {
  reset(); user = null;
  assert.equal((await ask()).status, 403); assert.equal(analysed, 0);
  const response = await ask({ text: "Where am I?", turnstileToken: "valid-challenge" });
  assert.equal(response.status, 200); assert.ok(response.headers.get("set-cookie")?.includes("synthetic-grant"));
  assert.deepEqual(await response.json(), { requiresLocation: false }); assert.equal(analysed, 0);
  assert.equal((await ask()).status, 200); assert.equal(analysed, 1);
});

test("guest identity cookies survive challenge errors and successful analysis so rate subjects remain stable", async () => {
  reset(); user = null;
  const challenge = await ask(); assert.equal(challenge.status, 403);
  const identity = challenge.headers.getSetCookie().find(cookie => cookie.startsWith("tomverse_guest="));
  assert.ok(identity);
  const cookie = identity.split(";")[0];
  const response = await ask({ text: "Where am I?", turnstileToken: "valid-challenge" }, cookie);
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith("synthetic-grant=")));
  assert.equal((await ask(undefined, cookie)).status, 200);
  assert.equal(new Set(subjects).size, 1);
  reset(); user = null; limited = true;
  assert.ok((await ask()).headers.getSetCookie().some(value => value.startsWith("tomverse_guest=")));
  reset(); user = null; verified = true;
  assert.ok((await ask()).headers.getSetCookie().some(value => value.startsWith("tomverse_guest=")));
});
