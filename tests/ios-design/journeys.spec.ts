import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속", exact: true }).click();
  await expect(page.getByTestId("workspace-start")).toHaveAttribute("data-product", "chat");
});

test("welcome keeps its import and assistant entries above the composer", async ({ page }) => {
  const welcome = page.getByTestId("workspace-start");
  await expect(welcome.getByRole("button", { name: "다른 AI의 대화 이어가기 ChatGPT · Claude · Gemini", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(welcome.getByRole("button", { name: "내 어시스턴트", exact: true })).toBeInViewport({ ratio: 1 });
  const text = await page.getByRole("textbox").boundingBox();
  const tools = await page.locator(".composer-toolbar").boundingBox();
  expect(text).not.toBeNull();
  expect(tools).not.toBeNull();
  expect(text!.y + text!.height).toBeLessThanOrEqual(tools!.y + 1);
});

for (const product of ["Chat", "Review"] as const) {
  test(`assistant setup keeps its ${product} origin through saving and knowledge files`, async ({ page }, info) => {
    if (product === "Review") await page.locator(".workspace-navigation").getByRole("button", { name: "Review", exact: true }).click();
    if (product === "Chat") await page.getByTestId("workspace-start").getByRole("button", { name: "내 어시스턴트", exact: true }).click();
    else {
      await page.locator(".composer-add").click();
      await page.getByRole("dialog").getByRole("button", { name: "내 어시스턴트", exact: true }).click();
    }
    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("ios-assistant-origin")).toContainText(product);
    await dialog.getByRole("button", { name: "어시스턴트 만들기", exact: true }).click();
    await dialog.getByLabel("이름", { exact: true }).fill(`${product} guide`);
    await dialog.getByLabel("어떻게 도와주면 좋을까요?", { exact: true }).fill("Explain my documents in plain language.");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog.getByRole("button", { name: `${product}에서 시작`, exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "파일·모델·도구·기억 설정", exact: true }).click();
    await dialog.locator("summary").click();
    await expect(dialog.getByLabel("웹 검색 허용", { exact: true })).not.toBeChecked();
    await expect(dialog.getByLabel("계정 기억 사용", { exact: true })).not.toBeChecked();
    await dialog.getByLabel("참고 파일 추가", { exact: true }).setInputFiles({ name: "launch.txt", mimeType: "text/plain", buffer: Buffer.from("Interview twenty people before launch.") });
    await expect(dialog.getByText("준비됨 · 저장할 설정에 포함", { exact: true })).toBeVisible();
    await dialog.locator('.ios-knowledge input[type="checkbox"]').check();
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await dialog.getByRole("button", { name: `${product}에서 시작`, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".workspace-navigation").getByRole("button", { name: product, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("textbox")).toBeEnabled();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]"));
    expect(saved).toHaveLength(1);
    expect(saved[0].surface).toBe(product === "Chat" ? "chat" : "workspace");
    expect(saved[0].assistantProfileId).toBeTruthy();
    expect(saved[0].messages).toHaveLength(0);
    const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo:assistants") ?? "[]"));
    expect(profiles.find((row: { name: string }) => row.name === `${product} guide`).currentVersion.knowledgeManifest).toHaveLength(1);
    await page.screenshot({ path: info.outputPath(`assistant-${product}.png`) });
    if (product === "Review") {
      await page.locator(".header-new-chat").click();
      await expect(page.getByTestId("ios-active-assistant")).toHaveCount(0);
      await page.locator(".composer-add").click();
      await page.getByRole("dialog").getByRole("button", { name: "내 어시스턴트", exact: true }).click();
      await page.locator(".ios-assistant-row").filter({ hasText: "Review guide" }).getByRole("button", { name: "Review에서 시작", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("ios-active-assistant")).toHaveText("Review guide");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]"))).toHaveLength(2);
    }
  });
}

test("starter seeds a draft without creating or sending a conversation", async ({ page }) => {
  await page.getByTestId("ios-starter-document").click();
  await expect(page.getByRole("textbox")).toHaveValue("첨부 자료를 읽고 할 일, 담당자와 기한을 정리해줘.");
  expect(await page.evaluate(() => localStorage.getItem("tomverse-native-synthetic-demo"))).toBeNull();
  await page.locator(".ios-navigation").getByRole("button", { name: "보관함", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Chat으로 돌아가기", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("첨부 자료를 읽고 할 일, 담당자와 기한을 정리해줘.");
});

test("Review file tools seed Review without sending or changing products", async ({ page }) => {
  await page.locator(".workspace-navigation").getByRole("button", { name: "Review", exact: true }).click();
  await page.locator(".composer-add").click();
  await page.getByRole("dialog").getByRole("button", { name: "파일 만들기·변환", exact: true }).click();
  await page.getByRole("dialog").getByTestId("ios-starter-docx").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".workspace-navigation").getByRole("button", { name: "Review", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox")).toHaveValue("내 계획을 내려받을 수 있는 Word 문서로 만들어줘.");
  expect(await page.evaluate(() => localStorage.getItem("tomverse-native-synthetic-demo"))).toBeNull();
});

test("a provider export is parsed locally and only selected text is imported", async ({ page }) => {
  const exported = [{ id: "export-1", title: "My launch", current_node: "a", mapping: {
    q: { id: "q", parent: null, children: ["a"], message: { id: "q", author: { role: "user" }, content: { content_type: "text", parts: ["Plan my launch."] } } },
    a: { id: "a", parent: "q", children: [], message: { id: "a", author: { role: "assistant" }, content: { content_type: "text", parts: ["Interview twenty people first."] } } },
  } }];
  await page.getByRole("button", { name: "다른 AI의 대화 이어가기 ChatGPT · Claude · Gemini", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "대화 가져오기", exact: true }).click();
  await expect(dialog.getByText(/남은 용량: 대화/)).toBeVisible();
  await dialog.getByLabel("내보낸 파일 선택", { exact: true }).setInputFiles({ name: "conversations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(dialog.getByRole("heading", { name: "가져올 대화 선택", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "선택한 대화 보관", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "선택한 대화 보관", exact: true }).click();
  await expect(dialog.getByText("대화를 보관했습니다", { exact: true })).toBeVisible();
  const originals = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo:imports") ?? "[]"));
  expect(originals).toHaveLength(1); expect(originals[0].messages).toHaveLength(2);
  expect(await page.evaluate(() => localStorage.getItem("tomverse-native-synthetic-demo"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("tomverse-native-synthetic-demo:memory"))).toBeNull();
});

test("existing imported source stays distinct from the continuing Chat on iPad and iPhone", async ({ page }, info) => {
  await page.evaluate(() => localStorage.setItem("tomverse-native-synthetic-demo:imports", JSON.stringify([{ id: "source-1", provider: "chatgpt", title: "Launch plan", locked: false, messageCount: 2, messages: [{ id: "q1", role: "user", content: "Plan a small launch." }, { id: "a1", role: "assistant", content: "Start with twenty interviews." }] }])));
  await page.getByRole("button", { name: "다른 AI의 대화 이어가기 ChatGPT · Claude · Gemini", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Launch plan chatgpt · 2", exact: true }).click();
  await expect(dialog.getByText("Start with twenty interviews.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "새 Chat에서 이어갑니다", exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem("tomverse-native-synthetic-demo"))).toBeNull();
  await dialog.getByRole("button", { name: "확인하고 Chat 열기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".ios-source-panel summary")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeEnabled();
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]"));
  expect(rows[0].productKey).toBe("chat"); expect(rows[0].messages).toHaveLength(0);
  expect(rows[0].imported.messages).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("continued-chat.png") });
});
