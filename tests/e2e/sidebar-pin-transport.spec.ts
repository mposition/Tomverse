import { expect, test, type Page, type Route } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * The pin write as it actually leaves the page.
 *
 * `tests/conversationPinStore.test.mjs` runs the write protocol against a fake
 * server, but it injects its own transport -- so the one piece that turns HTTP
 * into an outcome (`pinTransport` in `ChatSidebar.tsx`) is never exercised
 * there. That mapping is where a 409 supersession could be read as a refusal,
 * or a 500 as a success, without any store test noticing. These cases drive the
 * real menu, the real fetch and the real mapping against scripted responses.
 */

type PinBody = { pinned: boolean; seq: number; ownerId?: string | null };

const listSeq = 3;

/**
 * Serve the list with a pin sequence, which the shared fixture's list does not
 * carry. Built here rather than derived from the fixture's response: that
 * handler fulfils in-process, and `route.fetch()` would go past it to a server
 * with no database behind it.
 */
const serveSequencedList = async (page: Page) => {
  await page.route("**/api/conversations", async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: [
        {
          id: "qa-conversation",
          title: "QA conversation",
          kind: "chat",
          selectedModels: ["gpt-5-6-luna"],
          disabledPanels: [],
          updatedAt: new Date().toISOString(),
          isLocked: false,
          shareEnabled: false,
          pinned: false,
          pinSeq: listSeq,
        },
      ],
    });
  });
};

/**
 * Answer successive pin writes from a script, recording what was sent.
 *
 * Each answer waits for the test to release it, so a case can observe the
 * optimistic row before the response decides where it ends up. Without that,
 * "the row went back" would pass just as well for a row that never moved.
 */
const scriptPinWrites = async (
  page: Page,
  answers: Array<{ status: number; body: Record<string, unknown> }>
) => {
  const sent: PinBody[] = [];
  const waiting: Array<() => void> = [];
  await page.route("**/api/conversations/qa-conversation/pin", async (route) => {
    sent.push(route.request().postDataJSON() as PinBody);
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    await new Promise<void>((resolve) => waiting.push(resolve));
    await route.fulfill({ status: answer.status, json: answer.body });
  });
  return {
    sent,
    release: async () => {
      await expect.poll(() => waiting.length).toBeGreaterThan(0);
      waiting.shift()?.();
    },
  };
};

const pinnedHeader = (page: Page) => page.getByTestId("sidebar-pinned-header");

const openMenuAndPin = async (page: Page) => {
  const row = page
    .getByTestId("sidebar-conversation-item")
    .filter({ hasText: "QA conversation" })
    .first();
  await expect(row).toBeVisible();
  await expect(pinnedHeader(page)).toHaveCount(0);
  await row.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("button", { name: "Pin chat" }).click();
  // Optimistic: the row moves before any answer. Every case below starts from
  // here, so a row that ends unpinned is known to have moved and come back.
  await expect(pinnedHeader(page)).toBeVisible();
};

test.describe("pin writes through the real transport", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "The transport is shell-independent; one desktop run covers the mapping."
    );
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await serveSequencedList(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("an applied write settles the row, carrying a sequence above the list's", async ({
    page,
  }) => {
    const script = await scriptPinWrites(page, [
      { status: 200, body: { pinned: true, pinSeq: 4 } },
    ]);

    await openMenuAndPin(page);
    await script.release();

    await expect(pinnedHeader(page)).toBeVisible();
    expect(script.sent).toHaveLength(1);
    expect(script.sent[0].pinned).toBe(true);
    // Issued by this tap, and never below what the list already said.
    expect(script.sent[0].seq).toBeGreaterThan(listSeq);
  });

  test("a superseded answer is followed, not fought", async ({ page }) => {
    // A later tap on another device already holds the column. The server
    // answers 409 PIN_SUPERSEDED with what it holds, and the row follows it with
    // no second request: the later tap is the one that should win. Read as a
    // failure instead, it would be resent -- so the single request is what this
    // case checks.
    const script = await scriptPinWrites(page, [
      {
        status: 409,
        body: { code: "PIN_SUPERSEDED", pinned: false, pinSeq: 9_000_000_000_000 },
      },
    ]);

    await openMenuAndPin(page);
    await script.release();

    await expect(pinnedHeader(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(script.sent).toHaveLength(1);
  });

  test("an unknown outcome is resent as the same write", async ({ page }) => {
    // A 500 proves nothing about whether the write happened. The resend is the
    // same write -- same sequence -- so it is safe either way, and its answer
    // settles the row.
    const script = await scriptPinWrites(page, [
      { status: 500, body: { error: "Failed to update the pin." } },
      { status: 200, body: { pinned: true, pinSeq: 4 } },
    ]);

    await openMenuAndPin(page);
    await script.release();
    await script.release();

    await expect.poll(() => script.sent.length).toBe(2);
    expect(script.sent[1].seq).toBe(script.sent[0].seq);
    await expect(pinnedHeader(page)).toBeVisible();
  });

  test("nothing provable after every resend puts the row back", async ({ page }) => {
    const script = await scriptPinWrites(page, [
      { status: 500, body: { error: "Failed to update the pin." } },
    ]);

    await openMenuAndPin(page);
    // The first attempt and each resend all fail.
    for (let attempt = 0; attempt < 3; attempt += 1) await script.release();

    // Pinned a moment ago, unpinned now: nothing proved the write happened, so
    // the row goes back to what the list said rather than keeping the claim.
    await expect(pinnedHeader(page)).toHaveCount(0);
    expect(script.sent).toHaveLength(3);
    expect(new Set(script.sent.map((body) => body.seq)).size).toBe(1);
  });

  test("an account change is a refusal, and is not resent", async ({ page }) => {
    const script = await scriptPinWrites(page, [
      {
        status: 409,
        body: {
          code: "PIN_OWNER_CHANGED",
          error: "The signed-in account changed before this change was sent.",
        },
      },
    ]);

    await openMenuAndPin(page);
    await script.release();

    await expect(pinnedHeader(page)).toHaveCount(0);
    // Read as "failed" it would be resent. Read correctly it is refused once.
    await page.waitForTimeout(300);
    expect(script.sent).toHaveLength(1);
  });
});
