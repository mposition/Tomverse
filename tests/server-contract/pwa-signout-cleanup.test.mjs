import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { OFFLINE_DRAFT_KEY, OFFLINE_DRAFT_OWNER_KEY } from "../../lib/chatOfflineDraft.ts";

const values = new Map([[OFFLINE_DRAFT_KEY, "Private draft"], [OFFLINE_DRAFT_OWNER_KEY, "account:a"], ["tomverse-theme", "dark"]]);
const calls = [];
mock.module("next-auth/react", { namedExports: { signOut: async (options) => {
  assert.equal(values.has(OFFLINE_DRAFT_KEY), false); assert.equal(values.has(OFFLINE_DRAFT_OWNER_KEY), false); calls.push(options); return { url: "/chat" };
} } });
const { signOut } = await import("../../lib/signOutWithDraftCleanup.ts");
test("sign-out clears tab-private drafts before forwarding the unchanged NextAuth options", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { removeItem: (key) => values.delete(key) } });
  try {
    assert.deepEqual(await signOut({ redirect: false, callbackUrl: "/chat" }), { url: "/chat" });
    assert.deepEqual(calls, [{ redirect: false, callbackUrl: "/chat" }]); assert.equal(values.get("tomverse-theme"), "dark");
  } finally { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else delete globalThis.sessionStorage; }
});
