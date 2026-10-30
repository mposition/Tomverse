import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { type ReactNode } from "react";

import { AmuxIdeaCardRegistrationPanel } from
  "@/components/admin/AmuxIdeaStoryRegistrationPanel";
import { amuxTaskRegistrationRefusalPresentation } from
  "@/components/admin/amuxIdeaRegistrationRefusalUi";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import type { AmuxVisibleAnalysisUnit } from "@/lib/amux/ideaAnalysisResultReadCore";

const EXPECTED = {
  task_expected_paths_missing: "taskRegistrationExpectedPathsRefused",
  task_expected_paths_out_of_range: "taskRegistrationExpectedPathsRefused",
  task_expected_path_invalid: "taskRegistrationExpectedPathsRefused",
  task_expected_paths_duplicate: "taskRegistrationExpectedPathsRefused",
  task_expected_paths_mixed: "taskRegistrationMixedPathsRefused",
  task_role_review_refused: "taskRegistrationReviewRoleRefused",
  task_execution_grade_mismatch: "taskRegistrationGradeRefused",
  task_confirmation_grade_mismatch: "taskRegistrationGradeRefused",
  task_cost_receipt_grade_mismatch: "taskRegistrationGradeRefused",
  task_role_not_runnable: "taskRegistrationRoleNotRunnable",
  task_route_unpriced: "taskRegistrationRouteUnpriced",
} as const;

test("all stable Task registration refusals clear stale duplicate state and select actionable copy", () => {
  for (const [code, messageKey] of Object.entries(EXPECTED)) {
    assert.deepEqual(amuxTaskRegistrationRefusalPresentation(code), {
      messageKey,
      clearDuplicateState: true,
    });
    for (const locale of ["en", "ko"] as const) {
      const message = adminAmuxIdeaInputMessages[locale][messageKey];
      assert.equal(message.includes(code), false, `${locale} copy must not expose ${code}`);
      assert.ok(message.length > 40, `${locale} copy must explain the corrective action`);
    }
  }
});

test("unknown and existing generic failures keep the existing fallback path", () => {
  for (const code of ["unavailable", "reconfirm", "duplicate_reason_required"]) {
    assert.equal(amuxTaskRegistrationRefusalPresentation(code), null);
  }
});

type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean" ||
      typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const UNIT: AmuxVisibleAnalysisUnit = {
  id: "analysis-card-1",
  localRef: "c0:card-1",
  bodyDigest: "b".repeat(64),
  bodyDigestKeyId: "analysis-body-key",
  decisionState: "proposed",
  proposal: {
    kind: "card",
    localId: "c0:card-1",
    cardType: "task",
    storyKind: null,
    title: "Implement the guarded change",
    problem: "The guarded change is not implemented.",
    scopeIn: ["Implement it."],
    scopeOut: ["Do not deploy it."],
    completionCriteria: ["The focused test passes."],
    featureRef: "feature-123",
    parentStoryRef: null,
    dependencyRefs: [],
    duplicateCandidateRefs: [],
    taskRole: "implement",
    executionGrade: "routine",
    executionBrief: "Implement the focused guarded change.",
    sourceRefIds: ["source-123"],
    expectedPaths: ["components/admin/example.tsx"],
  },
};

function mount(locale: "en" | "ko" = "en") {
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  assert.ok(internals && "H" in internals, "installed React client dispatcher is required");
  const slots: unknown[] = [];
  let cursor = 0;
  let dirty = true;
  let tree!: React.ReactElement;
  const dispatcher = {
    useContext: () => ({ locale, pending: false, setLocale: () => {} }),
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: unknown) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
        dirty = true;
      }];
    },
  };
  const render = () => {
    cursor = 0;
    dirty = false;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      tree = AmuxIdeaCardRegistrationPanel({ ideaId: "idea-12345", unit: UNIT }) as typeof tree;
    } finally {
      internals.H = previous;
    }
  };
  const flush = async () => {
    for (let turn = 0; turn < 32; turn += 1) {
      if (dirty) render();
      await Promise.resolve();
    }
    if (dirty) render();
  };
  render();
  return { flush, get tree() { return tree; },
    get duplicateIds() { return slots[4] as string[]; },
    get reason() { return slots[2] as string; } };
}

