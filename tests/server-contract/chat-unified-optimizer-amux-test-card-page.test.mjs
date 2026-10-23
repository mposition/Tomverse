import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { confirmAmuxIntakePreview } from
  "../../components/admin/amuxIntakeConfirmation.ts";
import { createAmuxU21TestDraft } from
  "../../components/admin/amuxU21TestDraft.ts";
import { amuxIntakeDraftDigest, parseAmuxIntakeDraft } from
  "../../lib/amux/intakeCore.ts";
import { previewAmuxIntake } from
  "../../lib/amux/intakeRegistrationCore.ts";

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

test("explicit preview confirmation enables only the same U21 draft", () => {
  const secret = "u21-test-intake-secret-000000000000";
  const raw = JSON.stringify({ canonicalizationVersion: "amux-json-v1",
    policyVersion: 1, explicitRegistration: true,
    sourceTaskId: "u21-public-test-card-1", workItem: null,
    proposal: { title: "Disposable U21 public candidate test card",
      scope: "One isolated public candidate author test card",
      completion: "A public candidate receipt is recorded",
      priority: "p3" } });
  const first = previewAmuxIntake(raw, secret, "enabled");
  assert.equal(first.outcome, "approval_required");
  assert.equal(first.applyPermitted, false);
  const confirmed = confirmAmuxIntakePreview(raw, raw, first);
  assert.ok(confirmed);
  const parsed = parseAmuxIntakeDraft(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(JSON.parse(confirmed).confirmationDigest,
    amuxIntakeDraftDigest(parsed.draft));
  const second = previewAmuxIntake(confirmed, secret, "enabled");
  assert.equal(second.outcome, "allow");
  assert.equal(second.applyPermitted, true);
  assert.equal(confirmAmuxIntakePreview(raw + " ", raw, first), null);
  assert.equal(confirmAmuxIntakePreview(confirmed, confirmed, first), null);
});

test("prepared U21 test draft is one valid disposable registration", () => {
  const first = createAmuxU21TestDraft("11111111-1111-4111-8111-111111111111");
  const second = createAmuxU21TestDraft("22222222-2222-4222-8222-222222222222");
  const parsed = parseAmuxIntakeDraft(first);
  assert.equal(parsed.ok, true);
  assert.notEqual(JSON.parse(first).sourceTaskId, JSON.parse(second).sourceTaskId);
  if (!parsed.ok) return;
  assert.equal(parsed.draft.workItem, null);
  assert.equal(parsed.draft.proposal.priority, "p3");
  assert.equal(parsed.draft.confirmationDigest, undefined);
  const preview = previewAmuxIntake(first,
    "u21-test-intake-secret-000000000000", "enabled");
  assert.equal(preview.outcome, "approval_required");
  assert.equal(preview.applyPermitted, false);
});
