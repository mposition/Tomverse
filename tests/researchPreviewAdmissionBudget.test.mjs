import assert from "node:assert/strict";
import test from "node:test";

import { validateChatPayload } from "../lib/chatSecurity.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import {
  decideResearchPreviewAdmission,
  researchPreviewGate,
} from "../lib/researchPreviewAdmission.ts";
import {
  createResearchPreviewBudget,
  RESEARCH_PREVIEW_EVIDENCE_INPUT_TOKENS,
  RESEARCH_PREVIEW_REPORT_TOOL_INPUT_TOKENS,
} from "../lib/researchPreviewBudget.ts";
import { researchPreviewInputEstimate } from "../lib/researchPreviewPrompt.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";
import { reserveTurnSearchCost } from "../lib/webSearchNativeCostReservation.ts";

const model = AVAILABLE_MODELS.find((candidate) => candidate.id === "gemini-3-1-pro");
assert.ok(model);

const uuid = (suffix) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const request = (extra = {}) => ({
  messages: [{ id: uuid("1"), role: "user", content: "Compare public evidence." }],
  modelId: model.id,
  conversationId: "research-conversation",
  assistantMessageId: uuid("2"),
  sourceUserMessageId: uuid("1"),
  webSearchMode: "always",
  researchMode: "preview",
  ...extra,
});

test("Research request validation isolates one saved attachment-free question", () => {
  assert.equal(validateChatPayload(request()).researchMode, "preview");
  for (const payload of [
    request({ messages: [request().messages[0], { role: "assistant", content: "history" }] }),
    request({ messages: [{ role: "user", content: "question", attachments: [{ attachmentId: "private" }] }] }),
    request({ contextBundle: "private-context" }),
    request({ currentLocation: { latitude: 1, longitude: 1 } }),
    request({ webSearchMode: "auto" }),
  ]) {
    assert.throws(
      () => validateChatPayload(payload),
      (error) => error?.code === "INVALID_RESEARCH_PREVIEW_REQUEST"
    );
  }
});

const readyInput = () => ({
  signedIn: true,
  plan: "Pro",
  conversationAvailable: true,
  conversationLocked: false,
  productKey: "chat",
  kind: "chat",
  selectionMode: "manual",
  selectedModelIds: [model.id],
  model,
  backendReadiness: { brave: true },
  profileTools: null,
  gateEnabled: researchPreviewGate(model, {
    RESEARCH_PREVIEW_ENABLED: "true",
    RESEARCH_PREVIEW_MODEL_IDS: model.id,
  }),
  modelOutputTokenCap: resolveModelPricing(model).maxOutputTokens,
});

test("shared admission is default-off and requires manual one-model/profile permission", () => {
  assert.equal(researchPreviewGate(model, {}), false);
  assert.deepEqual(decideResearchPreviewAdmission(readyInput()), {
    offered: true,
    reason: "ready",
    limits: {
      questionCharacters: 4000,
      modelSteps: 3,
      searchAttempts: 5,
      totalOutputTokens: 4096,
    },
  });
  assert.equal(
    decideResearchPreviewAdmission({ ...readyInput(), selectionMode: "auto" }).reason,
    "manual_single_model_required"
  );
  assert.equal(
    decideResearchPreviewAdmission({
      ...readyInput(),
      profileTools: { webSearch: true, deepResearch: false },
    }).reason,
    "profile_restricted"
  );
});

test("one budget reserves three prompt passes, prior output, schema and worst-case evidence", () => {
  const capability = getWebSearchCapability(model);
  const searchReservation = reserveTurnSearchCost({
    model,
    capability,
    nativeSearchEnabled: false,
    appManagedSearchEnabled: true,
  });
  assert.equal(searchReservation.ok, true);
  if (!searchReservation.ok) return;
  const budget = createResearchPreviewBudget({
    accessKind: "user",
    model,
    input: researchPreviewInputEstimate({
      question: "Compare public evidence.",
      locale: "en",
      currentDate: "2026-11-15",
    }),
    webSearchSurchargeCredits: 0,
    searchReservation,
  });
  assert.equal(budget.maxOutputTokens, 4096);
  assert.equal(budget.reservedOutputTokens, 4096);
  assert.ok(
    budget.contextInputTokens >=
      RESEARCH_PREVIEW_EVIDENCE_INPUT_TOKENS +
        RESEARCH_PREVIEW_REPORT_TOOL_INPUT_TOKENS
  );
  assert.equal(
    budget.inputTokens,
    budget.contextInputTokens * 3 + budget.maxOutputTokens * 2
  );
  assert.ok(RESEARCH_PREVIEW_EVIDENCE_INPUT_TOKENS >= 202_000);
});
