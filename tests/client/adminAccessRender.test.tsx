import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminAccessView, describeAdminRoleCapability } from "@/components/admin/AdminAccessPanel";
import { AdminReadinessChecklist, checkpointState, type Checkpoint } from "@/components/admin/AdminOperationalReadinessPanel";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminAccessMessages } from "@/lib/adminMessages/adminAccess";
import type { ConfiguredAdminAccess } from "@/lib/adminAuth";

const en = adminMessagesFor(adminAccessMessages, "en");
const ko = adminMessagesFor(adminAccessMessages, "ko");

const entry = (overrides: Partial<ConfiguredAdminAccess>): ConfiguredAdminAccess => ({
  identity: "owner@example.test",
  identityType: "email",
  role: "owner",
  accessEnabled: true,
  expiresAt: null,
  expired: false,
  lastLoginAt: "2026-11-06T14:00:00Z",
  lastActivityAt: null,
  ...overrides,
});

test("a role is described from the same matrix the role table draws", () => {
  assert.equal(describeAdminRoleCapability("owner", en), "Everything, including destructive actions");
  assert.equal(
    describeAdminRoleCapability("billing", en),
    "Can change billing; can view users, AI and operations, customer support"
  );
  assert.equal(describeAdminRoleCapability("readonly", en), "Can only view users, billing, AI and operations, customer support");
  assert.equal(describeAdminRoleCapability("not-authorized", en), "Cannot use the console");
  assert.equal(describeAdminRoleCapability("support", ko), "고객지원 바꾸기, 사용자, AI와 운영 보기");
});

test("each administrator is a card with role, what they can do, expiry and last sign-in in AEST", () => {
  const html = renderToStaticMarkup(
    <AdminAccessView
      m={en}
      access={[
        entry({}),
        entry({ identity: "support@example.test", role: "support", expiresAt: "2027-03-01T00:00:00Z" }),
        entry({ identity: "old@example.test", role: "readonly", expiresAt: "2026-01-01T00:00:00Z", expired: true, accessEnabled: false }),
      ]}
    />
  );
  assert.match(html, /<h2[^>]*>Least-privilege access<\/h2>/);
  assert.match(html, /data-testid="admin-access-cards"/);
  assert.match(html, />owner@example\.test</);
  assert.match(html, />owner</);
  assert.match(html, /Everything, including destructive actions/);
  assert.match(html, /No expiry/);
  // 14:00 UTC is midnight in Brisbane.
  assert.match(html, /2026-11-07 00:00 AEST/);
  assert.match(html, />2027-03-01</);
  // Never signed in is said as such, not left blank.
  assert.match(html, /Never/);
  // An expired identity says so; the access-off chip is not stacked on top of it.
  assert.match(html, /data-tone="bad"[^>]*>Expired</);
  assert.doesNotMatch(html, />Access disabled</);
  // The role table is kept, folded under technical details.
  assert.match(html, /Technical details/);
  assert.match(html, /ADMIN_ACCESS_EXPIRY_JSON/);
});

test("no configured administrator is an alert, in Korean as well", () => {
  const html = renderToStaticMarkup(<AdminAccessView m={ko} access={[]} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /구성된 관리자 계정이 없어요\./);
});

const checkpoint = (overrides: Partial<Checkpoint>): Checkpoint => ({
  key: "backup",
  name: "Backup restore drill",
  status: "healthy",
  observedAt: "2026-11-01T00:00:00Z",
  nextDueAt: "2026-12-01T00:00:00Z",
  detail: null,
  evidenceUrl: null,
  updatedByEmail: null,
  updatedAt: "2026-11-01T00:00:00Z",
  overdue: false,
  defaultDueDays: 30,
  ...overrides,
});

test("only a verified, healthy, in-date checkpoint is ready", () => {
  assert.equal(checkpointState(checkpoint({})), "ready");
  assert.equal(checkpointState(checkpoint({ overdue: true })), "overdue");
  assert.equal(checkpointState(checkpoint({ status: "failed" })), "failed");
  assert.equal(checkpointState(checkpoint({ status: "failed", overdue: false })), "failed");
  assert.equal(checkpointState(checkpoint({ status: "warning" })), "warning");
  assert.equal(checkpointState(checkpoint({ status: "not_verified", observedAt: null })), "notVerified");
  assert.equal(checkpointState(checkpoint({ observedAt: null })), "notVerified");
  assert.equal(checkpointState(checkpoint({ status: "not_configured" })), "notConfigured");
});

test("the checklist counts the ready ones and names why each other one is not", () => {
  const html = renderToStaticMarkup(
    <AdminReadinessChecklist
      rows={[
        checkpoint({}),
        checkpoint({ key: "access", name: "Access review", overdue: true }),
        checkpoint({ key: "archive", name: "External archive", status: "not_verified", observedAt: null, nextDueAt: null }),
      ]}
    />
  );
  assert.match(html, /<h2[^>]*>Recovery and access checkpoints<\/h2>/);
  assert.match(html, /1 \/ 3 ready/);
  assert.match(html, /data-tone="warn"[^>]*>1 \/ 3 ready/);
  assert.match(html, /data-tone="ok"[^>]*>Ready</);
  assert.match(html, /data-tone="warn"[^>]*>Overdue</);
  assert.match(html, /data-tone="unknown"[^>]*>Not verified yet</);
  assert.match(html, /Verified 2026-11-01 10:00:00 AEST/);
  assert.match(html, /Never verified/);
  // The recording form stays, folded inside each row.
  assert.match(html, /<details[^>]*data-state="overdue"/);
  assert.match(html, /Verify checkpoint/);
});
