import assert from "node:assert/strict";
import test from "node:test";
import { adminNotificationNeedsAcknowledgement } from "../lib/adminNotificationAttention.ts";

test("a delivered halt offers acknowledgement, while a read halt and ordinary sent notices do not", () => {
  const halt = { channel: "in_app", status: "sent", targetType: "DailyProductAgentRun", acknowledgedAt: null };
  assert.equal(adminNotificationNeedsAcknowledgement(halt), true);
  assert.equal(adminNotificationNeedsAcknowledgement({ ...halt, acknowledgedAt: "read" }), false);
  assert.equal(adminNotificationNeedsAcknowledgement({ ...halt, targetType: "AmuxIdeaRetentionHold" }), false);
  assert.equal(adminNotificationNeedsAcknowledgement({ ...halt, channel: "email", targetType: null, status: "failed" }), true);
  assert.equal(adminNotificationNeedsAcknowledgement({ ...halt, channel: "email", targetType: null }), false);
});
