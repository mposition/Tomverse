import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { restoreActiveConversation, setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";
import { clipboardWrites, recordClipboardWrites } from "./support/engine-capabilities";

const CODE = "funcs = []\nfor i in range(3):\n    funcs.append(lambda: i)\nprint([f() for f in funcs])";
const QUESTION = "다음 Python 코드가 기대와 다르게 동작하는 이유와 수정 코드를 설명해 주세요. 기대 출력은 [0, 1, 2]입니다.";
const PROMPT = `${QUESTION}\n\n${CODE}`;

test.describe("Submitted prompt code", { tag: "@ui-risk" }, () => {
  test.use({ hasTouch: true });
  test.setTimeout(120_000);
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit phone and desktop viewport coverage.");
  });

  for (const product of ["chat", "review"] as const)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        for (const appearance of ["classic", "studio"] as const) {
          test(`${product} ${width}px ${theme} ${appearance} renders and copies the reported Python prompt`, async ({ page }) => {
            await page.setViewportSize({ width, height: width > 768 ? 960 : 844 });
            await prepareGuestPage(page, "ko", appearance, appearance);
            const account = await mockAuthenticatedApi(page, {
              productKey: product, language: "ko", selectedModels: ["gpt-6-luna"],
              messages: [
                { id: "python-user", role: "user", content: PROMPT },
                { id: "python-answer", role: "assistant", modelId: "gpt-6-luna", content: `기본 인자로 현재 값을 고정하세요.\n\n\`\`\`python\n${CODE}\n\`\`\`` },
              ],
            });
            account.theme = theme;
            await setDeterministicTheme(page, theme);
            await suppressTransientUi(page);
            await restoreActiveConversation(page);
            await recordClipboardWrites(page);
            await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" }]);
            let executions = 0;
            await page.route(/\/api\/(chat|review\/route)(\?|$)/, route => {
              executions++;
              return route.fulfill({ status: 500, json: { error: "Unexpected execution" } });
            });
            await page.goto(`/${product}?lang=ko`);
            const user = page.locator('[data-message-role="user"]');
            const block = user.getByTestId("user-message-code");
            await expect(block).toBeVisible();
            await expect(user.getByText(QUESTION, { exact: true })).toBeVisible();
            expect(await block.locator("pre code").textContent()).toBe(`${CODE}\n`);
            await expect(block.locator(".hljs-keyword").filter({ hasText: "for" }).first()).toBeVisible();
            const assistant = page.locator('[data-message-role="assistant"]');
            const style = (node: Element) => {
              const css = getComputedStyle(node);
              return { font: css.fontFamily, background: css.backgroundColor, color: css.color };
            };
            expect(await block.locator("pre").evaluate(style)).toEqual(await assistant.locator("pre").evaluate(style));
            await block.getByTestId("chat-code-copy-button").click();
            expect(await clipboardWrites(page)).toEqual([CODE]);
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            expect(executions).toBe(0);
            await page.screenshot({ path: `artifacts/prompt-code-${product}-${width}-${theme}-${appearance}.png`, fullPage: true, style: "nextjs-portal{display:none!important}" });
          });
        }
});
