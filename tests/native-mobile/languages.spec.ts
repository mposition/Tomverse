import { expect, test } from "@playwright/test";

const cases = [
  ["en", "Read a document", "Read the attached document", "My assistants", "Create assistant"],
  ["ko", "자료를 읽고 할 일 정리", "첨부 자료를 읽고", "내 어시스턴트", "어시스턴트 만들기"],
  ["zh", "读资料，整理待办", "阅读附件", "我的助手", "创建助手"],
  ["zh-Hant", "閱讀資料，整理待辦", "閱讀附件", "我的助手", "建立助手"],
  ["de", "Dokument lesen", "Lies das angehängte Dokument", "Meine Assistenten", "Assistenten erstellen"],
  ["fr", "Lire un document", "Lisez le document joint", "Mes assistants", "Créer un assistant"],
  ["es", "Leer un documento", "Lee el documento adjunto", "Mis asistentes", "Crear asistente"],
  ["pt", "Ler um documento", "Leia o documento anexado", "Os meus assistentes", "Criar assistente"],
] as const;

for (const [language, starter, prompt, assistants, create] of cases) {
  test(`native workspace uses ${language} for actions and prompt seeds`, async ({ page }) => {
    await page.route("https://tomverse.app/**", route => route.abort());
    await page.addInitScript(language => {
      localStorage.setItem("tomverse-language", language);
      localStorage.setItem("tomverse-native-synthetic-demo:session", "signed-in");
    }, language);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(page.getByTestId("ios-starter-document")).toHaveText(starter);
    await page.getByTestId("ios-starter-document").click();
    await expect(page.getByRole("textbox")).toHaveValue(new RegExp(prompt));
    await expect(page.locator("article.user")).toHaveCount(0);
    await page.locator(".header-new-chat").click();
    await page.getByRole("button", { name: assistants, exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: create, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("Traditional Chinese remains selected after changing language and reloading", async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("tomverse-native-synthetic-demo:session", "signed-in");
    if (!localStorage.getItem("tomverse-language")) localStorage.setItem("tomverse-language", "en");
  });
  await page.goto("/");
  await page.locator(".app-header .menu-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("native-settings-tab-preferences").click();
  const language = page.getByRole("combobox", { name: "Language", exact: true });
  await expect(language.locator("option")).toHaveCount(8);
  await language.selectOption("zh-Hant");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.getByTestId("ios-starter-document")).toHaveText("閱讀資料，整理待辦");
});
