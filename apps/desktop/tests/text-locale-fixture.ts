import assert from "node:assert/strict";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { desktopChatCopy } from "../../../locales/desktopChat";
import { workspaceWelcomeCopy } from "../../../locales/workspaceWelcome";
import { expectWindowsAccessibleNames } from "./windows-accessibility";

export async function installTextLocalesFixture(application: ElectronApplication, origin: string) {
  await application.evaluate((_electron, localOrigin) => {
    const realFetch = globalThis.fetch;
    const host = globalThis as typeof globalThis & { localeWrites: string[] };
    host.localeWrites = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== localOrigin) throw new Error("Unexpected nonlocal fixture request.");
      const method = init?.method ?? "GET";
      if (method === "POST" && !url.pathname.startsWith("/api/auth/desktop/")) {
        host.localeWrites.push(url.pathname);
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/api/models/catalog") return Response.json({ models: [
        { id: "locale-model", name: "Local locale model", provider: "openai", minimumPlan: "Free", enabled: true,
          status: "enabled", publiclyListed: true, reasoningEfforts: ["low", "high"] },
      ] });
      const response = await realFetch(input, init);
      if (url.pathname !== "/api/products/chat/capabilities" || !response.ok) return response;
      return Response.json({
        ...(await response.json()),
        desktopWrite: true, desktopAttachments: true, desktopReview: { easy: true, modelLimit: 3, plan: "Pro" },
        desktopImages: { maxModels: 3, models: [{ id: "local-image-model", name: "Local image model", provider: "openai", pricingVersion: "fixture",
          prices: [{ size: "1024x1024", quality: "medium", credits: 1200 }] }] },
        desktopStarters: [{ id: "summarize-text", label: "Fixture summary", outcome: "Local fixture starter", seed: "Fixture summary prompt" }],
      });
    };
  }, origin);
}

export async function verifyTextLocales(application: ElectronApplication, page: Page) {
  const locales = [
    ["en", "Settings", "Language", "Chat message", "Review question", "Review mode and models", "Send Review question"],
    ["ko", "설정", "언어", "Chat 메시지", "Review 질문", "Review 모드 및 모델", "Review 질문 보내기"],
    ["zh", "设置", "语言", "Chat 消息", "Review 问题", "Review 模式与模型", "发送 Review 问题"],
    ["zh-Hant", "設定", "語言", "Chat 訊息", "Review 問題", "Review 模式與模型", "傳送 Review 問題"],
    ["fr", "Paramètres", "Langue", "Message Chat", "Question Review", "Mode Review et modèles", "Envoyer la question Review"],
    ["de", "Einstellungen", "Sprache", "Chat-Nachricht", "Review-Frage", "Review-Modus und Modelle", "Review-Frage senden"],
    ["es", "Ajustes", "Idioma", "Mensaje de Chat", "Pregunta de Review", "Modo de Review y modelos", "Enviar pregunta de Review"],
    ["pt", "Definições", "Idioma", "Mensagem do Chat", "Pergunta da Review", "Modo da Review e modelos", "Enviar pergunta da Review"],
  ] as const;
  const localizedDraft = "D27 local draft";
  let current: typeof locales[number] = locales[0];
  for (const row of locales) {
    const [language, , , chatLabel, reviewLabel, pickerLabel, sendLabel] = row;
    await page.getByRole("button", { name: current[1], exact: true }).click();
    await page.getByRole("combobox", { name: current[2], exact: true }).selectOption(language);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const chat = page.getByRole("textbox", { name: chatLabel, exact: true });
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(chat).toBeVisible();
    if (language === "en") {
      await expect(page.getByRole("button", { name: /Fixture summary/ })).toBeVisible();
    } else if (language === "ko") {
      const card = workspaceWelcomeCopy.ko.starter.cards.summarizeText;
      await page.getByRole("button", { name: new RegExp(card.label) }).click();
      await expect(chat).toBeFocused();
      await expect(chat).toHaveValue(card.seed);
      await expectWindowsAccessibleNames(application, page, { "Chat 메시지": "ControlType.Edit", "Chat 메시지 보내기": "ControlType.Button" });
      await page.getByRole("form", { name: "Chat 작성창" }).locator('input[type="file"]').setInputFiles({
        name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("Local file fixture"),
      });
      const attachments = page.getByRole("list", { name: "첨부할 파일" });
      await expect(attachments).toContainText("fixture.txt");
      await attachments.getByRole("button", { name: "fixture.txt 제거" }).click();
      await expect(attachments).toHaveCount(0);
      await chat.fill(localizedDraft);
    } else {
      await expect(chat).toHaveValue(localizedDraft);
    }
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const question = page.getByRole("textbox", { name: reviewLabel, exact: true });
    await expect(question).toBeVisible();
    const picker = page.getByLabel(pickerLabel, { exact: true });
    await picker.click();
    await page.getByRole("checkbox", { name: "openai", exact: true }).check();
    await picker.click();
    await question.fill("검토 질문");
    await expect(page.getByRole("button", { name: sendLabel, exact: true })).toBeEnabled();
    if (language === "ko") await expectWindowsAccessibleNames(application, page, {
      "Review 질문": "ControlType.Edit", "Review 질문 보내기": "ControlType.Button",
    });
    await question.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await expect(question).toHaveValue("검토 질문");
    if (language === "de") {
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: desktopChatCopy.de.imageWorkspace, exact: true }).click();
      await expect(page.getByRole("heading", { name: "Bilder erstellen und vergleichen" })).toBeVisible();
      await page.getByRole("textbox", { name: "Bildbeschreibung" }).fill("Local image description");
      await page.getByLabel("Bildmodelle auswählen", { exact: true }).click();
      await page.getByRole("checkbox", { name: "Local image model · 1.200 Credits", exact: true }).check();
      await expect(page.getByRole("button", { name: "Erstellen · 1.200 Credits", exact: true })).toBeEnabled();
      await expectWindowsAccessibleNames(application, page, { Bildbeschreibung: "ControlType.Edit", "Erstellen · 1.200 Credits": "ControlType.Button" });
    }
    current = row;
  }
  assert.deepEqual(await application.evaluate(() =>
    (globalThis as typeof globalThis & { localeWrites: string[] }).localeWrites), []);
}