test("a consume-time Task refusal clears stale duplicate state and keeps the prepared confirmation recoverable", async (t: TestContext) => {
  let prepareCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/catalog?")) {
      return Response.json({ features: [{ ref: "feature-123", level: "feature",
        parentRef: "epic-1234", revision: 1, contentDigest: "a".repeat(64),
        state: "active" }] });
    }
    assert.equal(init?.method, "POST");
    if (url === "/api/admin/amux/ideas/unit-decisions/consume") {
      return Response.json({ error: "task_expected_paths_mixed",
        retryWrite: false }, { status: 409 });
    }
    assert.equal(url, "/api/admin/amux/ideas/unit-decisions/prepare");
    prepareCalls += 1;
    return prepareCalls === 1 ?
      Response.json({ error: "duplicate_reason_required",
        candidateIds: ["candidate-123"] }, { status: 409 }) :
      Response.json({ state: "prepared", decisionId: "decision-123",
        confirmationDigest: "c".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
        draftUnitId: UNIT.id, title: "Implement the guarded change", cardType: "task",
        storyKind: null, featureNodeId: "feature-123",
        duplicateCandidateIds: ["candidate-123"],
        taskCostReceipt: { ceilingMicroUsd: "1200", catalogVersion: "catalog-v1",
          pricingVersion: "pricing-v1", routes: [{ routeId: "route-1",
            workerName: "worker-1", provider: "provider-1", modelId: "model-1",
            perAttemptMicroUsd: "1200", routePolicyDigest: "d".repeat(64) }] },
        publicPrDisclosureApproved: false, backlogOnly: true,
        executionAuthorized: false, retryWrite: false, auditId: "audit-1234" });
  });

  const panel = mount("en");
  const click = async (label: string) => {
    const button = propsOf(panel.tree).find((props) =>
      typeof props.onClick === "function" && textOf(props.children as ReactNode).includes(label));
    assert.ok(button, `button ${label} must be rendered`);
    (button.onClick as () => void)();
    await panel.flush();
  };

  await click(adminAmuxIdeaInputMessages.en.resolutionLoad);
  const select = propsOf(panel.tree).find((props) => typeof props.onChange === "function" &&
    props.value === "");
  assert.ok(select, "feature selector must be rendered");
  (select.onChange as (event: { target: { value: string } }) => void)(
    { target: { value: "feature-123" } },
  );
  await panel.flush();
  await click(adminAmuxIdeaInputMessages.en.taskRegistrationPrepare);
  assert.match(textOf(panel.tree), /candidate-123/);

  const textarea = propsOf(panel.tree).find((props) =>
    typeof props.onChange === "function" && props.maxLength === 500);
  assert.ok(textarea, "duplicate reason input must be rendered");
  (textarea.onChange as (event: { target: { value: string } }) => void)(
    { target: { value: "Distinct scope" } },
  );
  await panel.flush();
  await click(adminAmuxIdeaInputMessages.en.taskRegistrationPrepare);
  assert.match(textOf(panel.tree), /decision-123/);
  assert.deepEqual(panel.duplicateIds, ["candidate-123"]);
  assert.equal(panel.reason, "Distinct scope");
  await click(adminAmuxIdeaInputMessages.en.taskRegistrationConsume);

  const text = textOf(panel.tree);
  assert.match(text, /decision-123/, "the refused confirmation remains available to cancel or read back");
  assert.doesNotMatch(text, /task_expected_paths_mixed/);
  assert.match(text, /Split it into dependent Tasks by path class/);
  assert.deepEqual(panel.duplicateIds, []);
  assert.equal(panel.reason, "");
});
