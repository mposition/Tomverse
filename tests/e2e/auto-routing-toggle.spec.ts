import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  modelMenuTrigger,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * Auto model selection, now that the control is actually mounted.
 *
 * `docs/ui-contracts/auto-model-selection.md` §1 has said what these two
 * components must render since before either was mounted anywhere -- which
 * means the rule had never once been executed against a real screen. These are
 * the rows that execute it.
 *
 * The hard one is the first: `offered: false` renders **nothing**, not a
 * disabled row. That is measured as "the element does not exist", and the
 * picker is checked for the row height a stray wrapper would leave behind.
 */

// The title the shared fixture seeds. Named here so the spec asks for the
// conversation it actually has rather than one it hoped for.
const CONVERSATION_TITLE = "QA conversation";

const openPicker = async (page: Page) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog).toBeVisible();
  return dialog;
};

const openSeededConversation = async (page: Page) => {
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: CONVERSATION_TITLE });
};

test.describe("Auto is not offered", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      messages: [
        { id: "qa-m1", role: "user", content: "안녕하세요" },
        {
          id: "qa-m2",
          role: "assistant",
          content: "안녕하세요!",
          modelId: "gpt-5-6-luna",
        },
      ],
    });
  });

  test("the toggle does not exist at all", async ({ page }) => {
    // Not hidden, not disabled, not greyed. A control that flips, saves and
    // changes nothing cannot be told apart from Auto agreeing with the user
    // every time -- and neither can support.
    await openSeededConversation(page);
    const dialog = await openPicker(page);

    await expect(dialog.getByTestId("auto-routing-toggle")).toHaveCount(0);
    await expect(dialog.getByRole("switch", { name: /auto/i })).toHaveCount(0);
  });

  test("it leaves no row height behind", async ({ page }) => {
    // The wrapper is inside the condition, not around it. An empty div
    // carrying the wrapper's margin is exactly as much of a contract
    // violation as a greyed row: the sheet loses a model row for a control
    // that does not exist.
    await openSeededConversation(page);
    const dialog = await openPicker(page);

    const selected = dialog.getByTestId("model-picker-selected-list");
    await expect(selected).toBeVisible();

    const gap = await selected.evaluate((list) => {
      const body = list.closest('[data-testid="model-picker-body"]');
      if (!body) return -1;
      // Distance from the top of the picker body to the first thing in it.
      return list.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });

    // A rendered-but-empty Auto wrapper adds its own margin here. The exact
    // number is layout-dependent; what matters is that nothing Auto-shaped
    // (a ~64px card plus margin) sits above the chips.
    expect(gap).toBeLessThan(200);
  });

  test("no Auto copy reaches the screen", async ({ page }) => {
    await openSeededConversation(page);
    const dialog = await openPicker(page);

    const text = ((await dialog.textContent()) ?? "").toLowerCase();
    for (const word of ["bucket", "cohort", "rollout", "readiness"]) {
      expect(text, `the picker must not name "${word}"`).not.toContain(word);
    }
  });
});

