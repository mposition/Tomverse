import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ADMIN_FETCH_TIMEOUT_MS } from "../lib/adminFetch.ts";
import {
  AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS,
  AMUX_IDEA_CARD_PLAN_APPROVAL_TRANSACTION,
  AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS,
  AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION,
  AMUX_IDEA_NODE_PLAN_APPROVAL_TRANSACTION,
  AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS,
  AMUX_IDEA_PLAN_APPROVAL_TRANSACTION,
  AMUX_IDEA_REQUEST_MARGIN_MS,
  AMUX_IDEA_STANDARD_TRANSACTION,
  amuxIdeaRequestTimeoutMs,
} from "../lib/amux/ideaRequestTimeoutsCore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("a request that waits for a transaction outlasts the transaction's wait and timeout", () => {
  // Production, 2026-10-16: the plan approval ran in one 120 s transaction, adminFetch aborted the POST at
  // 15 s (HTTP 499 at the proxy) and the operator was told the outcome was unknown.
  assert.equal(AMUX_IDEA_PLAN_APPROVAL_TRANSACTION.timeout, 120_000);
  assert.ok(AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS >
    AMUX_IDEA_PLAN_APPROVAL_TRANSACTION.maxWait + AMUX_IDEA_PLAN_APPROVAL_TRANSACTION.timeout);
  assert.ok(AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS > ADMIN_FETCH_TIMEOUT_MS);
  assert.equal(AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS, 135_000);
  assert.ok(AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS >
    AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION.maxWait + AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION.timeout);
  assert.equal(AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS, 35_000);
  // The build-preview chain runs three standard transactions, one after the other.
  const one = AMUX_IDEA_STANDARD_TRANSACTION.maxWait + AMUX_IDEA_STANDARD_TRANSACTION.timeout;
  assert.ok(AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS >= 3 * one + AMUX_IDEA_REQUEST_MARGIN_MS);
  assert.equal(AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS, 70_000);
  assert.equal(amuxIdeaRequestTimeoutMs(), AMUX_IDEA_REQUEST_MARGIN_MS);
});

test("the services take their transaction limits from the one table, so a deadline cannot drift from them", () => {
  const uses = (path, name) => assert.ok(read(path).includes(`...${name}`), `${path} uses ${name}`);
  uses("lib/amux/ideaPlanApprovalService.ts", "AMUX_IDEA_PLAN_APPROVAL_TRANSACTION");
  uses("lib/amux/ideaExecutionApprovalService.ts", "AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION");
  uses("lib/amux/ideaCardPlanApprovalService.ts", "AMUX_IDEA_CARD_PLAN_APPROVAL_TRANSACTION");
  uses("lib/amux/ideaNodePlanApprovalService.ts", "AMUX_IDEA_NODE_PLAN_APPROVAL_TRANSACTION");
  for (const path of ["lib/amux/ideaSubmissionService.ts", "lib/amux/ideaInitialSourcePlanAccess.ts",
    "lib/amux/ideaTransferPreviewService.ts"]) uses(path, "AMUX_IDEA_STANDARD_TRANSACTION");
  assert.ok(AMUX_IDEA_CARD_PLAN_APPROVAL_TRANSACTION.timeout > ADMIN_FETCH_TIMEOUT_MS);
  assert.ok(AMUX_IDEA_NODE_PLAN_APPROVAL_TRANSACTION.timeout > ADMIN_FETCH_TIMEOUT_MS);
  // No Ideas service may open a transaction longer than the standard one with a literal of its own: a long
  // transaction is declared in the table, next to the deadline its caller needs.
  for (const name of readdirSync(join(root, "lib/amux")).filter((file) => /^idea.*\.ts$/.test(file) && file !== "ideaRequestTimeoutsCore.ts")) {
    for (const match of read(`lib/amux/${name}`).matchAll(/timeout:\s*([\d_]+)/g)) {
      const value = Number(match[1].replaceAll("_", ""));
      assert.ok(value <= AMUX_IDEA_STANDARD_TRANSACTION.timeout, `${name} has a ${value} ms transaction literal`);
    }
  }
});

test("the plan approval, the execution approval and the build preview post with their own deadline", () => {
  const plan = read("components/admin/AmuxIdeaPlanApprovalPanel.tsx");
  const planCall = plan.slice(plan.indexOf('adminFetch("/api/admin/amux/ideas/plan"'));
  assert.ok(planCall.slice(0, 400).includes("timeoutMs: AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS"));
  const frontier = read("components/admin/AmuxFrontierModelsPanel.tsx");
  for (const [route, constant] of [["execution-approval", "AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS"],
    ["build-preview", "AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS"]]) {
    const call = frontier.slice(frontier.indexOf(`adminFetch("/api/admin/amux/ideas/${route}"`));
    assert.ok(call.slice(0, 400).includes(`timeoutMs: ${constant}`), `${route} sets ${constant}`);
  }
  // The unknown-outcome read-back stays: a lost answer is read, never posted again.
  assert.ok(plan.includes("A lost answer is read back, never re-posted."));
  assert.ok(plan.includes('setState("unknown")'));
});
