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
const security = require(resolve(root, "lib/chatSecurity.ts")) as typeof import("../../lib/chatSecurity");
const apiSecurity = require(resolve(root, "lib/apiSecurity.ts")) as Record<string, unknown>;
let user: string | null = "owner"; let refused = false; let verified = false; let limited = false; let analysed = 0;
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => refused
  ? { response: Response.json({ code: "TOKEN_INVALID" }, { status: 401 }) } : { session: user ? { user: { id: user } } : null } } });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: { ...security,
  assertUserOperationalAccess: async () => { if (refused) throw new security.ChatAccessError(403, "ACCOUNT_RESTRICTED", "Restricted"); },
  identifyChatCaller: () => ({ subjectKey: user ?? "guest" }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...apiSecurity, consumeApiRateLimit: async () => { if (limited) throw Error("rate limited"); } } });
mock.module(mod("lib/chatLocationIntent.ts"), { namedExports: { detectChatLocationIntent: async () => { analysed++; return true; } } });
mock.module(mod("lib/turnstile.ts"), { namedExports: { ensureGuestVerified: async (_request: Request, token: string | undefined, action: string) => {
  assert.equal(action, "guest_chat"); if (!verified && token !== "valid-challenge") throw new security.ChatAccessError(403, "TURNSTILE_REQUIRED", "Verify");
  verified = true; return "synthetic-grant=1; HttpOnly; Secure";
} } });
const load = () => import(mod("app/api/chat/location-intent/route.ts"));
const ask = async (body: unknown = { text: "Where am I?" }) => (await load()).POST(new Request("https://tomverse.app/api/chat/location-intent", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const reset = () => { user = "owner"; refused = false; verified = false; limited = false; analysed = 0; };
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
  assert.equal(analysed, 1); assert.equal((await ask()).status, 200); assert.equal(analysed, 2);
});