test.describe("Auto is offered", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      autoSelectionOffered: true,
      messages: [
        { id: "qa-m1", role: "user", content: "안녕하세요" },
        {
          id: "qa-m2",
          role: "assistant",
          content: "안녕하세요!",
          modelId: "gpt-5-6-luna",
        },
      ],
    });
  });

  test("the switch appears above the model list and reports its state", async ({
    page,
  }) => {
    await openSeededConversation(page);
    const dialog = await openPicker(page);

    const toggle = dialog.getByTestId("auto-routing-toggle");
    await expect(toggle).toBeVisible();

    const control = toggle.getByRole("switch");
    await expect(control).toHaveAttribute("aria-checked", "false");

    // Above the list, never in it: Auto has no context window, price or
    // provider, and the footer's credit estimate would have nothing to show.
    const chips = dialog.getByTestId("model-picker-selected-list");
    const toggleBox = await toggle.boundingBox();
    const chipsBox = await chips.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(chipsBox).not.toBeNull();
    expect(toggleBox!.y).toBeLessThan(chipsBox!.y);
  });

  test("turning it on stores auto and turning it off stores manual", async ({
    page,
  }) => {
    await openSeededConversation(page);
    const dialog = await openPicker(page);
    const control = dialog.getByTestId("auto-routing-toggle").getByRole("switch");

    await control.click();
    await expect(control).toHaveAttribute("aria-checked", "true");

    await control.click();
    await expect(control).toHaveAttribute("aria-checked", "false");
  });

  test("the copy never promises a better or optimal model", async ({ page }) => {
    // ROUTE-01 measures non-inferiority, a far weaker claim than that copy
    // would be making.
    await openSeededConversation(page);
    const dialog = await openPicker(page);
    const toggle = dialog.getByTestId("auto-routing-toggle");

    const text = ((await toggle.textContent()) ?? "").toLowerCase();
    for (const word of ["better", "best", "optimal", "smartest"]) {
      expect(text, `Auto copy must not promise "${word}"`).not.toContain(word);
    }
  });

  test(
    "the switch stays reachable and legible at 320px and 200% text scaling",
    { tag: "@ui-risk" },
    async ({ page }) => {
      // The composer contract's viewport floor, at the browser-level
      // equivalent of 200% text scaling. Auto sits in the picker sheet rather
      // than in the composer, so it may not push the composer around -- but it
      // still has to survive the same viewport.
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript(() => {
        document.documentElement.style.fontSize = "32px";
      });

      await openSeededConversation(page);
      const dialog = await openPicker(page);
      const toggle = dialog.getByTestId("auto-routing-toggle");
      await expect(toggle).toBeVisible();

      await expectNoHorizontalOverflow(page);

      const box = await toggle.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 1);

      // The switch keeps a real touch target rather than being squeezed to
      // make room for the label.
      const control = toggle.getByRole("switch");
      const controlBox = await control.boundingBox();
      expect(controlBox).not.toBeNull();
      expect(controlBox!.height).toBeGreaterThanOrEqual(20);
      expect(controlBox!.width).toBeGreaterThanOrEqual(36);
    }
  );

  test(
    "the composer keeps its dedicated textarea row while the picker is open",
    { tag: "@ui-risk" },
    async ({ page }) => {
      // The composer contract is a release blocker and Auto is new furniture
      // near it. Nothing about the toggle may narrow, cover or shorten the
      // textarea's row -- including with Korean IME text in it.
      await page.setViewportSize({ width: 320, height: 568 });
      await openSeededConversation(page);

      const textarea = page.getByTestId("chat-textarea");
      await textarea.fill("한글 조합 중인 문장");
      const before = await textarea.boundingBox();
      expect(before).not.toBeNull();

      const dialog = await openPicker(page);
      await expect(dialog.getByTestId("auto-routing-toggle")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      const after = await textarea.boundingBox();
      expect(after).not.toBeNull();
      // The draft survives, and so does the row it sits in.
      await expect(textarea).toHaveValue("한글 조합 중인 문장");
      expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);
      expect(after!.height).toBeGreaterThanOrEqual(before!.height - 1);
      await expectNoHorizontalOverflow(page);
    }
  );
});

test.describe("Auto was offered and no longer is", () => {
  test.beforeEach(async ({ page }) => {
    // The state an account that has left the cohort is in: the conversation is
    // still stored as `auto`, and the server no longer offers it. A PATCH in
    // the same session cannot produce this, which is why the fixture seeds it.
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectionMode: "auto",
      autoSelectionOffered: false,
      messages: [
        { id: "qa-m1", role: "user", content: "안녕하세요" },
        {
          id: "qa-m2",
          role: "assistant",
          content: "안녕하세요!",
          modelId: "gpt-5-6-luna",
        },
      ],
    });
  });

  test("the conversation still opens, and the control is simply gone", async ({
    page,
  }) => {
    // UI contract §5's reasoning: a conversation must not strand its owner in
    // a mode the account can no longer act on. The models stay selectable, so
    // there is always a way back.
    await openSeededConversation(page);
    const dialog = await openPicker(page);

    await expect(dialog.getByTestId("auto-routing-toggle")).toHaveCount(0);
    await expect(dialog.getByTestId("model-picker-selected-list")).toBeVisible();
  });
});
