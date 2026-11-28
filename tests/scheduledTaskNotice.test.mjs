import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEDULED_TASK_PAUSED_TEMPLATE,
  SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE,
  buildScheduledTaskNoticeEmail,
  emailTemplateDefinition,
  templateDefinitionProblems,
} from "../lib/emailTemplateDefinitions.ts";
import { emailPurposeEntry } from "../lib/emailPreferenceCore.ts";
import {
  formatScheduledRunTime,
  scheduledRunNoticeKind,
  scheduledTaskEmailEnabled,
} from "../lib/scheduledTaskCore.ts";

/* The pure half of the scheduled-task result email (lib/scheduledTaskNotice.ts). */

test("the email switch is exactly \"true\"", () => {
  assert.equal(scheduledTaskEmailEnabled({ SCHEDULED_TASK_EMAIL_ENABLED: "true" }), true);
  for (const value of [undefined, "", "TRUE", "1", "yes", " true"]) {
    assert.equal(scheduledTaskEmailEnabled({ SCHEDULED_TASK_EMAIL_ENABLED: value }), false, String(value));
  }
});

test("a run owes an answer notice, a pause notice, or nothing", () => {
  assert.equal(scheduledRunNoticeKind({ status: "succeeded", pausedTask: false }), "answered");
  assert.equal(scheduledRunNoticeKind({ status: "skipped", pausedTask: true }), "paused");
  assert.equal(scheduledRunNoticeKind({ status: "failed", pausedTask: true }), "paused");
  assert.equal(scheduledRunNoticeKind({ status: "failed", pausedTask: false }), null);
  assert.equal(scheduledRunNoticeKind({ status: "skipped", pausedTask: false }), null);
  assert.equal(scheduledRunNoticeKind({ status: "unknown", pausedTask: false }), null);
});

test("both templates are service mail gated by the scheduled_tasks purpose", () => {
  for (const key of [SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE, SCHEDULED_TASK_PAUSED_TEMPLATE]) {
    const definition = emailTemplateDefinition(key);
    assert.deepEqual(templateDefinitionProblems(definition), [], key);
    assert.equal(definition.classification, "service");
    assert.equal(definition.purpose, "scheduled_tasks");
  }
  const purpose = emailPurposeEntry("scheduled_tasks");
  assert.equal(purpose?.classification, "service");
  assert.equal(purpose?.consentRequired, false);
  assert.equal(purpose?.locked, false);
  assert.equal(purpose?.withdrawnByBulkUnsubscribe, false);
});

const payload = {
  taskTitle: 'News <b>"digest"</b>',
  runAt: "28 Nov 2026, 08:00 GMT+10",
  actionUrl: "https://tomverse.app/chat?c=abc",
  settingsUrl: "https://tomverse.app/settings/notifications",
};

test("the notice carries the name, the time and the links, escaped, in every email language", () => {
  for (const language of ["en", "ko", "zh", "fr", "de", "es", "pt"]) {
    for (const kind of ["answered", "paused"]) {
      const email = buildScheduledTaskNoticeEmail(kind, payload, language);
      assert.ok(email.subject.includes(payload.taskTitle), `${language}/${kind} subject`);
      assert.ok(email.text.includes(payload.runAt), `${language}/${kind} time`);
      assert.ok(email.text.includes(payload.actionUrl) && email.text.includes(payload.settingsUrl));
      assert.ok(!email.html.includes("<b>"), `${language}/${kind}: the title is escaped`);
      assert.ok(email.html.includes("&lt;b&gt;&quot;digest&quot;&lt;/b&gt;"));
      // Deterministic, so a retry renders the same bytes.
      assert.deepEqual(buildScheduledTaskNoticeEmail(kind, payload, language), email);
    }
  }
  assert.notEqual(
    buildScheduledTaskNoticeEmail("answered", payload, "ko").subject,
    buildScheduledTaskNoticeEmail("answered", payload, "en").subject
  );
  // zh-Hant reads English, as every other account mail does.
  assert.deepEqual(
    buildScheduledTaskNoticeEmail("paused", payload, "zh-Hant"),
    buildScheduledTaskNoticeEmail("paused", payload, "en")
  );
});

test("the run time is written in the task's zone and says which zone", () => {
  const at = new Date("2026-11-28T22:00:00Z");
  const brisbane = formatScheduledRunTime(at, "Australia/Brisbane", "en");
  assert.match(brisbane, /29/);
  assert.match(brisbane, /08:00/);
  assert.match(brisbane, /GMT\+10|AEST/);
  // An unusable zone falls back to UTC rather than failing the notice.
  assert.equal(formatScheduledRunTime(at, "Not/A_Zone", "en"), "2026-11-28 22:00 UTC");
});

test("an unsettled run's notice is read back from the run and its task", async () => {
  const { recoveredNoticeKind } = await import("../lib/scheduledTaskCore.ts");
  const paused = { runStatus: "failed", runRevision: 2, taskStatus: "paused", taskRevision: 2, pauseReason: "repeated_failures", isLatestRun: true };
  assert.equal(recoveredNoticeKind({ ...paused, runStatus: "succeeded" }), "answered");
  assert.equal(recoveredNoticeKind(paused), "paused");
  assert.equal(recoveredNoticeKind({ ...paused, runStatus: "skipped", pauseReason: "insufficient_credits" }), "paused");
  // Not this run's pause: the owner paused it, it was edited or resumed since, a later run exists.
  assert.equal(recoveredNoticeKind({ ...paused, pauseReason: "user" }), null);
  assert.equal(recoveredNoticeKind({ ...paused, taskRevision: 3 }), null);
  assert.equal(recoveredNoticeKind({ ...paused, isLatestRun: false }), null);
  assert.equal(recoveredNoticeKind({ ...paused, taskStatus: "active", pauseReason: null }), null);
  assert.equal(recoveredNoticeKind({ ...paused, runStatus: "unknown" }), null);
});
