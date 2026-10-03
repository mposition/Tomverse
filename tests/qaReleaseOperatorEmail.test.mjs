import assert from "node:assert/strict";
import test from "node:test";

import { buildQaReleaseOperatorEmail, qaReleaseStaleDateFromReference } from "../lib/qaReleaseOperatorEmail.ts";

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
