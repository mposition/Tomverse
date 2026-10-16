import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaRegistrationRefusalNotice } from
  "@/components/admin/AmuxIdeaRegistrationRefusalNotice";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

const refusal = {
  state: "awaiting_operator" as const,
  requestId: "11111111-2222-4333-8444-555555555555",
  attemptKind: "whole_plan" as const,
  refusalCode: "task_expected_paths_mixed" as const,
  draftUnitId: "unit-01",
  analysisPreviewId: "preview-01",
  sourcePlanRevisionId: "plan-01",
  proposedExecutionGrade: "routine" as const,
  finalExecutionGrade: null,
  attemptedAt: "2026-10-16T06:00:00.000Z",
};

test("durable Task refusal renders actionable metadata without paths or raw code", () => {
  for (const locale of ["en", "ko"] as const) {
    const m = adminAmuxIdeaInputMessages[locale];
    const html = renderToStaticMarkup(
      <AmuxIdeaRegistrationRefusalNotice m={m} refusal={refusal} />,
    );
    assert.match(html, /data-testid="amux-registration-refusal"/);
    for (const value of [refusal.requestId, refusal.draftUnitId,
      refusal.analysisPreviewId, refusal.sourcePlanRevisionId,
      refusal.proposedExecutionGrade]) assert.ok(html.includes(value));
    assert.ok(html.includes(m.registrationRefusalTitle));
    assert.ok(html.includes(m.taskRegistrationMixedPathsRefused));
    assert.equal(html.includes(refusal.refusalCode), false);
    assert.equal(html.includes("expectedPaths"), false);
    assert.equal(html.includes("lib/amux/private.ts"), false);
  }
});
