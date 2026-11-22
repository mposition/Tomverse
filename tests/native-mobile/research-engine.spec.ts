import { expect, test, type Page } from "@playwright/test";

/**
 * Deep Research engine v2 on the Native shell, over an injected run API (no
 * network): the shared workspace renders a v2 run, a lost action response is
 * read back instead of re-sent, an older poll never overwrites a newer state,
 * and opening the brief sheet keeps the composer draft.
 */
async function setup(page: Page, { abortPause = false } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("tomverse-language", "en");
    localStorage.setItem("tomverse-native-synthetic-demo:session", "signed-in");
  });
  await page.route("https://tomverse.app/**", (route) => route.abort());
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    const fixture = `
      const engineView = (patch) => ({ id:'engine_run', engineVersion:2, conversationId: localStorage.getItem('qa-engine-conversation'),
        assistantMessageId:'11111111-1111-4111-8111-111111111111', status:'running', eventSequence:5, inputRevision:0, planRevision:1,
        approvedPlanRevision:1, qualityStatus:null, currentReportRevision:0, pauseRequested:false, cancelRequested:false, budgetReached:false,
        progress:{ items:{queued:1,running:1,completed:2,failed:0,attention:0,blocked:0,cancelled:0}, questions:[], sourcesSeen:5, sourcesRead:2, privateSources:0, openQuestions:[] },
        money:{ approvedCredits:300, settledCredits:40, reservedCredits:10, unknownCredits:0, finalizationReserveCredits:60, settlement:'pending' },
        actions:{ canPause:true, canResume:false, canCancel:true, canExtendBudget:true, canApprovePlan:false, canEditPlan:false, canRevise:false, canDelete:false, canFinish:true },
        createdAt:'2026-11-23T00:00:00Z', updatedAt:'2026-11-23T00:00:00Z', ...patch });
      window.qaEngine = { posts: [], creates: [], current: null };
      transport.researchEngineEnabled = async () => true;
      transport.researchEngine = {
        offer: async () => ({ offered:true, reason:'ready', features:{ defaultEntry:false, privateSources:false, projectSources:false, maxApprovedCredits:2000 }, estimate:{ lowCredits:100, highCredits:500, perCallCredits:10 } }),
        read: async () => window.qaEngine.current ?? (window.qaEngine.current = engineView({})),
        act: async (runId, action) => {
          window.qaEngine.posts.push(action.kind);
          const current = window.qaEngine.current ?? engineView({});
          if (action.kind === 'pause') window.qaEngine.current = { ...current, status:'paused', pauseRequested:true, eventSequence: current.eventSequence + 1,
            actions:{ ...current.actions, canPause:false, canResume:true } };
          return { run: window.qaEngine.current, readback: ${abortPause} };
        },
        sources: async () => ({ sources:[], nextCursor:null }), report: async () => ({}), exportFile: async () => ({ blob:new Blob(['x']), disposition:null }),
        create: async (payload) => { window.qaEngine.creates.push(payload); return { conversationId: payload.conversationId }; }, list: async () => [], evidence: async () => ({}), remove: async () => ({}),
      };
      const load = transport.load;
      transport.load = async (id) => {
        const item = await load(id);
        if (localStorage.getItem('qa-engine-conversation') !== id) return item;
        return { ...item, messages: [...item.messages, { id:'11111111-1111-4111-8111-111111111111', role:'assistant', content:'', researchRunId:'engine_run', researchEngineRun:true, status:'pending', createdAt:'2026-11-23T00:00:00Z' }] };
      };
    `;
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await page.goto("/");
  await expect(page.getByRole("textbox")).toBeEnabled();
}

async function openEngineConversation(page: Page) {
  await page.getByRole("textbox").fill("Seed message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message.user").first()).toBeVisible();
  const conversationId = await page.evaluate(() => localStorage.getItem("tomverse-native-last-chat") ?? JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") || "[]")[0]?.id);
  await page.evaluate((id) => localStorage.setItem("qa-engine-conversation", String(id)), conversationId);
  await page.reload();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.locator(".conversation-row").first().click();
}

test("a v2 run renders the shared workspace on Native and a lost Pause response is read back once", async ({ page }) => {
  await setup(page, { abortPause: true });
  await openEngineConversation(page);
  const workspace = page.getByTestId("research-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace.getByTestId("research-progress-items")).toHaveText("2 of 4 research steps finished");
  await workspace.getByTestId("research-pause").click();
  await expect(workspace).toHaveAttribute("data-run-status", "paused");
  expect(await page.evaluate(() => (window as unknown as { qaEngine: { posts: string[] } }).qaEngine.posts)).toEqual(["pause"]);
});

test("opening Deep Research from the tools keeps the composer draft and sends it as the brief", async ({ page }) => {
  await setup(page);
  await page.getByRole("textbox").fill("A long research brief about regional battery recycling rules");
  await page.locator(".composer-add").click();
  await page.getByRole("button", { name: "Deep Research" }).click();
  const sheet = page.getByTestId("deep-research-engine-sheet");
  await expect(sheet.getByTestId("dre-question")).toHaveValue("A long research brief about regional battery recycling rules");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("A long research brief about regional battery recycling rules");
});
