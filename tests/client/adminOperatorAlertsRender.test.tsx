import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminAlertPolicyPanel, AdminAlertRoutes } from "@/components/admin/AdminAlertPolicyPanel";
import { AdminOperatorAlertProbePanel } from "@/components/admin/AdminOperatorAlertProbePanel";
import { AdminSlackTemplatesPanel } from "@/components/admin/AdminSlackTemplatesPanel";
import { adminAlertPolicyMessages } from "@/lib/adminMessages/alertPolicy";
import { adminNotificationsMessages } from "@/lib/adminMessages/notifications";
import { adminOperatorAlertProbeMessages } from "@/lib/adminMessages/operatorAlertProbe";
import { adminSlackTemplatesMessages } from "@/lib/adminMessages/slackTemplates";

/**
 * Operator alerts (Messaging group): the policy table, the mail path test and
 * the states a panel is in before its read has come back.
 */

const policy = (over: Record<string, unknown> = {}) => ({
  id: "policy-1",
  name: "Default alerts",
  provider: null,
  isActive: true,
  budgetThresholds: "[50,80,95]",
  providerFailureThreshold: 5,
  modelFailureThreshold: 3,
  notifyEmail: true,
  notifySlack: true,
  notifyDiscord: false,
  ...over,
});

test("each policy shows where it sends, and a policy with no channel says so", () => {
  const html = renderToStaticMarkup(
    <AdminAlertRoutes
      policies={[policy(), policy({ id: "policy-2", name: "Quiet", notifyEmail: false, notifySlack: false })]}
    />
  );
  assert.match(html, /data-testid="alert-routes"/);
  assert.match(html, /How urgent, and where it goes/);
  assert.match(html, /Default alerts/);
  assert.match(html, /50%, 80%, 95%/);
  assert.match(html, />Slack</);
  // Discord is off for both policies, so it is not drawn as a route.
  assert.doesNotMatch(html, />Discord</);
  assert.match(html, /No channel/);
});

test("an inactive policy is drawn as off, not healthy", () => {
  const html = renderToStaticMarkup(<AdminAlertRoutes policies={[policy({ isActive: false })]} />);
  assert.match(html, /data-tone="idle"[^>]*>Off</);
  assert.doesNotMatch(html, /data-tone="ok"/);
});

test("no policies is an empty state, not a blank table", () => {
  const html = renderToStaticMarkup(<AdminAlertRoutes policies={[]} />);
  assert.match(html, /No alert policies are set up\./);
});

test("before the read returns the policy panel loads, and links on to the log and the mail test", () => {
  const html = renderToStaticMarkup(<AdminAlertPolicyPanel />);
  assert.match(html, /role="status" aria-label="Loading"/);
  assert.doesNotMatch(html, /No alert policies are set up/);
  assert.match(html, /href="\/admin\/alerts\?tab=mail-test"/);
  assert.match(html, /href="\/admin\/alerts\?tab=deliveries"/);
});

test("the mail path test keeps its test ids and says what a pass proves", () => {
  const html = renderToStaticMarkup(<AdminOperatorAlertProbePanel />);
  assert.match(html, /data-testid="operator-alert-probe"/);
  assert.match(html, /<h2[^>]*>Operator alert paths<\/h2>/);
  assert.match(html, /data-testid="operator-alert-probe-operational"/);
  assert.match(html, /data-testid="operator-alert-probe-provider"/);
  assert.match(html, /does not show that the condition/);
  assert.equal((html.match(/>Send test</g) ?? []).length, 2);
  // The env names the mail goes to are internal detail, folded away.
  assert.match(html, /<details[^>]*>[\s\S]*ADMIN_ALERT_EMAIL/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("the templates panel loads before it shows any template", () => {
  const html = renderToStaticMarkup(<AdminSlackTemplatesPanel />);
  assert.match(html, /Templates and delivery tests/);
  assert.match(html, /role="status" aria-label="Loading"/);
});

test("the alert copy exists in both languages with the same keys", () => {
  const keys = (value: unknown): string[] =>
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item && typeof item === "object" ? keys(item).map((inner) => `${key}.${inner}`) : [key]
    );
  for (const catalog of [
    adminAlertPolicyMessages,
    adminNotificationsMessages,
    adminOperatorAlertProbeMessages,
    adminSlackTemplatesMessages,
  ]) {
    assert.deepEqual(keys(catalog.ko).sort(), keys(catalog.en).sort());
  }
  // The failure of a read is worded, never left to a bare toast.
  assert.match(adminNotificationsMessages.ko.loadFailedDetail, /다시 시도/);
});
