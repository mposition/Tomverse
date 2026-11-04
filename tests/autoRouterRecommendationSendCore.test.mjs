import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxIdeaSubmission, isAmuxIdeaRequestId } from "../lib/amux/ideaSubmissionCore.ts";
import { recommendationIdeaText, recommendationSendRequestId } from "../lib/autoRouterRecommendationSendCore.ts";
import {
  actionableRecommendations,
  isRecommendationSendable,
  nextClaimableRecommendation,
  openRecommendations,
  recommendationStatusEntries,
  withRecommendationStatus,
} from "../lib/autoRouterRecommendationsCore.ts";

const report = {
  findings: ["answer calls failed for two models"],
  recommendations: [
    { kind: "guidance", text: "GUIDANCE" },
    { kind: "code", text: "CODE-A" },
    { kind: "setting", text: "SETTING-B" },
  ],
};
const at = "2026-11-04T00:00:00.000Z";
const NOW = Date.parse("2026-11-04T01:00:00.000Z");
const sent = withRecommendationStatus({ report }, 1, { status: "sent_to_amux", at, by: "owner", amuxIdeaId: "idea-1" });

test("the request id is the same for the same recommendation, differs by place, and is one AMUX accepts", () => {
  const id = recommendationSendRequestId("cyc_1", 1);
  assert.equal(recommendationSendRequestId("cyc_1", 1), id);
  assert.notEqual(recommendationSendRequestId("cyc_1", 2), id);
  assert.notEqual(recommendationSendRequestId("cyc_2", 1), id);
  assert.ok(isAmuxIdeaRequestId(id));
});

test("the idea carries the recommendation, findings and cycle link, and passes AMUX's own inspection", () => {
  const idea = recommendationIdeaText({
    recommendation: { kind: "code", text: "CODE-A" },
    findings: report.findings,
    cycle: { id: "cyc_1", createdAt: at },
    origin: "https://tomverse.app",
  });
  for (const part of ["CODE-A", "answer calls failed for two models", "https://tomverse.app/admin/routing#optimizer-cycle-cyc_1"]) {
    assert.ok(idea.includes(part), part);
  }
  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({
      version: 1,
      requestId: recommendationSendRequestId("cyc_1", 1),
      input: { version: 1, idea, repositories: [], pullRequests: [] },
    })
  );
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
});

test("only an open recommendation or one the agent gave up on can be sent", () => {
  for (const status of ["open", "failed"]) assert.equal(isRecommendationSendable(status), true, status);
  for (const status of ["done", "dismissed", "claimed", "pr_opened", "needs_lookup", "sent_to_amux"]) {
    assert.equal(isRecommendationSendable(status), false, status);
  }
});

test("a sent recommendation keeps its idea, leaves the open list, and the coding agent does not take it", () => {
  assert.equal(recommendationStatusEntries(sent).get(1)?.amuxIdeaId, "idea-1");
  const item = actionableRecommendations(sent, NOW).find((entry) => entry.index === 1);
  assert.equal(item.status, "sent_to_amux");
  assert.equal(item.amuxIdeaId, "idea-1");

  const cycles = [{ id: "cyc_1", createdAt: at, summary: sent }];
  assert.deepEqual(openRecommendations(cycles, NOW).map((entry) => entry.index), [2]);
  assert.equal(nextClaimableRecommendation(cycles, NOW), null);
});
