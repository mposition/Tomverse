import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, new URL("../", import.meta.url)), "utf8");

test("v19 unknown-cost resolution is owner-only, step-up, same-origin and dark", async () => {
  const [route, service] = await Promise.all([
    read("app/api/admin/amux/ideas/session-budget-resolution/route.ts"),
    read("lib/amux/ideaSessionAnalysisBudgetResolutionService.ts"),
  ]);
  assert.match(route, /getAdminRole\(session\) === "owner"/);
  assert.match(route, /TOMVERSE_AMUX_V19_SESSION_BUDGET_RESOLUTION_READ/);
  assert.match(route, /TOMVERSE_AMUX_V19_SESSION_BUDGET_RESOLUTION_WRITE/);
  assert.match(route, /hasValidMutationOrigin\(request\)/);
  assert.match(route, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(route, /retryAutomatically: false/);
  assert.match(service, /assertRecentAdminAuthentication\(input\.session\)/);
  assert.match(service, /writeAdminAuditLog/);
  assert.match(service, /verification === "proven_not_started"/);
  assert.match(service, /claim\.reservedMicroUsd/);
  assert.doesNotMatch(route + service,
    /CreditAccount|CreditLot|ChatCost|Conversation/);
});
