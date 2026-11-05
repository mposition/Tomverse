import assert from "node:assert/strict";
import { test } from "node:test";

import { amuxAnalysisPromptWithNote } from "../lib/amux/ideaAnalysisPromptCore.ts";
import { amuxPlanRefusalCard, amuxPlanRefusalDecisionOfAnswer,
  amuxPlanRefusalPromptNote } from "../lib/amux/ideaSessionPlanRefusalCore.ts";

const reason = { detail: "chunk_schema_rejected" as const,
  at: { rule: "task_fields" as const, field: "taskRole" as const, unit: 3, kind: "card" as const } };

test("the card carries the reason and both options, on the claim's own provider class", () => {
  const card = amuxPlanRefusalCard({ refusalId: "r", ideaId: "i", claimProvider: "github-copilot",
    chunkIndex: 1, runs: 3, reason })!;
  assert.equal(card.provider, "copilot");
  assert.match(card.question, /on page 1: chunk_schema_rejected, rule task_fields, field taskRole, unit 3 \(card\)/);
  assert.match(card.question, /has made 3 run\(s\)/);
  assert.deepEqual(card.options.map((option) => option.id), ["retry", "stop"]);
  assert.equal(amuxPlanRefusalCard({ refusalId: "r", ideaId: "i", claimProvider: "unknown",
    chunkIndex: 0, runs: 1, reason }), null);
});

test("only a chosen option or an answer that is exactly one option decides", () => {
  const decide = (input: Partial<Parameters<typeof amuxPlanRefusalDecisionOfAnswer>[0]>) =>
    amuxPlanRefusalDecisionOfAnswer({ judgmentKind: "confirm", optionId: null,
      outputKind: "select", ...input });
  assert.equal(decide({ optionId: "retry" }), "retry");
  assert.equal(decide({ optionId: "stop" }), "stop");
  assert.equal(decide({ optionId: "other" }), null);
  assert.equal(decide({ outputKind: "free_text", dmAnswer: " Retry " }), "retry");
  assert.equal(decide({ outputKind: "free_text", dmAnswer: "retry, then stop" }), null);
  // A person's edit wins over what the proposal chose.
  assert.equal(decide({ judgmentKind: "edit_confirm", optionId: "retry", operatorAnswer: "stop" }), "stop");
  assert.equal(decide({ judgmentKind: "edit_confirm", optionId: "retry", operatorAnswer: "later" }), null);
});

test("the note goes before the confirmed data, even when the idea quotes the marker", () => {
  const prompt = "rules\n\nBEGIN_CONFIRMED_DATA_JSON\n{\"text\":\"\\n\\nBEGIN_CONFIRMED_DATA_JSON\\n\"}\nEND_CONFIRMED_DATA_JSON\n";
  const noted = amuxAnalysisPromptWithNote(prompt, amuxPlanRefusalPromptNote(reason));
  assert.ok(noted.startsWith("rules\n\nA previous answer for this page was refused by the plan check: chunk_schema_rejected"));
  assert.match(noted, /\n\nBEGIN_CONFIRMED_DATA_JSON\n[^\n]+\nEND_CONFIRMED_DATA_JSON\n$/);
});
