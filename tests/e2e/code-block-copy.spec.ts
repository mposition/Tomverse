import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  clipboardWrites,
  grantClipboardAccess,
  recordClipboardWrites,
} from "./support/engine-capabilities";

/**
 * One answer carrying everything the per-block copy control has to tell apart:
 * prose, one span of inline code, and two fenced blocks under different
 * language identifiers -- the second one indented, multi-line, and holding a
 * blank line the author meant to be there.
 */
const ASSISTANT_ANSWER = [
  "Here is the markup, and then the component that renders it.",
  "",
  "The wrapper uses `display: grid` and nothing else.",
  "",
  "```html",
  '<section class="card">',
  "  <h2>Title</h2>",
  "</section>",
  "```",
  "",
  "And the component:",
  "",
  "```tsx",
  "export function Card() {",
  "  if (!ready) {",
  "    return null;",
  "  }",
  "",
  '  return <section className="card" />;',
  "}",
  "```",
].join("\n");

/** The second block's code exactly as it was written, fence and all removed. */
const SECOND_BLOCK_CODE = [
  "export function Card() {",
  "  if (!ready) {",
  "    return null;",
  "  }",
  "",
  '  return <section className="card" />;',
  "}",
].join("\n");

const FIRST_BLOCK_FIRST_LINE = '<section class="card">';

async function openAnswerWithCodeBlocks(page: Page) {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-4-mini"],
    messages: [
      {
        id: "user-turn",
        role: "user",
        content: "Show me the card markup.",
      },
      {
        id: "assistant-code-blocks",
        role: "assistant",
        modelId: "gpt-5-4-mini",
        status: "normal",
        content: ASSISTANT_ANSWER,
      },
    ],
  });

  // The shared authenticated mock serves a Korean account. This spec asserts
  // on accessible names, so it pins the account's language to English --
  // registered last, which is the handler Playwright runs first.
  await page.route("**/api/user/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        theme: "dark",
        language: "en",
        defaultModel: "gpt-5-4-mini",
        timeZone: "UTC",
        timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangedAt: null,
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/chat");
  // A fresh chat starts blank -- open the mocked conversation from the welcome
  // screen the way a user would, which is what loads its messages.
  await openRecentConversation(page);

  const answer = page.locator('[data-message-role="assistant"]').last();
  await expect(answer.locator("pre").first()).toBeVisible();
  return answer;
}

test("every code block gets its own copy button, and inline code gets none", async ({
  page,
}) => {
  const answer = await openAnswerWithCodeBlocks(page);

  await expect(answer.locator("pre")).toHaveCount(2);
  await expect(answer.getByTestId("chat-code-copy-button")).toHaveCount(2);

  // Inline code is rendered as a <code> with no <pre> around it. It is present
  // in this answer, so "two buttons" above is a statement about block code
  // specifically rather than an accident of the fixture.
  const inlineCode = answer.locator("code").filter({ hasText: "display: grid" });
  await expect(inlineCode).toHaveCount(1);
  await expect(
    inlineCode.locator("xpath=..").getByTestId("chat-code-copy-button")
  ).toHaveCount(0);
});

test("a code block's button copies that block's code and nothing else", async ({
  page,
}) => {
  // Both of these are about the engine, not the product: WebKit has no
  // clipboard permission to grant, and only the engine that granted one will
  // read the clipboard back. What the button writes is recorded either way.
  const clipboardReadable = await grantClipboardAccess(page);
  await recordClipboardWrites(page);

  const answer = await openAnswerWithCodeBlocks(page);
  const buttons = answer.getByTestId("chat-code-copy-button");
  await buttons.nth(1).click();

  const written = await clipboardWrites(page);
  expect(written, "the button wrote to the clipboard exactly once").toHaveLength(1);
  const copied = written[0];

  if (clipboardReadable) {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
  }

  // Indentation, the interior newlines and the deliberate blank line all
  // survive, and nothing around the block comes with them.
  expect(copied).toBe(SECOND_BLOCK_CODE);
  expect(copied).not.toContain("```");
  expect(copied).not.toContain("tsx");
  expect(copied).not.toContain("And the component:");
  expect(copied).not.toContain(FIRST_BLOCK_FIRST_LINE);
  expect(copied).toContain("\n    return null;\n");
  expect(copied).toContain("  }\n\n  return");
});

