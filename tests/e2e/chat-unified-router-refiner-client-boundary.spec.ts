import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";

type ClientBoundary = Pick<typeof import("../../components/chat/promptRefinerProductClient"),
  "parsePromptRefinerProductAutoPrepare" | "chatUnifiedRouterRefinerDecision" |
  "promptRefinerChatRequestDecisionFields" | "promptRefinerAuthoredPromptForSend" |
  "parsePromptRefinerExecutionHeaders" | "promptRefinerAllowsAutomaticChatRecovery">;
type BoundaryWindow = Window & { unifiedClientUnderTest: ClientBoundary };

// This test executes the real client module in Chromium, with no product flag,
// runtime release, server bypass or provider. The ChatInput spec covers the real
// mounted composer; this supplement covers browser JSON/Headers boundaries only.
const browserModule = buildSync({
  entryPoints: [resolve("components/chat/promptRefinerProductClient.ts")],
  bundle: true, write: false, platform: "browser", format: "iife",
  globalName: "unifiedClientUnderTest", tsconfig: resolve("tsconfig.json"),
}).outputFiles[0].text;

test.describe("Unified Router Refiner browser boundary", { tag: "@ui-risk" }, () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name),
      "The source-only boundary is exercised on desktop and mobile Chromium.");
    await page.route("**/*", route => route.abort());
    await page.setContent("<!doctype html><html><body><main>Isolated client boundary</main></body></html>");
    await page.addScriptTag({ content: browserModule });
  });

  test("profile-only and applied metadata retain authored bytes and one opaque authority", async ({ page }) => {
    const actual = await page.evaluate(() => {
      const api = (window as unknown as BoundaryWindow).unifiedClientUnderTest;
      const source = ' \n한국어 {"id":"001","literal":"`$()"} 😀\t';
      const scope = { scopeId: "00000000-0000-4000-8000-000000000011", epoch: 7 };
      const held = { outcome: "unified_held", resultId: "00000000-0000-4000-8000-000000000012",
        ...scope, draftRevision: 3, clientRequestId: "00000000-0000-4000-8000-000000000013" };
      const prepared = api.parsePromptRefinerProductAutoPrepare(JSON.parse(JSON.stringify(held)), scope, 3);
      if (prepared?.outcome !== "unified_held") throw new Error("prepare was rejected");
      const decision = api.chatUnifiedRouterRefinerDecision(prepared);
      return {
        prepared,
        fields: api.promptRefinerChatRequestDecisionFields(undefined, decision),
        authored: api.promptRefinerAuthoredPromptForSend({ rawPrompt: source,
          ordinaryPrompt: source.trim(), productTurn: true }),
        source,
        observations: ["original", "applied"].map(execution =>
          api.parsePromptRefinerExecutionHeaders(new Headers({
            "X-Prompt-Refiner-Execution": execution, "X-Prompt-Refiner-Mode": "auto",
          }))),
        replayAllowed: api.promptRefinerAllowsAutomaticChatRecovery(undefined, decision),
      };
    });
    expect(actual.authored).toBe(actual.source);
    expect(Object.keys(actual.fields!.chatUnifiedRouterRefinerDecision!).sort())
      .toEqual(["draftRevision", "epoch", "resultId", "scopeId"]);
    expect(JSON.stringify(actual.fields)).not.toMatch(/accepted|analysis|rewrite|modelId|sourceText/);
    expect(actual.observations).toEqual([
      { execution: "original", mode: "auto" }, { execution: "applied", mode: "auto" },
    ]);
    expect(actual.replayAllowed).toBe(false);
  });

  test("editing, scope ABA and content-bearing responses cannot reuse the held result", async ({ page }) => {
    const results = await page.evaluate(() => {
      const api = (window as unknown as BoundaryWindow).unifiedClientUnderTest;
      const scope = { scopeId: "00000000-0000-4000-8000-000000000011", epoch: 7 };
      const held = { outcome: "unified_held", resultId: "00000000-0000-4000-8000-000000000012",
        ...scope, draftRevision: 3, clientRequestId: "00000000-0000-4000-8000-000000000013" };
      return [
        api.parsePromptRefinerProductAutoPrepare(held, scope, 4),
        api.parsePromptRefinerProductAutoPrepare(held, { ...scope, epoch: 9 }, 3),
        api.parsePromptRefinerProductAutoPrepare(held,
          { ...scope, scopeId: "00000000-0000-4000-8000-000000000014" }, 3),
        ...["analysis", "rewrite", "refinedPrompt", "modelId"].map(key =>
          api.parsePromptRefinerProductAutoPrepare({ ...held, [key]: "forged" }, scope, 3)),
      ];
    });
    expect(results).toEqual(Array(7).fill(null));
  });

  test("manual/off and original fallback retain their separate send and recovery behavior", async ({ page }) => {
    const actual = await page.evaluate(() => {
      const api = (window as unknown as BoundaryWindow).unifiedClientUnderTest;
      const scope = { scopeId: "00000000-0000-4000-8000-000000000011", epoch: 7 };
      const unified = { resultId: "00000000-0000-4000-8000-000000000012", ...scope, draftRevision: 3 };
      const explicit = { suggestionId: "00000000-0000-4000-8000-000000000013",
        ...scope, decision: "accepted" as const };
      return {
        ordinaryFields: api.promptRefinerChatRequestDecisionFields(undefined, undefined),
        explicitFields: api.promptRefinerChatRequestDecisionFields(explicit, undefined),
        mixed: api.promptRefinerChatRequestDecisionFields(explicit, unified),
        injected: api.promptRefinerChatRequestDecisionFields(undefined,
          { ...unified, analysis: "forged" } as typeof unified),
        normalRecovery: api.promptRefinerAllowsAutomaticChatRecovery(undefined),
        explicitRecovery: api.promptRefinerAllowsAutomaticChatRecovery(explicit),
        fallback: api.parsePromptRefinerProductAutoPrepare({ outcome: "original_fallback",
          reason: "budget_exhausted" }, scope, 3),
        unknownHeaders: api.parsePromptRefinerExecutionHeaders(new Headers({
          "X-Prompt-Refiner-Execution": "accepted", "X-Prompt-Refiner-Mode": "auto",
        })),
      };
    });
    expect(actual.ordinaryFields).toEqual({});
    expect(actual.explicitFields).toHaveProperty("promptRefinerDecision.decision", "accepted");
    expect(actual.mixed).toBeNull();
    expect(actual.injected).toBeNull();
    expect(actual.normalRecovery).toBe(true);
    expect(actual.explicitRecovery).toBe(false);
    expect(actual.fallback).toEqual({ outcome: "original_fallback", reason: "budget_exhausted" });
    expect(actual.unknownHeaders).toBeNull();
  });
});
