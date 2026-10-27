import { expect, test } from "@playwright/test";
import { selectProduct } from "./workspaceNavigation";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "../../.tmp/native-model-selection");
mkdirSync(output, { recursive: true });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "light"); });
  await page.route("https://tomverse.app/**", route => route.abort());
});

test("manual Chat selection survives provider filters and empty search without submitting a message", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByRole("textbox").fill("Keep my Chat draft");
  await page.getByRole("button", { name: "Smart Adaptive", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "모델 선택" });
  await sheet.getByRole("switch").uncheck();
  await sheet.getByRole("radio", { name: "Local demo B", exact: true }).check();
  await sheet.getByRole("button", { name: "Synthetic A", exact: true }).click();
  await expect(sheet.getByRole("radio")).toHaveCount(1);
  await sheet.getByRole("searchbox").fill("missing");
  await expect(sheet.getByRole("radio")).toHaveCount(0);
  await expect(sheet.locator(".selection-summary")).toContainText("Local demo B");
  await sheet.getByRole("button", { name: "선택 적용", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("Keep my Chat draft");
  await expect(page.locator("article.user")).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]);
  expect(saved.selectedModels).toEqual(["demo-b"]); expect(saved.selectionMode).toBe("manual");
});

test("Review provider and model limits stay intact through filtering and Done", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", "const oldCapabilities=transport.mobileCapabilities;transport.mobileCapabilities=async()=>({...await oldCapabilities(),maxModels:2});createRoot(container).render(") });
  });
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await selectProduct(page, "review"); await page.getByRole("textbox").fill("Keep my Review draft");
  await page.getByRole("button", { name: /참여 모델 선택/ }).click();
  const sheet = page.getByRole("dialog", { name: "비교할 AI 선택" });
  await expect(sheet.getByRole("checkbox", { name: "Synthetic C", exact: true })).toBeDisabled();
  await sheet.getByRole("checkbox", { name: "Synthetic A", exact: true }).uncheck();
  await sheet.getByRole("checkbox", { name: "Synthetic C", exact: true }).check();
  await expect(sheet.locator(".selection-summary")).toContainText("2개 선택");
  await sheet.getByRole("button", { name: "Professional", exact: true }).click();
  await expect(sheet.getByRole("checkbox", { name: "Local demo C", exact: true })).toBeDisabled();
  await sheet.getByRole("searchbox").fill("C");
  await expect(sheet.locator(".selection-summary")).toContainText("Local demo A");
  await sheet.getByRole("button", { name: "완료", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Keep my Review draft");
  await expect(page.locator("article.user")).toHaveCount(0);
});

for (const theme of ["light", "dark"]) test(`selection sheets stay readable with fixed footer and larger text in ${theme}`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem("tomverse-theme", value), theme);
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByRole("button", { name: "Smart Adaptive", exact: true }).click();
  await page.getByRole("dialog").getByRole("switch").uncheck();
  await page.getByRole("radio").first().check();
  await page.screenshot({ path: resolve(output, `chat-${theme}.png`) });
  for (const [width, height] of [[320, 460], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const size of ["100%", "200%"]) {
      await page.evaluate(value => { document.documentElement.style.fontSize = value; }, size);
      const sheet = page.getByRole("dialog");
      expect(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await expect(sheet.getByRole("button", { name: "선택 적용", exact: true })).toBeInViewport();
      await expect(sheet.getByRole("button", { name: "닫기", exact: true })).toBeInViewport();
    }
  }
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  await selectProduct(page, "review"); await page.getByRole("button", { name: /참여 모델 선택/ }).click();
  await page.screenshot({ path: resolve(output, `easy-${theme}.png`) });
  await page.getByRole("button", { name: "Professional", exact: true }).click();
  await page.screenshot({ path: resolve(output, `professional-${theme}.png`) });
});

for (const theme of ["light", "dark"]) test(`selected design reference states render with bundled provider assets in ${theme}`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(value => localStorage.setItem("tomverse-theme", value), theme);
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const fixture = `
      transport.models=async()=>[
        {id:"demo",name:"GPT-5.6 Sol",provider:"openai",minimumPlan:"Pro"},
        {id:"demo-b",name:"GPT-5.6 Terra",provider:"openai",minimumPlan:"Free"},
        {id:"demo-c",name:"GPT-5.6 Luna",provider:"openai",minimumPlan:"Guest"},
        {id:"demo-d",name:"GPT 6 Luna",provider:"openai",minimumPlan:"Guest"},
        {id:"demo-anthropic",name:"Synthetic Anthropic model",provider:"anthropic",minimumPlan:"Free"},
        {id:"demo-google",name:"Synthetic Google model",provider:"google",minimumPlan:"Free"}
      ];
      const originalPreferences=transport.preferences;
      transport.preferences=async()=>({...await originalPreferences(),reviewEasyEffectiveProviders:["openai","anthropic"],reviewEasyProviderOptions:["openai","anthropic","google"]});
    `;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByRole("button", { name: "Smart Adaptive", exact: true }).click();
  await page.getByRole("dialog").getByRole("switch").uncheck();
  await page.getByRole("radio", { name: "GPT-5.6 Luna", exact: true }).check();
  await page.screenshot({ path: resolve(output, `reference-chat-${theme}.png`) });
  await page.keyboard.press("Escape"); await selectProduct(page, "review");
  await page.getByRole("button", { name: /참여 모델 선택/ }).click();
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "Anthropic", exact: true })).toBeChecked();
  const logoState = await page.locator(".selection-providers .provider-mark img").evaluateAll(images => images.map(image => ({ loaded: (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0, width: image.getBoundingClientRect().width })));
  expect(logoState).toHaveLength(3); expect(logoState.every(image => image.loaded && image.width > 0)).toBe(true);
  await page.screenshot({ path: resolve(output, `reference-easy-${theme}.png`) });
  await page.getByRole("button", { name: "Professional", exact: true }).click();
  await page.screenshot({ path: resolve(output, `reference-professional-${theme}.png`) });
  expect(errors).toEqual([]);
});
