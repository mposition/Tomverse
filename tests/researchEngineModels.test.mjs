import assert from "node:assert/strict";
import { test } from "node:test";
import { RESEARCH_ENGINE_MODEL_SHORTLIST, researchEngineModelIsShortlisted, researchRoleModelIds } from "../lib/researchEngineService.ts";

test("engine v2 offers the Preview pair plus the checked frontier models, each pinned to one API id", () => {
  assert.deepEqual(RESEARCH_ENGINE_MODEL_SHORTLIST.map((entry) => entry.id),
    ["gemini-3-1-pro", "gemini-4-argon", "gemini-4-carbon", "gpt-6-2-sol", "claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.ok(researchEngineModelIsShortlisted({ id: "gpt-6-2-sol", provider: "openai", apiModel: "gpt-6.2-sol" }));
  assert.ok(!researchEngineModelIsShortlisted({ id: "gpt-6-2-sol", provider: "openai", apiModel: "gpt-6.3-sol" }), "a changed API id is not the checked model");
  assert.ok(!researchEngineModelIsShortlisted({ id: "gpt-6-2-astra", provider: "openai", apiModel: "gpt-6.2-astra" }));
});

test("roles take operator overrides among the allowed models and default to the first allowed one", () => {
  const roles = researchRoleModelIds({
    RESEARCH_ENGINE_MODEL_IDS: "gemini-4-carbon, claude-opus-5-5, gpt-6-2-sol",
    RESEARCH_ENGINE_ROLE_MODELS: "writer=claude-opus-5-5,verifier=gpt-6-2-sol,researcher=gpt-6-2-astra",
  });
  assert.deepEqual(roles, { planner: "gemini-4-carbon", researcher: "gemini-4-carbon", analyst: "gemini-4-carbon",
    coordinator: "gemini-4-carbon", verifier: "gpt-6-2-sol", writer: "claude-opus-5-5" });
});

test("a model id the code does not list cannot be enabled by a flag", () => {
  assert.equal(researchRoleModelIds({ RESEARCH_ENGINE_MODEL_IDS: "gpt-6-2-astra,grok-4-7" }), null);
});
