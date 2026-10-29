import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "../../.tmp/native-image-progress");
mkdirSync(output, { recursive: true });
test.use({ video: "on" });

async function imageReply(page: Page, { theme = "dark", quality = "medium", preset = "standard", ready = false } = {}) {
  await page.addInitScript(({ theme, ready }) => {
    localStorage.setItem("tomverse-language", "ko");
    localStorage.setItem("tomverse-theme", theme);
    (window as unknown as { imageFixtureReady: boolean }).imageFixtureReady = ready;
  }, { theme, ready });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("https://fixture.invalid/image.svg", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640" viewBox="0 0 1024 640"><rect width="1024" height="640" fill="#eaf1ff"/><circle cx="760" cy="170" r="65" fill="#b9d4ff"/><path d="M0 640V500L320 200 550 440 760 300 1024 540V640" fill="#2563eb"/><text x="60" y="92" fill="#16243b" font-family="sans-serif" font-size="30">Synthetic image preview</text></svg>',
  }));
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const injection = `const originalLoad=transport.load;
      transport.load=async id=>{const c=await originalLoad(id);return {...c,messages:c.messages.map(m=>m.role==='assistant'?{...m,content:'[Image generated] Synthetic image',imageTurn:{groupId:'synthetic-image-group',modelIds:['synthetic-image-model']}}:m)};};
      window.paidImageRuns=0;transport.generateImages=async()=>{window.paidImageRuns++;throw Error('Unexpected generation');};
      transport.imageGroup=async()=>({status:window.imageFixtureReady?'succeeded':'processing',targets:[{targetId:'target',modelId:'synthetic-image-model',currentGenerationId:'generation'}],generations:[{generationId:'generation',status:window.imageFixtureReady?'succeeded':'processing',prompt:'Synthetic image preview',quality:${JSON.stringify(quality)},preset:${JSON.stringify(preset)},assets:window.imageFixtureReady?[{role:'original',url:'https://fixture.invalid/image.svg',urlExpiresAt:'2099-01-01T00:00:00Z'}]:[]}]});`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByRole("textbox").fill("Create a synthetic event image");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
}

for (const theme of ["light", "dark"]) {
  test(`${theme} image reply animates while generating then explains standard quality`, async ({ page }) => {
    await imageReply(page, { theme });
    const progress = page.getByTestId("native-image-progress");
    await expect(progress).toContainText("이미지를 만들고 있어요");
    await expect(progress).toContainText("완성되면 이 답변에 이미지가 표시됩니다");
    await expect(progress.getByRole("button")).toHaveCount(0);
    expect(await progress.evaluate(node => getComputedStyle(node, "::before").animationName)).toBe("native-image-sweep");
    await page.screenshot({ path: resolve(output, `generating-${theme}.png`) });
    await page.evaluate(() => { (window as unknown as { imageFixtureReady: boolean }).imageFixtureReady = true; });
    const image = page.getByRole("img", { name: "Synthetic image preview", exact: true });
    await expect(image).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(progress).toHaveCount(0);
    const quality = page.getByTestId("native-image-quality");
    await expect(quality).toContainText("표준 품질");
    await expect(quality).toContainText("이 이미지를 고품질로 다시 만들어 줘");
    await expect(quality).toContainText("다시 생성하면 크레딧이 사용되며");
    expect(await page.evaluate(() => (window as unknown as { paidImageRuns: number }).paidImageRuns)).toBe(0);
    await page.screenshot({ path: resolve(output, `standard-${theme}.png`) });
  });
}

test("reduced motion keeps the generation status while stopping decorative animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await imageReply(page);
  const progress = page.getByTestId("native-image-progress");
  await expect(progress).toBeVisible();
  expect(await progress.evaluate(node => getComputedStyle(node, "::before").animationName)).toBe("none");
  expect(await progress.locator("i").first().evaluate(node => getComputedStyle(node).animationName)).toBe("none");
});

test("actual high quality overrides a conflicting preset and does not show a standard-quality upsell", async ({ page }) => {
  await imageReply(page, { ready: true, quality: "high", preset: "standard" });
  const quality = page.getByTestId("native-image-quality");
  await expect(quality).toHaveText("고품질");
  await expect(page.getByText(/더 선명한 결과가 필요하면/)).toHaveCount(0);
  await expect(page.getByTestId("native-image-progress")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { paidImageRuns: number }).paidImageRuns)).toBe(0);
});

test("an unknown actual quality is not described as standard", async ({ page }) => {
  await imageReply(page, { ready: true, quality: "unrecognised", preset: "standard" });
  await expect(page.getByRole("img", { name: "Synthetic image preview", exact: true })).toBeVisible();
  await expect(page.getByTestId("native-image-quality")).toHaveCount(0);
});
