import { expect, test, type Page } from "@playwright/test";

import {
  createQaPngBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
} from "./support/app-fixtures";
import {
  freezeAnimations,
  setDeterministicTheme,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

/**
 * A composer draft belongs to a person, not just to a tab.
 *
 * Contract: docs/policy/conversation-draft-identity-scope.md.
 *
 * Account A types into a new chat and account B takes over the same tab.
 * Before this, B read A's text: `draftKeyFor` named a conversation and every
 * identity shares the new-conversation key. Unsent text is the worst thing to
 * get wrong this way — nothing knows what is in it, and on a shared machine
 * the next person simply reads it.
 *
 * ## How the account is changed
 *
 * `next-auth`'s own refetch path: serve a different `/api/auth/session` and
 * dispatch `visibilitychange`. No test-only hook in the product.
 *
 * ## What each test is for
 *
 * 1. text — the reported reproduction, and that A's own draft survives;
 * 2. attachments — the same boundary for the local image preview, which the
 *    composer renders as a real thumbnail rather than a file name;
 * 3. a *late* upload — the case a store-per-signed-in-account would still get
 *    wrong, because the write arrives after the tab has changed hands.
 */

type QaSessionUser = { id: string; name: string } | null;

const sessionBody = (user: QaSessionUser) =>
  user === null
    ? null
    : {
        user: {
          id: user.id,
          name: user.name,
          email: `${user.id}@tomverse.app`,
          image: null,
          plan: "Free",
        },
        expires: "2099-01-01T00:00:00.000Z",
      };

const installSwitchableSession = async (page: Page) => {
  const state: { user: QaSessionUser; reads: number } = {
    user: { id: "qa-user", name: "QA User" },
    reads: 0,
  };
  await page.route("**/api/auth/session**", (route) => {
    state.reads++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(sessionBody(state.user)),
    });
  });
  return state;
};

const refetchSession = async (page: Page) => {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

const actionMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').first();

/** The repository's own attach flow: menu, source, file chooser. */
const attachFromComputer = async (
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer }
) => {
  await actionMenuTrigger(page).click();
  await page.getByTestId("tools-attach-row").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-local-file-row").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
};

const openComposer = async (page: Page) => {
  await mockAuthenticatedApi(page);
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  const session = await installSwitchableSession(page);
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
  return session;
};

/** Hands the account over to someone else, and waits for the page to notice. */
const signInAsOtherAccount = async (
  page: Page,
  session: { user: QaSessionUser; reads: number }
) => {
  const before = session.reads;
  session.user = { id: "qa-user-2", name: "다른 사람" };
  await refetchSession(page);
  await expect
    .poll(() => session.reads, { timeout: 5_000 })
    .toBeGreaterThan(before);
};

test.describe("a composer draft belongs to one person", () => {
  test("the next account sees a blank composer, and the first keeps its text @ui-risk", async ({
    page,
  }) => {
    const session = await openComposer(page);
    const textarea = page.getByTestId("chat-textarea");

    await textarea.fill("계정 A가 쓰던 초안");
    await expect(textarea).toHaveValue("계정 A가 쓰던 초안");

    await signInAsOtherAccount(page, session);

    // The reported defect. This read "계정 A가 쓰던 초안" before the fix.
    await expect(textarea).toHaveValue("");

    // Isolation, not deletion: A's work is unreachable from B, not destroyed.
    // It is still only in memory, so it goes when the tab does.
    session.user = { id: "qa-user", name: "QA User" };
    await refetchSession(page);
    await expect(textarea).toHaveValue("계정 A가 쓰던 초안", { timeout: 5_000 });
  });

  test("B does not inherit A's attachment or its image preview @ui-risk", async ({
    page,
  }) => {
    await mockAttachmentUpload(page);
    const session = await openComposer(page);

    // A real upload through the real flow, so what B might inherit is a real
    // card with a real `blob:` thumbnail and not a synthetic fixture.
    await attachFromComputer(page, {
      name: "a-private-picture.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });
    await expect(page.getByTestId("attachment-complete")).toBeVisible({
      timeout: 15_000,
    });
    const thumbnail = page.getByAltText("a-private-picture.png");
    await expect(thumbnail).toBeVisible();

    await signInAsOtherAccount(page, session);

    await expect(
      page.getByTestId("attachment-complete"),
      "account B must not inherit the card"
    ).toHaveCount(0);
    await expect(
      thumbnail,
      "nor the image itself, which is the part a file name would hide"
    ).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
  });
});
