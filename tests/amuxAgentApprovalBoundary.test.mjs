import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/admin/amux/escalations/route.ts", import.meta.url),
  "utf8",
);
const proxy = await readFile(
  new URL("../lib/amux/reviewAdminProxy.ts", import.meta.url),
  "utf8",
);
const internalRoute = await readFile(
  new URL("../app/api/internal/amux/review/route.ts", import.meta.url),
  "utf8",
);
const writer = await readFile(
  new URL("../lib/amux/reviewApproval.ts", import.meta.url),
  "utf8",
);

test("human escalation resolution does not borrow the two-person admin approval", () => {
  assert.doesNotMatch(route, /runWithAdminApproval|runWithAmuxApproval/);
  assert.doesNotMatch(route, /@\/lib\/amux\/approvals/);
  for (const source of [proxy, internalRoute, writer]) {
    assert.doesNotMatch(source, /runWithAdminApproval|runWithAmuxApproval/);
    assert.doesNotMatch(source, /@\/lib\/amux\/approvals/);
  }
  assert.match(route, /forwardAmuxAdminReviewCommand/);
  assert.match(proxy, /AMUX_AGENT_APPROVAL_UNAVAILABLE/);
  assert.match(proxy, /amuxReviewPrivateProxyOrigin/);
  assert.match(proxy, /request\.headers\.get\("host"\)/);
  assert.match(proxy, /requestHost !== publicOrigin\.host\.toLowerCase\(\)/);
  assert.match(proxy, /AMUX_REVIEW_PROXY_ORIGIN_MISMATCH/);
  assert.match(internalRoute, /AMUX_AGENT_APPROVAL_UNAVAILABLE/);
  assert.match(proxy, /command\.action !== "acknowledge"\s*&&\s*command\.action !== "decision_status"\s*&&\s*!isAmuxAgentApprovalEnabled/);
  assert.match(internalRoute, /action\.action !== "decision_status"\s*&&\s*!isAmuxAgentApprovalEnabled/);
});
