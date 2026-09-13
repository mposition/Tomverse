import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import React from "react";

// Exercise the actual Server Component. The fixture-mode helper is real:
// forged cookies and copied E2E flags on a public origin must not bypass it.
const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
globalThis.React = React;
let session, owned, offered, cookieReads, ownershipReads, availabilityReads;
const originalEnv = { ...process.env };
mock.module("next/headers", { namedExports: { cookies: async () => {
  cookieReads++;
  return { get: () => ({ value: "1" }) };
} } });
mock.module("next/navigation", { namedExports: {
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url) => { throw new Error(`REDIRECT:${url}`); },
} });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => session } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoAvailability.ts"), { namedExports: { autoAvailabilityFor: async (userId) => {
  availabilityReads.push(userId);
  return { offered };
} } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { conversation: { findFirst: async (query) => {
  ownershipReads.push(query);
  return owned;
} } } } });
mock.module(mod("components/chat/ReviewWorkspaceShell.tsx"), { namedExports: { ReviewWorkspaceShell: () => null } });
const { ChatWorkspaceShell } = await import(mod("components/chat/ChatWorkspaceShell.tsx"));

test.beforeEach(() => {
  process.env.NEXTAUTH_URL = "https://chat.tomverse.example";
  process.env.E2E_AUTH_BYPASS = "true";
  process.env.E2E_DISABLE_DATABASE = "true";
  session = { user: { id: "owner-a" } };
  owned = null;
  offered = false;
  cookieReads = 0;
  ownershipReads = [];
  availabilityReads = [];
});
test.after(() => {
  for (const key of ["NEXTAUTH_URL", "E2E_AUTH_BYPASS", "E2E_DISABLE_DATABASE"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  delete globalThis.React;
});
const open = (searchParams = {}) => ChatWorkspaceShell({ searchParams });

test("public deployment ignores forged fixture cookies and refuses unoffered new Chat", async () => {
  await assert.rejects(open({ offered: "true", productKey: "chat" }), /NOT_FOUND/);
  assert.equal(cookieReads, 0);
  assert.deepEqual(availabilityReads, ["owner-a"]);
});
test("public deployment ignores forged cookies without an authenticated owner", async () => {
  session = null;
  await assert.rejects(open({ conversation: "another-owner-chat" }), /NOT_FOUND/);
  assert.equal(cookieReads, 0);
  assert.equal(ownershipReads.length, 0);
});
test("owned read binds both user and conversation; a missing/wrong-owner row never opens", async () => {
  offered = true;
  await assert.rejects(open({ conversation: "another-owner-chat" }), /NOT_FOUND/);
  assert.deepEqual(ownershipReads[0].where, { id: "another-owner-chat", userId: "owner-a" });
  assert.equal(availabilityReads.length, 0);
});
test("owned Chat stays readable after cohort loss, without asking availability", async () => {
  owned = { productKey: "chat", continuationBridge: null };
  const element = await open({ conversation: "owned-chat" });
  assert.equal(element.props.mountedSurface, "chat");
  assert.equal(element.props.initialConversationId, "owned-chat");
  assert.equal(availabilityReads.length, 0);
});
test("offered new entry opens the Chat shell", async () => {
  offered = true;
  const element = await open();
  assert.equal(element.props.mountedSurface, "chat");
  assert.equal(element.props.initialConversationId, null);
});
test("owned legacy Review and continuation hand off without cutover or query loss", async () => {
  owned = { productKey: null, continuationBridge: null };
  await assert.rejects(open({ conversation: "owned-review", lang: "ko" }), /REDIRECT:\/chat\?conversation=owned-review&lang=ko/);
  owned = { productKey: "review", continuationBridge: { id: "bridge" } };
  await assert.rejects(open({ conversation: "continued", lang: "ko" }), /REDIRECT:\/continuations\/continued\?lang=ko/);
});
test("only full loopback fixture mode can use the opted-in cookies", async () => {
  process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
  session = null;
  const element = await open({ conversation: "mock-chat" });
  assert.equal(element.props.mountedSurface, "chat");
  assert.equal(cookieReads, 1);
  assert.equal(ownershipReads.length, 0);
  process.env.E2E_DISABLE_DATABASE = "false";
  await assert.rejects(open(), /NOT_FOUND/);
});
