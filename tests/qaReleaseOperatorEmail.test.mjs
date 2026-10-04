import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQaReleaseOperatorEmail,
  qaReleaseAttentionDateFromReference,
  qaReleaseDigestRecordedDateFromReference,
  qaReleaseMergeLaneLatchDateFromReference,
  qaReleaseMonitorFailureDateFromReference,
  qaReleaseStaleDateFromReference,
} from "../lib/qaReleaseOperatorEmail.ts";

test("the monitor-failure alert is its own fixed subject and sentence, with the date and the Admin link", () => {
  const email = buildQaReleaseOperatorEmail("monitor_failed", {
    date: "2026-10-03",
    consoleUrl: "https://tomverse.app/admin/agent-digests?tab=qa-release",
  });
  assert.equal(email.subject, "Tomverse QA release digest check could not finish");
  assert.notEqual(email.text, buildQaReleaseOperatorEmail("digest_stale", { date: "2026-10-03", consoleUrl: "x" }).text);
  assert.match(email.text, /Date \(UTC\): 2026-10-03/);
  assert.match(email.text, /not known/);
});

test("the needs-a-check alert names both mismatches and nothing the agent read", () => {
  const email = buildQaReleaseOperatorEmail("attention", {
    date: "2026-10-03",
    consoleUrl: "https://tomverse.app/admin/agent-digests?tab=qa-release",
  });
  assert.equal(email.subject, "Tomverse QA release agent needs a check");
  assert.match(email.text, /revision other than the newest/);
  assert.match(email.text, /secret is missing/);
  assert.equal(qaReleaseAttentionDateFromReference("attention:2026-10-03"), "2026-10-03");
  assert.equal(qaReleaseAttentionDateFromReference("stale:2026-10-03"), null);
  assert.equal(qaReleaseAttentionDateFromReference("attention:2026-10-03x"), null);
});

test("the recorded notice says it is a report, with the digest's date", () => {
  const email = buildQaReleaseOperatorEmail("digest_recorded", { date: "2026-10-02", consoleUrl: "https://tomverse.app/x" });
  assert.equal(email.subject, "Tomverse QA release digest recorded");
  assert.match(email.text, /report, not a judgement/);
  assert.match(email.text, /Date \(UTC\): 2026-10-02/);
  assert.equal(qaReleaseDigestRecordedDateFromReference("recorded:2026-10-02"), "2026-10-02");
  assert.equal(qaReleaseDigestRecordedDateFromReference("attention:2026-10-02"), null);
});

test("the merge lane latch alert says the lane stopped and a person releases it", () => {
  const email = buildQaReleaseOperatorEmail("merge_lane_latched", { date: "2026-10-04", consoleUrl: "https://tomverse.app/x" });
  assert.equal(email.subject, "Tomverse develop merge lane stopped");
  assert.match(email.text, /until a person releases the latch/);
  assert.match(email.text, /another operator control revision/);
  assert.equal(qaReleaseMergeLaneLatchDateFromReference("merge-lane-latch:2026-10-04"), "2026-10-04");
  assert.equal(qaReleaseMergeLaneLatchDateFromReference("attention:2026-10-04"), null);
});

test("each kind reads only its own reference shape", () => {
  assert.equal(qaReleaseMonitorFailureDateFromReference("monitor-failure:2026-10-03"), "2026-10-03");
  assert.equal(qaReleaseMonitorFailureDateFromReference("stale:2026-10-03"), null);
  assert.equal(qaReleaseStaleDateFromReference("monitor-failure:2026-10-03"), null);
  for (const reference of ["monitor-failure:", "monitor-failure:2026-1-3", "monitor-failure:2026-10-03x"]) {
    assert.equal(qaReleaseMonitorFailureDateFromReference(reference), null, reference);
  }
});

test("the silence alert is a fixed subject, a fixed sentence, the date and the Admin link", () => {
  const email = buildQaReleaseOperatorEmail("digest_stale", {
    date: "2026-10-03",
    consoleUrl: "https://tomverse.app/admin/agent-digests?tab=qa-release",
  });
  assert.equal(email.subject, "Tomverse QA release digest has gone quiet");
  assert.match(email.text, /Date \(UTC\): 2026-10-03/);
  assert.match(email.text, /Console: https:\/\/tomverse\.app\/admin\/agent-digests\?tab=qa-release/);
  assert.ok(email.html.includes("tab=qa-release"));
  // Deterministic: the retry queue re-renders the same payload.
  assert.deepEqual(email, buildQaReleaseOperatorEmail("digest_stale", {
    date: "2026-10-03",
    consoleUrl: "https://tomverse.app/admin/agent-digests?tab=qa-release",
  }));
});

test("only a well-formed stale reference yields a date", () => {
  assert.equal(qaReleaseStaleDateFromReference("stale:2026-10-03"), "2026-10-03");
  for (const reference of ["stale:", "stale:2026-1-3", "fresh:2026-10-03", "stale:2026-10-03x", "x stale:2026-10-03"]) {
    assert.equal(qaReleaseStaleDateFromReference(reference), null, reference);
  }
});
