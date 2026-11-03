import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NextAuthOptions } from "next-auth";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const handlers: NextAuthOptions[] = [];
const original = { providers: [], cookies: { sessionToken: { name: "existing-session", options: { httpOnly: true, sameSite: "lax", secure: true } } } } satisfies NextAuthOptions;
mock.module("next-auth", { defaultExport: (options: NextAuthOptions) => async () => { handlers.push(options); return new Response("ok"); } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: original } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
  readLimitedJson: async (request: Request, _size: number, schema: { parse(value: unknown): unknown }) => schema.parse(await request.json()),
} });
mock.module(mod("lib/clientIp.ts"), { namedExports: { getAnonymousClientKey: () => "synthetic-client" } });
let auth: typeof import("../../app/api/auth/[...nextauth]/route");
let intent: typeof import("../../app/api/auth/signup-intent/route");
before(async () => { auth = await import("../../app/api/auth/[...nextauth]/route"); intent = await import("../../app/api/auth/signup-intent/route"); });

test("only Apple sign-in and callback routes use cross-site proof cookies", async () => {
  const request = new Request("https://tomverse.app/api/auth/signin/apple");
  for (const action of ["signin", "callback"]) {
    await auth.POST(request, { params: Promise.resolve({ nextauth: [action, "apple"] }) });
    const options = handlers.at(-1)!;
    assert.equal(options.cookies?.state?.options.sameSite, "none");
    assert.equal(options.cookies?.sessionToken, original.cookies.sessionToken);
  }
  for (const nextauth of [["signin", "google"], ["callback", "azure-ad"], ["csrf"], ["session"], ["providers"]]) {
    await auth.GET(request, { params: Promise.resolve({ nextauth }) });
    assert.equal(handlers.at(-1), original);
  }
});

test("signup intent survives Apple form_post while other provider cookies stay Lax and withdrawal expires it", async () => {
  for (const provider of ["apple", "google", "azure-ad"]) {
    const response = await intent.POST(new Request("https://tomverse.app/api/auth/signup-intent", { method: "POST", body: JSON.stringify({ provider }) }));
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/api\/auth/i);
    assert.match(cookie, provider === "apple" ? /SameSite=none/i : /SameSite=lax/i);
    if (provider === "apple") assert.match(cookie, /Secure/i);
  }
  const withdrawn = await intent.DELETE(new Request("https://tomverse.app/api/auth/signup-intent", { method: "DELETE" }));
  assert.match(withdrawn.headers.get("set-cookie")!, /Max-Age=0/);
});