test("the copy button reports success in its accessible name, then restores it", async ({
  page,
}) => {
  await grantClipboardAccess(page);
  await recordClipboardWrites(page);

  const answer = await openAnswerWithCodeBlocks(page);
  const button = answer.getByTestId("chat-code-copy-button").first();

  await expect(button).toHaveAccessibleName("Copy code");
  await button.click();
  await expect(button).toHaveAccessibleName("Copied");
  // The tick is temporary; the control has to go back to offering the action.
  await expect(button).toHaveAccessibleName("Copy code", { timeout: 5_000 });
});

test("the copy button is reachable and operable from the keyboard", async ({
  page,
}) => {
  await grantClipboardAccess(page);
  await recordClipboardWrites(page);

  const answer = await openAnswerWithCodeBlocks(page);
  const secondBlock = answer.locator("pre").nth(1);
  const button = answer.getByTestId("chat-code-copy-button").nth(1);

  // The block itself is a focus stop (UX-031); its copy button is the next one
  // after it, so Tab alone gets there -- no pointer anywhere in this test.
  await secondBlock.focus();
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(button).toHaveAccessibleName("Copied");
  expect(await clipboardWrites(page)).toEqual([SECOND_BLOCK_CODE]);
});

test("a failed clipboard write does not report success", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    Object.defineProperty(clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new Error("clipboard unavailable")),
    });
  });

  const answer = await openAnswerWithCodeBlocks(page);
  const button = answer.getByTestId("chat-code-copy-button").first();

  await button.click();
  await expect(button).toHaveAccessibleName("Copy code");
  // Give the success state the time it would have needed to appear at all.
  await expect(button).toHaveAccessibleName("Copy code", { timeout: 2_000 });
});

test("the answer's own copy button still copies the whole answer", async ({
  page,
}) => {
  await grantClipboardAccess(page);
  await recordClipboardWrites(page);

  const answer = await openAnswerWithCodeBlocks(page);
  await answer.getByRole("button", { name: "Copy response" }).click();

  expect(await clipboardWrites(page)).toEqual([ASSISTANT_ANSWER]);
});

test("the copy button offers a full-size touch target inside its code block", async ({
  page,
}) => {
  const answer = await openAnswerWithCodeBlocks(page);
  await expect(answer.getByTestId("chat-code-copy-button").first()).toBeVisible();

  // Measured from the points a finger would land on rather than from the
  // button's own box: the visible icon stays small and the target is grown
  // with a pseudo-element, which only hit testing can see.
  const target = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>(
      '[data-testid="chat-code-copy-button"]'
    );
    const block = button?.parentElement?.querySelector("pre");
    if (!button || !block) return null;

    const box = button.getBoundingClientRect();
    const code = block.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    // Half of 44px, pulled in half a pixel so the probe lands on the edge
    // rather than just past it.
    const half = 21.5;
    const hits = (offsetX: number, offsetY: number) => {
      const element = document.elementFromPoint(centerX + offsetX, centerY + offsetY);
      return !!element && (element === button || button.contains(element));
    };

    return {
      corners: [
        hits(-half, -half),
        hits(half, -half),
        hits(-half, half),
        hits(half, half),
      ],
      insideCodeBlock:
        centerX - half >= code.left &&
        centerX + half <= code.right &&
        centerY - half >= code.top &&
        centerY + half <= code.bottom,
    };
  });

  expect(target).not.toBeNull();
  expect(target?.corners, "44x44px of the button is hittable").toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(
    target?.insideCodeBlock,
    "the touch target stays within the code block"
  ).toBe(true);
});
