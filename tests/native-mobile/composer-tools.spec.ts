import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "../../.tmp/native-message-tools");
mkdirSync(output, { recursive: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("tomverse-language", "ko");
    localStorage.setItem("tomverse-theme", "light");
  });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const injection = `
      const { nativeChatLocation } = await import("/src/chatLocation.ts");
      transport.location = nativeChatLocation;
      const originalAccount = transport.account;
      transport.account = async () => {
        const profile = await originalAccount();
        nativeChatLocation.setIdentity(profile.id);
        return profile;
      };
    `;
    expect(source).toContain("createRoot(container).render(");
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
});

for (const theme of ["light", "dark"]) test(`message tools preserve touch targets and consent at narrow and enlarged text sizes in ${theme}`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem("tomverse-theme", value), theme);
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.locator(".composer-add").click();
  const dialog = page.getByRole("dialog", { name: "메시지 도구" });
  await expect(dialog.getByRole("combobox")).toHaveCount(1);
  await expect(dialog.getByLabel("메모리", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("switch", { name: "웹 검색", exact: true })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "현재 위치", exact: true })).not.toBeChecked();
  await expect(dialog.locator("#native-location-disclosure")).toContainText("메시지마다");
  await expect(dialog.locator("#native-location-disclosure")).toContainText("백그라운드 추적은 하지 않아요");
  await page.screenshot({ path: resolve(output, `message-tools-${theme}.png`) });

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    for (const scale of ["100%", "200%"]) {
      await page.evaluate(value => { document.documentElement.style.fontSize = value; }, scale);
      const geometry = await dialog.evaluate(node => ({
        width: node.clientWidth, scroll: node.scrollWidth,
        targets: [...node.querySelectorAll("button, .tool-row")].map(target => {
          const rect = target.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.width).toBeLessThanOrEqual(width);
      expect(geometry.targets.every(target => target.height >= 44 && target.width >= 44)).toBe(true);
      await dialog.getByRole("combobox", { name: "어시스턴트", exact: true }).selectOption("demo-assistant");
      await expect(dialog.getByRole("combobox")).toHaveValue("demo-assistant");
    }
  }
});

test("photo and file actions keep their separate pickers and preserve an unsent draft", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByRole("textbox").fill("Keep this draft");
  await page.locator(".composer-add").click();
  const photoChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "사진 선택", exact: true }).click();
  await (await photoChooser).setFiles([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".composer-add").click();
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "파일 선택", exact: true }).click();
  await (await fileChooser).setFiles([]);
  await expect(page.getByRole("textbox")).toHaveValue("Keep this draft");
  await expect(page.locator("article.user")).toHaveCount(0);
});

for (const [language, title, location, assistant] of [
  ["en", "Message tools", "Current location", "Assistant"],
  ["zh", "消息工具", "当前位置", "助手"],
  ["de", "Nachrichtenwerkzeuge", "Aktueller Standort", "Assistent"],
  ["fr", "Outils de message", "Position actuelle", "Assistant"],
  ["es", "Herramientas de mensaje", "Ubicación actual", "Asistente"],
  ["pt", "Ferramentas de mensagem", "Localização atual", "Assistente"],
]) test(`message tools expose localized controls in ${language}`, async ({ page }) => {
  await page.addInitScript(value => {
    localStorage.setItem("tomverse-language", value);
    localStorage.setItem("tomverse-native-synthetic-demo:session", "signed-in");
  }, language);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/"); await page.locator(".composer-add").click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog.getByRole("switch", { name: location, exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: assistant, exact: true })).toBeVisible();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
