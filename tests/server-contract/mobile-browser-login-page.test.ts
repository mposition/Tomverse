import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let signedIn = false;
let reads = 0;
mock.module("next/navigation", { namedExports: {
  notFound: () => { throw Error("not-found"); }, redirect: (url: string) => { throw Error(url); },
} });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => { reads++; return signedIn ? { user: { id: "existing-user" } } : null; } } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("app/(site)/(application)/auth/mobile/MobileLoginContent.tsx"), { namedExports: { MobileLoginContent: () => null } });
const require = createRequire(import.meta.url);
const Page = require(resolve(root, "app/(site)/(application)/auth/mobile/page.tsx")).default;
const challenge = "c".repeat(43); const state = "s".repeat(43);

test("native browser entry uses the unchanged web sign-in page and preserves its PKCE return request", async () => {
  const previous = process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
  try {
    delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
    await assert.rejects(Page({ searchParams: Promise.resolve({ code_challenge: challenge, state }) }), /not-found/);
    assert.equal(reads, 0);
    process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
    await assert.rejects(Page({ searchParams: Promise.resolve({ code_challenge: "invalid", state }) }), /not-found/);
    assert.equal(reads, 0);
    const callback = `/auth/mobile?${new URLSearchParams({ code_challenge: challenge, state })}`;
    await assert.rejects(Page({ searchParams: Promise.resolve({ code_challenge: challenge, state }) }), (error: Error) =>
      error.message === `/auth/signin?${new URLSearchParams({ callbackUrl: callback })}`);
    signedIn = true;
    const element = await Page({ searchParams: Promise.resolve({ code_challenge: challenge, state }) });
    assert.equal(element.props.challenge, challenge); assert.equal(element.props.state, state);
  } finally { if (previous === undefined) delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED; else process.env.TOMVERSE_NATIVE_CHAT_ENABLED = previous; }
});
