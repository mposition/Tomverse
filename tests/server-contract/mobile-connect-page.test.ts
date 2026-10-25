import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let signedIn = false;
let ready = true;
let reads = 0;
mock.module("next/navigation", { namedExports: {
  notFound: () => { throw new Error("not-found"); }, redirect: (url: string) => { throw new Error(url); },
} });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => { reads++; return signedIn ? { user: { id: "user" } } : null; } } });
mock.module(mod("lib/mobileAccessToken.ts"), { namedExports: { mobileAuthReady: () => ready } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("components/auth/MobileConnectGrant.tsx"), { namedExports: { MobileConnectGrant: () => null } });
const require = createRequire(import.meta.url);
const Page = require(resolve(root, "app/(site)/(application)/mobile/connect/page.tsx")).default;
const challenge = "a".repeat(43);

test("browser pairing stays disabled by default and validates its public challenge before reading a session", async () => {
  const previous = process.env.MOBILE_CHAT_ENABLED;
  try {
    delete process.env.MOBILE_CHAT_ENABLED;
    await assert.rejects(Page({ searchParams: Promise.resolve({ codeChallenge: challenge }) }), /not-found/);
    process.env.MOBILE_CHAT_ENABLED = "true";
    ready = false;
    await assert.rejects(Page({ searchParams: Promise.resolve({ codeChallenge: challenge }) }), /not-found/);
    assert.equal(reads, 0);
    ready = true;
    await assert.rejects(Page({ searchParams: Promise.resolve({ codeChallenge: "invalid" }) }), /not-found/);
    assert.equal(reads, 0);
    await assert.rejects(Page({ searchParams: Promise.resolve({ codeChallenge: challenge }) }), (error: Error) =>
      error.message === `/auth/signin?callbackUrl=${encodeURIComponent(`/mobile/connect?codeChallenge=${challenge}`)}`);
    signedIn = true;
    const element = await Page({ searchParams: Promise.resolve({ codeChallenge: challenge }) });
    assert.equal(element.props.challenge, challenge);
  } finally { if (previous === undefined) delete process.env.MOBILE_CHAT_ENABLED; else process.env.MOBILE_CHAT_ENABLED = previous; }
});

test("system-browser login keeps its app return destination through the ordinary web sign-in page", async () => {
  const keys = ["MOBILE_CHAT_ENABLED", "MOBILE_AUTH_APP_LINKS_ENABLED", "MOBILE_AUTH_ANDROID_SHA256_CERT_FINGERPRINTS"] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.MOBILE_CHAT_ENABLED = "true";
    process.env.MOBILE_AUTH_APP_LINKS_ENABLED = "true";
    process.env.MOBILE_AUTH_ANDROID_SHA256_CERT_FINGERPRINTS = Array(32).fill("AB").join(":");
    ready = true; signedIn = false;
    const query = { codeChallenge: challenge, returnTo: "app" };
    await assert.rejects(Page({ searchParams: Promise.resolve(query) }), (error: Error) =>
      error.message === `/auth/signin?callbackUrl=${encodeURIComponent(`/mobile/connect?codeChallenge=${challenge}&returnTo=app`)}`);
    signedIn = true;
    const element = await Page({ searchParams: Promise.resolve(query) });
    assert.equal(element.props.returnToApp, true);
    delete process.env.MOBILE_AUTH_APP_LINKS_ENABLED;
    assert.equal((await Page({ searchParams: Promise.resolve(query) })).props.returnToApp, false);
    process.env.MOBILE_AUTH_APP_LINKS_ENABLED = "true";
    assert.equal((await Page({ searchParams: Promise.resolve({ ...query, returnTo: "https://evil.test" }) })).props.returnToApp, false);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
