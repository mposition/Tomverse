import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { workspaceWelcomeCopy } from "../../locales/workspaceWelcome";

test.beforeEach(async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const fixture = `const baseCapability=transport.mobileCapabilities;transport.mobileCapabilities=async()=>({...await baseCapability(),images:{enabled:true,maxModels:3,models:[{id:'fixture-image',name:'Fixture image',provider:'openai',pricingVersion:'v1',prices:[]}]}});transport.voiceConfiguration=async()=>({enabled:true,maxSeconds:900});transport.voiceRequest=async()=>Response.json({code:'QA_CALLS_DISABLED'},{status:503});transport.sendVoice=async()=>{throw Error('No paid calls in visual QA');};`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
});
for (const theme of ["light", "dark"]) test(`native welcome screens share web copy and starter prompts in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => { localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", theme); }, theme);
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByRole("heading", { name: "다시 만나 반가워요. 무엇을 도와드릴까요?" })).toBeVisible();
  await expect(page.locator(".welcome-card-grid .welcome-card")).toHaveCount(6);
  await page.screenshot({ path: resolve(process.cwd(), `../../.tmp/native-parity/chat-welcome-${theme}.png`) });
  await page.getByRole("button", { name: "출처 링크 붙은 답 받기", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue(workspaceWelcomeCopy.ko.starter.cards.sourcedAnswer.seed);
  await page.getByRole("button", { name: "세 모델 답 나란히 비교", exact: true }).click();
  await expect(page.getByTestId("product-switcher")).toHaveValue("review");
  await expect(page.getByRole("textbox")).toHaveValue(workspaceWelcomeCopy.ko.starter.cards.compareAnswers.seed);
  await expect(page.getByRole("heading", { name: "질문은 한 번. 관점은 세 가지." })).toBeVisible();
  await expect(page.getByRole("button", { name: "한 문장으로, 여러 이미지.", exact: true })).toBeVisible();
  await page.getByRole("textbox").fill("");
  await page.screenshot({ path: resolve(process.cwd(), `../../.tmp/native-parity/review-welcome-${theme}.png`) });
  await page.getByRole("button", { name: "같은 자료, 다른 해석.", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue(workspaceWelcomeCopy.ko.starter.cards.documentQuestions.seed);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]").length)).toBe(0);
  await expect(page.locator("article.user")).toHaveCount(0);
});
