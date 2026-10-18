import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = path => pathToFileURL(resolve(root, path)).href;
let session = null;
let recent = false;
const redirected = href => { throw Object.assign(new Error("redirect"), { href }); };
const notFound = () => { throw new Error("not_found"); };
const panel = () => null;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module("next/navigation", { namedExports: { redirect: redirected, notFound } });
mock.module(mod("components/admin/AmuxIntakePanel.tsx"), {
  namedExports: { AmuxIntakePanel: panel },
});
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: current => current?.role ?? null,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  hasRecentAdminAuthentication: () => recent,
} });
mock.module(mod("lib/adminReauthenticationCore.ts"), { namedExports: {
  adminRecentAuthenticationHref: path => `reauth:${path}`,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });

const { default: page } = await import(mod(
  "app/(site)/(application)/admin/amux-u21-test-card/page.tsx"));
const previous = process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI;
const restore = () => {
  if (previous === undefined)
    delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI;
  else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI = previous;
  session = null;
  recent = false;
};

test("U21 intake UI is absent until its exact operator switch is enabled", async () => {
  try {
    delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI;
    await assert.rejects(page(), { message: "not_found" });
  } finally { restore(); }
});

test("U21 intake UI requires a recently authenticated owner", async () => {
  try {
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI = "enabled";
    await assert.rejects(page(),
      { message: "not_found" });
    session = { user: { id: "owner" }, role: "viewer" };
    await assert.rejects(page(),
      { message: "not_found" });
    session.role = "owner";
    await assert.rejects(page(),
      { href: "reauth:/admin/amux-u21-test-card" });
    recent = true;
    const rendered = await page();
    assert.equal(rendered.type, panel);
  } finally { restore(); }
});
