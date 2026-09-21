import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/admin/amux/escalations/route.ts", import.meta.url),
  "utf8",
);

test("human escalation resolution does not borrow the two-person admin approval", () => {
  assert.doesNotMatch(route, /runWithAdminApproval|runWithAmuxApproval/);
  assert.doesNotMatch(route, /@\/lib\/amux\/approvals/);
  assert.match(route, /AMUX_AGENT_APPROVAL_UNAVAILABLE/);
});
