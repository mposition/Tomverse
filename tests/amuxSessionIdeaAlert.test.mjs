import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_SESSION_IDEA_ALERT_CODE,
  reportAmuxSessionIdeaNeedsOperator } from
  "../lib/amux/ideaSessionAnalysisAlert.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const env = { PUBLIC_APP_URL: "https://tomverse.example/" };

test("a session idea alert carries the Admin link and a closed reason only", async () => {
  const sent = [];
  await reportAmuxSessionIdeaNeedsOperator({ requestId,
    reason: "invalid_result" }, { env, report: async (incident) => {
    sent.push(incident); } });
  assert.deepEqual(sent, [{ code: AMUX_SESSION_IDEA_ALERT_CODE,
    title: "An AMUX session idea needs the operator", severity: "warning",
    forceNotification: true, context: { component: "amux-intake",
      reason: "invalid_result",
      admin: `https://tomverse.example/admin/amux-backlog?tab=ideas&idea=${requestId}` } }]);
});

test("anything outside the closed shapes is not sent, and a failed send never throws", async () => {
  const sent = [];
  const report = async (incident) => { sent.push(incident); };
  await reportAmuxSessionIdeaNeedsOperator({ requestId: "not-a-uuid",
    reason: "invalid_result" }, { env, report });
  await reportAmuxSessionIdeaNeedsOperator({ requestId,
    reason: "Free text with spaces" }, { env, report });
  assert.deepEqual(sent, []);
  await reportAmuxSessionIdeaNeedsOperator({ requestId, reason: "write_disabled" },
    { env, report: async () => { throw new Error("delivery failed"); } });
});
