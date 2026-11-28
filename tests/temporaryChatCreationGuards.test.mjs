import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Source-level contracts for guards whose behaviour needs a database to run
// (tests/integration/*). They pin the substitutions that would reopen the gap:
// a paid run started in a conversation the sweep is about to delete, and a
// scheduled run that can be told apart by a header.

test("research refuses an expired temporary Chat before it starts a paid run", () => {
  const source = readFileSync("lib/researchEngineService.ts", "utf8");
  assert.match(source, /temporaryExpiresAt: true/);
  assert.match(source, /isTemporaryConversationExpired\(conversation\.temporaryExpiresAt, new Date\(\)\)/);
  assert.match(source, /refuse\(410, "TEMPORARY_CHAT_EXPIRED"/);
});

test("image generation refuses an expired temporary Chat as the chat route does", () => {
  const source = readFileSync("lib/imageGenerationService.ts", "utf8");
  assert.match(source, /isTemporaryConversationExpired\(conversation\.temporaryExpiresAt, now\)/);
  assert.match(source, /new ChatAccessError\(410, TEMPORARY_CHAT_EXPIRED/);
});

test("a scheduled run leaves the per-IP minute bucket on the in-process proof, never a header", () => {
  const source = readFileSync("lib/chatSecurity.ts", "utf8");
  const start = source.indexOf("const scheduledRunScope = currentScheduledTaskRun();");
  assert.ok(start > 0);
  const block = source.slice(start, source.indexOf("const ipMinuteStart", start));
  // Bound to the account the run belongs to, and to a signed-in caller.
  assert.match(block, /access\.kind === "user"/);
  assert.match(block, /scheduledRunScope\?\.userId === access\.userId/);
  assert.match(block, /!claimedAdmissionSlot && !guestAutoPrehold && !isScheduledRun/);
  // Nothing on the request decides it.
  assert.doesNotMatch(block, /headers|x-scheduled|internal/i);
  // The runner still builds its own request with no such header.
  const runner = readFileSync("lib/scheduledTaskRunner.ts", "utf8");
  assert.doesNotMatch(runner, /x-scheduled|x-internal/i);
});

test("the Research Preview run service refuses an expired temporary Chat too", () => {
  const source = readFileSync("lib/researchPreviewRunService.ts", "utf8");
  assert.match(source, /temporaryExpiresAt: true/);
  assert.match(source, /isTemporaryConversationExpired\(conversation\.temporaryExpiresAt, new Date\(\)\)/);
  assert.match(source, /new ResearchPreviewRunError\(410, "TEMPORARY_CHAT_EXPIRED"/);
});
