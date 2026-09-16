import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
} from "../tests/e2e/support/app-fixtures.ts";

const origin = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3100";
const outputDirectory =
  process.env.CAPTURE_OUTPUT_DIRECTORY ||
  ".tmp/assistant-knowledge-tutorial";

const localizedProfile = {
  ko: {
    name: "프로젝트 브리핑 도우미",
    description: "기획 자료를 근거로 핵심 결정과 다음 행동을 정리합니다.",
    instructions:
      "결론과 근거를 먼저 쓰고, 확인이 필요한 내용과 다음 행동을 짧게 제안하세요.",
    starter: "이번 주 우선순위와 확인할 위험을 정리해 주세요.",
  },
  en: {
    name: "Project briefing assistant",
    description:
      "Uses planning material to summarize key decisions and next actions.",
    instructions:
      "Lead with the conclusion and evidence. Then list what needs checking and suggest the next action.",
    starter: "Summarize this week's priorities and the risks to check.",
  },
  zh: {
    name: "项目简报助手",
    description: "根据规划资料整理关键决策和下一步行动。",
    instructions:
      "先写结论和依据，再列出需要确认的内容，并简短建议下一步行动。",
    starter: "请整理本周优先事项和需要确认的风险。",
  },
};

const json = (body) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const language of ["ko", "en", "zh"]) {
    const profileCopy = localizedProfile[language];
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1920, height: 1080 },
      colorScheme: "dark",
      locale:
        language === "ko"
          ? "ko-KR"
          : language === "zh"
            ? "zh-CN"
            : "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();

    await prepareGuestPage(page, language);
    await mockAuthenticatedApi(page, {
      assistantProfiles: [
        {
          id: "tutorial-assistant",
          name: profileCopy.name,
          icon: "🧭",
          description: profileCopy.description,
          published: true,
          currentRevision: 1,
        },
      ],
    });
    await context.addCookies([
      { name: "__tomverse_e2e_auth", value: "1", url: origin },
    ]);

    await page.unroute("**/api/user/settings");
    await page.route("**/api/user/settings", (route) =>
      route.fulfill(
        json({
          theme: "dark",
          language,
          defaultModel: "gpt-5-6-luna",
          timeZone: "UTC",
          imageHandoffAutoGenerate: false,
        })
      )
    );

    await page.unroute("**/api/assistant-profiles");
    await page.route(
      (url) => url.pathname === "/api/assistant-profiles",
      (route) =>
        route.fulfill(
          json({
            profiles: [
              {
                id: "tutorial-assistant",
                name: profileCopy.name,
                icon: "🧭",
                description: profileCopy.description,
                published: true,
                currentRevision: 1,
                versionCount: 1,
                knowledgeFileCount: 1,
              },
            ],
            limits: { maxProfilesPerAccount: 20 },
            features: { packageImport: true },
          })
        )
    );
    await page.route(
      (url) =>
        url.pathname === "/api/assistant-profiles/tutorial-assistant",
      (route) =>
        route.fulfill(
          json({
            profile: {
              id: "tutorial-assistant",
              name: profileCopy.name,
              icon: "🧭",
              description: profileCopy.description,
              currentVersionId: "tutorial-version-1",
              currentVersion: {
                revision: 1,
                instructions: profileCopy.instructions,
                models: [],
                toolPolicy: { webSearch: false, deepResearch: false },
                memoryPolicy: { useAccountMemory: false },
                starters: [profileCopy.starter],
                knowledgeManifest: [
                  {
                    fileId: "tutorial-file",
                    name: "project-brief.pdf",
                    mime: "application/pdf",
                    bytes: 34816,
                    sha256:
                      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  },
                ],
              },
              versions: [
                {
                  id: "tutorial-version-1",
                  revision: 1,
                  createdAt: "2026-09-15T00:00:00.000Z",
                },
              ],
              knowledgeFiles: [
                {
                  id: "tutorial-file",
                  name: "project-brief.pdf",
                  mime: "application/pdf",
                  bytes: 34816,
                  processingStatus: "ready",
                  failureCode: null,
                  chunkCount: 6,
                  createdAt: "2026-09-15T00:00:00.000Z",
                },
              ],
              imports: [],
            },
            features: { knowledge: true },
          })
        )
    );

    await page.goto(`${origin}/settings/assistants?lang=${language}`, {
      waitUntil: "networkidle",
    });
    try {
      await page
        .getByTestId("assistant-profile-tutorial-assistant")
        .waitFor({ state: "visible" });
    } catch (error) {
      console.error("[capture diagnostics]", {
        language,
        url: page.url(),
        title: await page.title(),
        body: (await page.locator("body").innerText()).slice(0, 4000),
      });
      await page.screenshot({
        path: `${outputDirectory}/${language}-capture-failure.png`,
        type: "png",
        fullPage: true,
      });
      throw error;
    }
    await page.screenshot({
      path: `${outputDirectory}/${language}-01-assistant-list.png`,
      type: "png",
    });

    await page.goto(
      `${origin}/settings/assistants/tutorial-assistant?lang=${language}`,
      { waitUntil: "networkidle" }
    );
    await page.getByTestId("assistant-instructions").waitFor({ state: "visible" });
    await page.getByTestId("assistant-instructions").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${outputDirectory}/${language}-02-knowledge-editor.png`,
      type: "png",
    });
    await page
      .getByTestId("knowledge-panel")
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${outputDirectory}/${language}-03-knowledge-files.png`,
      type: "png",
    });

    await page.goto(`${origin}/chat?lang=${language}`, {
      waitUntil: "networkidle",
    });
    await openRecentConversation(page);
    await page
      .locator('button[aria-controls="chat-input-popover"]')
      .nth(0)
      .click();
    await page.getByTestId("tools-assistant-row").click();
    await page
      .getByTestId("assistant-option-tutorial-assistant")
      .waitFor({ state: "visible" });
    await page.screenshot({
      path: `${outputDirectory}/${language}-04-chat-picker.png`,
      type: "png",
    });

    await context.close();
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    {
      outputDirectory,
      languages: ["ko", "en", "zh"],
      framesPerLanguage: 4,
      source: "localized Tomverse product UI",
    },
    null,
    2
  )
);
