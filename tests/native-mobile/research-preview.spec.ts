import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("tomverse-language", "en");
    localStorage.setItem("tomverse-native-synthetic-demo:session", "signed-in");
  });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const fixture = `
      transport.capabilities = async () => ({offered:false});
      const preferences = transport.preferences;
      transport.preferences = async () => ({...await preferences(),defaultModel:'gemini-3-1-pro'});
      const create = transport.create;
      transport.create = async (...args) => {
        const item = {...await create(...args),selectedModels:['gemini-3-1-pro'],selectionMode:'manual'};
        const rows=JSON.parse(localStorage.getItem('tomverse-native-synthetic-demo')||'[]');
        localStorage.setItem('tomverse-native-synthetic-demo',JSON.stringify(rows.map(row=>row.id===item.id?item:row))); return item;
      };
      transport.researchPreviewOffer = async input => ({offered:true,reason:'ready',estimatedCredits:24,features:{pageReading:true,durableRuns:true}});
      transport.sendResearchPreview = async (item,text,files,signal,progress,options) => {
        const assistantMessageId=crypto.randomUUID();
        const run={id:'native_run',conversationId:item.id,assistantMessageId,modelId:'gemini-3-1-pro',status:'checkpointed',canResume:true,stepCount:1,searchCount:1,readCount:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        localStorage.setItem('qa-research-run',JSON.stringify(run));
        localStorage.setItem('qa-research-starts',String(Number(localStorage.getItem('qa-research-starts')||0)+1));
        const rows=JSON.parse(localStorage.getItem('tomverse-native-synthetic-demo')||'[]');
        localStorage.setItem('tomverse-native-synthetic-demo',JSON.stringify(rows.map(row=>row.id===item.id?{...row,messages:[...row.messages,{id:crypto.randomUUID(),role:'user',content:text},{id:assistantMessageId,role:'assistant',content:'',researchRunId:run.id,modelId:run.modelId,status:'pending'}]}:row)));
      };
      transport.researchRuns={
        read: async () => JSON.parse(localStorage.getItem('qa-research-run')),
        resume: async () => {
          const run=JSON.parse(localStorage.getItem('qa-research-run'));
          const next={...run,status:'completed',canResume:false,stepCount:2,message:{id:run.assistantMessageId,role:'assistant',modelId:run.modelId,content:'Saved native research report.',status:'normal',createdAt:run.createdAt}};
          localStorage.setItem('qa-research-run',JSON.stringify(next));
          localStorage.setItem('qa-research-resumes',String(Number(localStorage.getItem('qa-research-resumes')||0)+1)); return next;
        },
        cancel: async () => { const run={...JSON.parse(localStorage.getItem('qa-research-run')),status:'cancelled',canResume:false};localStorage.setItem('qa-research-run',JSON.stringify(run));return run; },
      };
    `;
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await page.goto("/");
  await expect(page.getByRole("textbox")).toBeEnabled();
}

test("native first-question Research is one-shot and resume requires an explicit action", async ({ page }) => {
  await setup(page);
  await page.getByRole("textbox").fill("Compare public specifications.");
  await page.locator(".composer-add").click(); await page.getByTestId("native-tools-research-preview").click();
  await expect(page.getByTestId("native-research-preview-notice")).toContainText("gemini-3-1-pro");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "checkpointed");
  expect(await page.evaluate(() => localStorage.getItem("qa-research-starts"))).toBe("1");
  expect(await page.evaluate(() => localStorage.getItem("qa-research-resumes"))).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.locator(".conversation-row").first().click();
  await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "checkpointed");
  expect(await page.evaluate(() => localStorage.getItem("qa-research-starts"))).toBe("1");
  expect(await page.evaluate(() => localStorage.getItem("qa-research-resumes"))).toBeNull();
  await page.getByTestId("research-run-resume").click();
  await expect(page.getByText("Saved native research report.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("native-research-preview-notice")).toHaveCount(0);
  await page.getByRole("textbox").fill("Explain it more simply.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("article.assistant").last()).toContainText("local demo response");
  expect(await page.evaluate(() => localStorage.getItem("qa-research-starts"))).toBe("1");
});

test("native attached drafts are preserved when Research cannot be selected", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await setup(page);
  await page.getByRole("textbox").fill("Keep this public question draft.");
  await page.getByTestId("file-picker").setInputFiles({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("Private content") });
  await page.locator(".composer-add").click();
  await expect(page.getByTestId("native-tools-research-preview")).toBeDisabled();
  await expect(page.getByRole("textbox")).toHaveValue("Keep this public question draft.");
  await expect(page.getByRole("button", { name: "Remove attachment: private.txt" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("qa-research-starts"))).toBeNull();
});
