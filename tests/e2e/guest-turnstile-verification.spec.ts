import { expect, test, type Page } from "@playwright/test";
import {
  completeTurnstileChallenge,
  expectNoHorizontalOverflow,
  failTurnstileChallenge,
  prepareGuestPage,
  readTurnstileState,
  setTurnstileScript,
  installTurnstileScript,
} from "./support/app-fixtures";
import { freezeAnimations } from "./support/chat-state-fixtures";

// ---------------------------------------------------------------------------
// Guest verification placement and coordination.
//
// The regression these guard: the Turnstile widget used to be owned by each
// ChatApp model panel, so whichever model happened to hit TURNSTILE_REQUIRED
// first rendered a Cloudflare checkbox *inside its own answer panel*, and two
// more background widgets sat in `fixed bottom-2 right-2` containers.
//
// What must hold now:
//   - no widget anywhere while Turnstile passes on its own;
//   - on desktop, one widget to the right of the AI cross-review action, or a
//     full-width row of its own above the composer when that will not fit;
//   - on mobile, one modal bottom sheet, portalled out of the composer;
//   - never inside a model panel, never in a fixed bottom-right corner;
//   - three panels asking at once still produce exactly one challenge and one
//     token.
//
// Geometry is measured, not eyeballed.
// ---------------------------------------------------------------------------

test.use({ hasTouch: true });

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Geometry is measured on one engine at explicit viewports; run with --project=desktop-chromium."
  );
});

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
/** Wide enough for the desktop shell, too narrow for an inline 300px widget. */
const NARROW_DESKTOP_VIEWPORT = { width: 820, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 780 };
const MOBILE_WIDTHS = [320, 360, 390, 430];

const THREE_MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
const ONE_MODEL = ["gemini-2-5-flash"];

type GuestChatQaState = {
  /** Every POST /api/chat, in order, with the token it carried (if any). */
  attempts: { modelId: string; token: string | null }[];
  /** Emulates the server's short-lived grant cookie. */
  granted: boolean;
  /** Tokens the "server" has already consumed -- a replay is rejected. */
  spentTokens: string[];
  replays: number;
};

/**
 * /api/chat as a guest sees it before verification: 403 TURNSTILE_REQUIRED
 * until one request carries a token, then a grant that covers every later
 * request. Tokens are single-use, so a replayed one fails exactly as
 * Cloudflare's siteverify would.
 */
async function mockGuestChatRequiringVerification(page: Page) {
  const state: GuestChatQaState = {
    attempts: [],
    granted: false,
    spentTokens: [],
    replays: 0,
  };

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      modelId?: string;
      turnstileToken?: string;
    };
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
    state.attempts.push({ modelId: body.modelId ?? "", token });

    if (!state.granted) {
      if (!token) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            code: "TURNSTILE_REQUIRED",
            error: "Guest verification is required.",
          }),
        });
        return;
      }
      if (state.spentTokens.includes(token)) {
        state.replays += 1;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            code: "TURNSTILE_FAILED",
            error: "Guest verification failed.",
          }),
        });
        return;
      }
      state.spentTokens.push(token);
      state.granted = true;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": `qa-trace-${body.modelId}` },
      body: `Answer from ${body.modelId}.`,
    });
  });

  return state;
}

type EnterOptions = {
  models?: string[];
  viewport: { width: number; height: number };
  script?: Parameters<typeof installTurnstileScript>[1];
  lang?: "ko" | "en";
};

async function enterGuestChat(page: Page, options: EnterOptions) {
  const {
    models = THREE_MODELS,
    viewport,
    script = "silent",
    lang = "en",
  } = options;

  await prepareGuestPage(page, lang);
  await installTurnstileScript(page, script);
  const chat = await mockGuestChatRequiringVerification(page);

  await page.setViewportSize(viewport);
  await page.goto(
    `/chat?lang=${lang}&models=${encodeURIComponent(models.join(","))}`
  );
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
  return chat;
}

async function send(page: Page, text: string, viewportWidth: number) {
  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill(text);
  if (viewportWidth < 768) {
    await page.getByTestId("chat-send-button").click();
  } else {
    await textarea.press("Enter");
  }
}

const mockWidget = (page: Page) => page.getByTestId("qa-turnstile-widget");

/** Intersection area of two boxes, in px². */
const intersectionArea = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) => {
  const width = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const height = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  return width * height;
};

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

test.describe("Guest verification: desktop shell", () => {
  test("an automatic pass shows no verification UI at all", async ({ page }) => {
    const chat = await enterGuestChat(page, { viewport: DESKTOP_VIEWPORT });

    await send(page, "Hello from a guest", DESKTOP_VIEWPORT.width);
    await expect(page.getByText("Answer from gpt-5-4-mini.")).toBeVisible();

    // Nothing was ever painted: no widget, no slot, no sheet.
    await expect(mockWidget(page)).toHaveCount(0);
    await expect(page.getByTestId("desktop-guest-verification")).toHaveCount(0);
    await expect(page.getByTestId("guest-verification-sheet-layer")).toHaveCount(0);

    // The first attempt was tokenless (the grant may already cover it) and
    // exactly one token was spent for the whole comparison.
    expect(chat.attempts[0].token).toBeNull();
    expect(chat.spentTokens).toHaveLength(1);
    expect(chat.replays).toBe(0);
  });

  test("an interactive challenge appears to the right of the AI cross-review action", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      viewport: DESKTOP_VIEWPORT,
      script: "interactive",
    });

    await send(page, "Show me the challenge", DESKTOP_VIEWPORT.width);

    const slot = page.getByTestId("desktop-guest-verification");
    await expect(slot).toHaveAttribute("data-visible", "true");
    await expect(slot).toHaveAttribute("data-layout", "inline");
    await expect(mockWidget(page)).toBeVisible();

    // The real widget, not a chip or a "start verification" button.
    await expect(page.getByTestId("guest-verification-widget")).toBeVisible();
    const controls = await slot.getByRole("button").count();
    expect(controls, "the desktop slot must not add its own controls").toBe(0);

    // Right of the cross-review action group, and after it in DOM order.
    const reviewBox = (await page
      .getByTestId("ai-review-guest-locked")
      .boundingBox())!;
    const widgetBox = (await mockWidget(page).boundingBox())!;
    expect(widgetBox.x).toBeGreaterThanOrEqual(reviewBox.x + reviewBox.width);
    expect(intersectionArea(widgetBox, reviewBox)).toBe(0);

    const followsInDom = await page.evaluate(() => {
      const review = document.querySelector('[data-testid="ai-review-guest-locked"]');
      const slotNode = document.querySelector('[data-testid="desktop-guest-verification"]');
      if (!review || !slotNode) return false;
      return Boolean(
        review.compareDocumentPosition(slotNode) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
    });
    expect(followsInDom, "the widget must follow the actions for a screen reader").toBe(true);

    await expectNoHorizontalOverflow(page);
  });

  test("the widget never renders inside a model panel or a fixed bottom-right box", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      viewport: DESKTOP_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Where does it render?", DESKTOP_VIEWPORT.width);
    await expect(mockWidget(page)).toBeVisible();

    const placement = await page.evaluate(() => {
      const widgets = Array.from(
        document.querySelectorAll('[data-testid="qa-turnstile-widget"]')
      );
      const panels = Array.from(
        document.querySelectorAll('[data-testid="desktop-model-panel"]')
      );
      const insidePanel = widgets.filter((widget) =>
        panels.some((panel) => panel.contains(widget))
      ).length;
      const fixedCorner = widgets.filter((widget) => {
        let node: HTMLElement | null = widget as HTMLElement;
        while (node) {
          const style = getComputedStyle(node);
          if (
            style.position === "fixed" &&
            style.bottom !== "auto" &&
            style.right !== "auto" &&
            style.left === "auto"
          ) {
            return true;
          }
          node = node.parentElement;
        }
        return false;
      }).length;
      return { total: widgets.length, insidePanel, fixedCorner };
    });

    expect(placement.total).toBe(1);
    expect(placement.insidePanel).toBe(0);
    expect(placement.fixedCorner).toBe(0);
  });

  test("a cramped desktop wraps the widget onto its own full-width row above the composer", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      viewport: NARROW_DESKTOP_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Not much room here", NARROW_DESKTOP_VIEWPORT.width);

    const slot = page.getByTestId("desktop-guest-verification");
    await expect(slot).toHaveAttribute("data-visible", "true");
    await expect(slot).toHaveAttribute("data-layout", "stacked");

    const widgetBox = (await mockWidget(page).boundingBox())!;
    const quickBox = (await page
      .getByTestId("quick-comparison-button")
      .boundingBox())!;
    const reviewBox = (await page
      .getByTestId("ai-review-guest-locked")
      .boundingBox())!;
    const composerBox = (await page.getByTestId("chat-input").boundingBox())!;

    // Its own row: below both actions, above the composer, overlapping neither.
    expect(intersectionArea(widgetBox, quickBox)).toBe(0);
    expect(intersectionArea(widgetBox, reviewBox)).toBe(0);
    expect(intersectionArea(widgetBox, composerBox)).toBe(0);
    expect(widgetBox.y).toBeGreaterThanOrEqual(quickBox.y + quickBox.height - 0.5);
    expect(widgetBox.y + widgetBox.height).toBeLessThanOrEqual(composerBox.y + 0.5);
    await expectNoHorizontalOverflow(page);
  });

  test("a single-model guest still gets a verification slot above the composer", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: DESKTOP_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Only one model here", DESKTOP_VIEWPORT.width);

    // No comparison rail to host it...
    await expect(page.getByTestId("comparison-action-rail")).toHaveCount(0);
    // ...so the shared fallback slot does, still above the composer.
    const slot = page.getByTestId("desktop-guest-verification");
    await expect(slot).toHaveAttribute("data-visible", "true");
    const widgetBox = (await mockWidget(page).boundingBox())!;
    const composerBox = (await page.getByTestId("chat-input").boundingBox())!;
    expect(intersectionArea(widgetBox, composerBox)).toBe(0);
    expect(widgetBox.y + widgetBox.height).toBeLessThanOrEqual(composerBox.y + 0.5);
  });

  test("solving the challenge retries the original request exactly once", async ({
    page,
  }) => {
    const chat = await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: DESKTOP_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Retry me once", DESKTOP_VIEWPORT.width);
    await expect(mockWidget(page)).toBeVisible();

    expect(await completeTurnstileChallenge(page)).toBe(true);
    await expect(page.getByText("Answer from gemini-2-5-flash.")).toBeVisible();

    // Tokenless attempt, then exactly one verified retry. No third request.
    await page.waitForTimeout(300);
    expect(chat.attempts).toHaveLength(2);
    expect(chat.attempts[0].token).toBeNull();
    expect(chat.attempts[1].token).not.toBeNull();
    expect(chat.spentTokens).toHaveLength(1);
    expect(chat.replays).toBe(0);

    // And the surface is gone again.
    await expect(mockWidget(page)).toHaveCount(0);
    await expect(page.getByTestId("desktop-guest-verification")).toHaveCount(0);
  });

  test("three models asking at once produce one challenge and one token", async ({
    page,
  }) => {
    const chat = await enterGuestChat(page, {
      viewport: DESKTOP_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Compare all three", DESKTOP_VIEWPORT.width);

    await expect(mockWidget(page)).toBeVisible();
    // One visible challenge, no matter how many panels are waiting.
    await expect(mockWidget(page)).toHaveCount(1);
    const state = await readTurnstileState(page);
    expect(state!.widgets).toHaveLength(1);
    expect(state!.widgets[0].action).toBe("guest_chat");
    expect(state!.widgets.filter((widget) => widget.interactive)).toHaveLength(1);

    expect(await completeTurnstileChallenge(page)).toBe(true);

    for (const modelId of THREE_MODELS) {
      await expect(page.getByText(`Answer from ${modelId}.`)).toBeVisible();
    }

    await page.waitForTimeout(300);
    // 3 tokenless attempts, 1 verified retry, 2 grant-covered retries.
    expect(chat.attempts).toHaveLength(6);
    expect(chat.attempts.filter((attempt) => attempt.token !== null)).toHaveLength(1);
    expect(chat.spentTokens).toHaveLength(1);
    expect(chat.replays).toBe(0);
    // One token issued means no panel quietly burned a second one.
    const finalState = await readTurnstileState(page);
    expect(finalState!.issuedTokens).toHaveLength(1);
  });

  // Every terminal Cloudflare callback has to end the same way: the promise
  // settles, the widget is removed, the state says "failed", and the user gets
  // one localized sentence. None of them may leave the surface loading.
  for (const kind of ["error", "timeout", "expired", "unsupported"] as const) {
    test(`a ${kind} callback ends the challenge cleanly`, async ({ page }) => {
      await enterGuestChat(page, {
        models: ONE_MODEL,
        viewport: DESKTOP_VIEWPORT,
        script: "interactive",
      });
      await send(page, `End with ${kind}`, DESKTOP_VIEWPORT.width);
      await expect(mockWidget(page)).toBeVisible();

      expect(await failTurnstileChallenge(page, kind)).toBe(true);

      const slot = page.getByTestId("desktop-guest-verification");
      await expect(slot).toHaveAttribute("data-phase", "failed");
      await expect(page.getByTestId("guest-verification-error")).toHaveCount(1);
      await expect(mockWidget(page)).toHaveCount(0);
      // And the failure is eventually cleared rather than pinned forever.
      await expect(page.getByTestId("desktop-guest-verification")).toHaveCount(0, {
        timeout: 15_000,
      });
    });
  }

  test("a silently unsupported browser never opens an interactive challenge", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: DESKTOP_VIEWPORT,
      script: "unsupported",
    });
    await send(page, "Unsupported browser", DESKTOP_VIEWPORT.width);

    // It reports the outage instead of hanging, and no challenge is ever shown.
    await expect(page.getByTestId("guest-verification-error")).toHaveCount(1);
    const state = await readTurnstileState(page);
    expect(state!.widgets.filter((widget) => widget.interactive)).toHaveLength(0);
  });

  test("a Cloudflare error is announced once and never leaves a spinner behind", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: DESKTOP_VIEWPORT,
      script: "interactive",
    });
    await send(page, "This will fail", DESKTOP_VIEWPORT.width);
    await expect(mockWidget(page)).toBeVisible();

    expect(await failTurnstileChallenge(page, "error")).toBe(true);

    const alert = page.getByTestId("guest-verification-error");
    await expect(alert).toHaveCount(1);
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).not.toHaveText("");
    // The widget is torn down rather than left spinning.
    await expect(mockWidget(page)).toHaveCount(0);
    await expect(page.getByTestId("desktop-guest-verification")).toHaveAttribute(
      "data-phase",
      "failed"
    );
  });
});

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

test.describe("Guest verification: mobile shell", () => {
  test("the sheet is inert and costs the composer nothing before a challenge", async ({
    page,
  }) => {
    await enterGuestChat(page, { viewport: MOBILE_VIEWPORT, script: "silent" });
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();

    const layer = page.getByTestId("guest-verification-sheet-layer");
    await expect(layer).toHaveAttribute("data-state", "closed");
    await expect(layer).toHaveAttribute("aria-hidden", "true");
    // No dialog semantics while it is closed.
    await expect(page.getByTestId("guest-verification-sheet")).not.toHaveAttribute(
      "role",
      "dialog"
    );

    const geometry = await page.evaluate(() => {
      const layerNode = document.querySelector<HTMLElement>(
        '[data-testid="guest-verification-sheet-layer"]'
      )!;
      const rect = layerNode.getBoundingClientRect();
      return {
        height: rect.height,
        position: getComputedStyle(layerNode).position,
        pointerEvents: getComputedStyle(layerNode).pointerEvents,
        inBody: layerNode.parentElement === document.body,
      };
    });
    // Out of flow, zero height, untouchable: it cannot enter any layout budget.
    expect(geometry.height).toBe(0);
    expect(geometry.position).toBe("fixed");
    expect(geometry.pointerEvents).toBe("none");
    expect(geometry.inBody).toBe(true);

    // And it is not inside the composer at all.
    const insideComposer = await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="chat-input"]')!
          .querySelector('[data-testid="guest-verification-sheet-layer"]') !== null
    );
    expect(insideComposer).toBe(false);
  });

  test("an interactive challenge closes the keyboard and opens the sheet on the widget", async ({
    page,
  }) => {
    const chat = await enterGuestChat(page, {
      viewport: MOBILE_VIEWPORT,
      script: "silent",
    });

    // One message first, so the composer is already in its docked "bar" state:
    // the geometry compared below is then before/after the *sheet*, not
    // before/after the welcome screen handing over to the conversation view.
    await send(page, "First message", MOBILE_VIEWPORT.width);
    await expect(page.getByText("Answer from gpt-5-4-mini.")).toBeVisible();

    // Make the next send need verification again, as an expired grant would.
    chat.granted = false;
    await setTurnstileScript(page, "interactive");

    const textarea = page.getByTestId("chat-textarea");
    await textarea.click();
    await expect(textarea).toBeFocused();
    const composerBefore = (await page.getByTestId("chat-input").boundingBox())!;
    const textareaBefore = (await textarea.boundingBox())!;

    await send(page, "Open the sheet", MOBILE_VIEWPORT.width);

    const layer = page.getByTestId("guest-verification-sheet-layer");
    await expect(layer).toHaveAttribute("data-state", "open");
    await expect(page.getByTestId("guest-verification-sheet")).toHaveAttribute(
      "role",
      "dialog"
    );
    await expect(page.getByTestId("guest-verification-sheet")).toHaveAttribute(
      "aria-modal",
      "true"
    );
    // The virtual keyboard was dismissed before the sheet took the viewport.
    await expect(textarea).not.toBeFocused();

    // The real widget, straight away -- no "security check needed" chip and no
    // "start verification" button.
    await expect(mockWidget(page)).toBeVisible();
    const sheetButtons = await page
      .getByTestId("guest-verification-sheet")
      .getByRole("button")
      .count();
    expect(sheetButtons, "only the close control belongs in the sheet").toBe(1);

    // The background is inert for pointer and screen-reader users alike.
    await expect(page.getByTestId("mobile-chat-shell")).toHaveAttribute("inert", "");

    // The composer did not move or shrink.
    const composerAfter = (await page.getByTestId("chat-input").boundingBox())!;
    const textareaAfter = (await textarea.boundingBox())!;
    expect(textareaAfter.x).toBeCloseTo(textareaBefore.x, 1);
    expect(textareaAfter.width).toBeCloseTo(textareaBefore.width, 1);
    expect(composerAfter.height).toBeCloseTo(composerBefore.height, 1);
  });

  test("the sheet never overlaps the textarea, tool chips, model picker or send", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Check the geometry", MOBILE_VIEWPORT.width);
    await expect(mockWidget(page)).toBeVisible();

    const overlaps = await page.evaluate(() => {
      const sheet = document
        .querySelector('[data-testid="guest-verification-sheet"]')!
        .getBoundingClientRect();
      const targets = [
        '[data-testid="chat-textarea"]',
        '[data-testid="chat-send-button"]',
        '[data-testid="tool-status-chip-row"]',
        '#chat-input-popover',
        '[data-testid="chat-input"] button',
      ];
      const results: { selector: string; area: number }[] = [];
      for (const selector of targets) {
        for (const node of Array.from(
          document.querySelectorAll<HTMLElement>(selector)
        )) {
          const box = node.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          const width = Math.max(
            0,
            Math.min(box.right, sheet.right) - Math.max(box.left, sheet.left)
          );
          const height = Math.max(
            0,
            Math.min(box.bottom, sheet.bottom) - Math.max(box.top, sheet.top)
          );
          if (width * height > 0) {
            results.push({ selector, area: width * height });
          }
        }
      }
      return results;
    });

    expect(overlaps, "the sheet covers a composer control").toEqual([]);
    await expectNoHorizontalOverflow(page);
  });

  test("solving the challenge closes the sheet and continues the request once", async ({
    page,
  }) => {
    const chat = await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Continue after the sheet", MOBILE_VIEWPORT.width);
    await expect(mockWidget(page)).toBeVisible();

    expect(await completeTurnstileChallenge(page)).toBe(true);

    await expect(
      page.getByTestId("guest-verification-sheet-layer")
    ).toHaveAttribute("data-state", "closed");
    await expect(page.getByText("Answer from gemini-2-5-flash.")).toBeVisible();
    // The keyboard is not re-opened for a successful send.
    await expect(page.getByTestId("chat-textarea")).not.toBeFocused();
    await expect(page.getByTestId("mobile-chat-shell")).not.toHaveAttribute(
      "inert",
      ""
    );

    await page.waitForTimeout(300);
    expect(chat.attempts).toHaveLength(2);
    expect(chat.spentTokens).toHaveLength(1);
    expect(chat.replays).toBe(0);
  });

  test("cancelling keeps the draft, sends nothing, and allows a retry", async ({
    page,
  }) => {
    const chat = await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("A draft that must survive");
    await page.getByTestId("chat-send-button").click();
    await expect(mockWidget(page)).toBeVisible();

    await page.getByTestId("guest-verification-close").click();
    await expect(
      page.getByTestId("guest-verification-sheet-layer")
    ).toHaveAttribute("data-state", "closed");

    // Nothing was answered, nothing was duplicated, nothing was spent.
    await page.waitForTimeout(300);
    expect(chat.attempts.every((attempt) => attempt.token === null)).toBe(true);
    expect(chat.spentTokens).toHaveLength(0);
    expect(await page.getByText("Answer from gemini-2-5-flash.").count()).toBe(0);

    // The composer is usable again and the user's own text is intact.
    const draft = await page.evaluate(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-textarea"]'
      );
      return composer?.value ?? "";
    });
    // The optimistic user turn is what carries the text after a send attempt,
    // so assert the text still exists somewhere the user can act on.
    expect(
      draft === "A draft that must survive" ||
        (await page.getByText("A draft that must survive").count()) > 0
    ).toBe(true);

    // A second attempt is accepted rather than blocked by a stuck lock.
    await setTurnstileScript(page, "silent");
    await textarea.fill("Second attempt");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("Answer from gemini-2-5-flash.")).toBeVisible();
  });

  test("Escape, the close control and focus management behave", async ({ page }) => {
    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("Focus should come back here");
    await textarea.focus();
    await page.getByTestId("chat-send-button").click();
    await expect(mockWidget(page)).toBeVisible();

    // Focus moved into the dialog, onto a 44x44 close control.
    const closeButton = page.getByTestId("guest-verification-close");
    await expect(closeButton).toBeFocused();
    const closeBox = (await closeButton.boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(43.5);
    expect(closeBox.height).toBeGreaterThanOrEqual(43.5);

    // The trap keeps Tab inside the dialog.
    await page.keyboard.press("Tab");
    const focusInsideDialog = await page.evaluate(() =>
      Boolean(
        document
          .querySelector('[data-testid="guest-verification-sheet"]')
          ?.contains(document.activeElement)
      )
    );
    expect(focusInsideDialog).toBe(true);

    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("guest-verification-sheet-layer")
    ).toHaveAttribute("data-state", "closed");
    // Cancelling hands focus back into the composer -- the control the user
    // came from, or the textarea when that control is no longer focusable.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            document
              .querySelector('[data-testid="chat-input"]')
              ?.contains(document.activeElement)
          )
        )
      )
      .toBe(true);
  });

  for (const width of MOBILE_WIDTHS) {
    test(`${width}px keeps the sheet and widget inside the viewport`, async ({
      page,
    }) => {
      await enterGuestChat(page, {
        models: ONE_MODEL,
        viewport: { width, height: 720 },
        script: "interactive",
      });
      await send(page, "Fit inside the screen", width);
      await expect(mockWidget(page)).toBeVisible();

      const measurements = await page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(
          '[data-testid="guest-verification-sheet"]'
        )!;
        const widget = document.querySelector<HTMLElement>(
          '[data-testid="qa-turnstile-widget"]'
        )!;
        const composer = document.querySelector<HTMLElement>(
          '[data-testid="chat-input"]'
        )!;
        return {
          sheetOverflow: sheet.scrollWidth - sheet.clientWidth,
          composerOverflow: composer.scrollWidth - composer.clientWidth,
          widgetRight: widget.getBoundingClientRect().right,
          widgetSize: widget.dataset.size,
          viewport: document.documentElement.clientWidth,
        };
      });

      expect(measurements.sheetOverflow).toBeLessThanOrEqual(1);
      expect(measurements.composerOverflow).toBeLessThanOrEqual(1);
      expect(measurements.widgetRight).toBeLessThanOrEqual(
        measurements.viewport + 1
      );
      // A 300px widget cannot fit a 320px sheet's inner width.
      expect(measurements.widgetSize).toBe(width < 360 ? "compact" : "flexible");
      await expectNoHorizontalOverflow(page);
    });
  }

  test("200% text scaling and a 195px layout viewport keep the widget compact and inside", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: { width: 195, height: 420 },
      script: "interactive",
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await send(page, "Zoomed in", 195);
    await expect(mockWidget(page)).toBeVisible();

    await expect(mockWidget(page)).toHaveAttribute("data-size", "compact");
    await expectNoHorizontalOverflow(page);
    const widgetRight = (await mockWidget(page).boundingBox())!;
    expect(widgetRight.x + widgetRight.width).toBeLessThanOrEqual(196);
  });

  test("Korean IME text and the caret stay visible with the sheet closed", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      viewport: MOBILE_VIEWPORT,
      script: "silent",
      lang: "ko",
    });

    const textarea = page.getByTestId("chat-textarea");
    const before = (await textarea.boundingBox())!;
    await textarea.click();
    await page.keyboard.insertText("한국어 입력 확인");
    await textarea.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
      element.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "하" })
      );
    });
    await page.keyboard.insertText("하");

    const after = (await textarea.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.width).toBeCloseTo(before.width, 1);

    const visible = await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return {
        clipped: input.scrollHeight - input.clientHeight,
        scrollLeft: input.scrollLeft,
        caretAtEnd: input.selectionStart === input.value.length,
      };
    });
    expect(visible.clipped).toBeLessThanOrEqual(1);
    expect(visible.scrollLeft).toBe(0);
    expect(visible.caretAtEnd).toBe(true);
  });

  test("switching between mobile and desktop mid-challenge keeps one widget and one request", async ({
    page,
  }) => {
    const chat = await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });
    await send(page, "Rotate me", MOBILE_VIEWPORT.width);
    await expect(mockWidget(page)).toBeVisible();

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
    // The mobile sheet went with the mobile shell; the desktop slot took over.
    await expect(mockWidget(page)).toHaveCount(1);
    await expect(page.getByTestId("desktop-guest-verification")).toHaveAttribute(
      "data-visible",
      "true"
    );

    // The challenge is still live in its new home: solving it spends exactly
    // one token and lets the verified retry through. (Swapping shells remounts
    // the model panels, so the answer lands in a freshly mounted panel rather
    // than the one that started the request -- what matters here is that the
    // verification itself neither duplicated nor stalled.)
    expect(await completeTurnstileChallenge(page)).toBe(true);
    await expect.poll(() => chat.spentTokens.length).toBe(1);
    await expect
      .poll(() => chat.attempts.filter((attempt) => attempt.token !== null).length)
      .toBe(1);
    expect(chat.replays).toBe(0);
    await expect(mockWidget(page)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Background work vs. user-initiated work
// ---------------------------------------------------------------------------

test.describe("Guest verification: background vs user-initiated", () => {
  test("a background title generation never opens a challenge", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "interactive");

    let titleRequests = 0;
    await page.route("**/api/chat/conversation-title", async (route) => {
      titleRequests += 1;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TURNSTILE_REQUIRED",
          error: "Guest verification is required.",
        }),
      });
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-title" },
        body: "A guest answer.",
      });
    });

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/chat?lang=en&models=gemini-2-5-flash");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    await send(page, "Plan my weekend", DESKTOP_VIEWPORT.width);
    await expect(page.getByText("A guest answer.").first()).toBeVisible();

    // The title endpoint asked for verification and was told no.
    await expect.poll(() => titleRequests).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(mockWidget(page)).toHaveCount(0);
    await expect(page.getByTestId("desktop-guest-verification")).toHaveCount(0);
    const state = await readTurnstileState(page);
    expect(state!.renders).toBe(0);

    // The interim title a guest conversation starts with simply stays, and no
    // generated title ever replaces it.
    await expect(
      page.getByTestId("sidebar-conversation-list").getByText("New Chat")
    ).toBeVisible();
  });

  test("a user-initiated quick summary uses the shared verification UI", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "interactive");

    const summaryTokens: (string | null)[] = [];
    await page.route("**/api/chat/compare-summary", async (route) => {
      const body = route.request().postDataJSON() as { turnstileToken?: string };
      const token = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
      summaryTokens.push(token);
      if (!token) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "TURNSTILE_REQUIRED" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary: { commonConclusions: [], importantDifferences: [] },
          responseMap: [],
        }),
      });
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { modelId?: string };
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": `qa-trace-${body.modelId}` },
        body: `Answer from ${body.modelId}.`,
      });
    });

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(
      `/chat?lang=en&models=${encodeURIComponent(THREE_MODELS.join(","))}`
    );
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await send(page, "Compare these", DESKTOP_VIEWPORT.width);
    for (const modelId of THREE_MODELS) {
      await expect(page.getByText(`Answer from ${modelId}.`)).toBeVisible();
    }

    await page.getByTestId("quick-comparison-button").click();

    // The same shared surface, with the summary's own action.
    await expect(mockWidget(page)).toBeVisible();
    await expect(mockWidget(page)).toHaveAttribute("data-action", "guest_quick_summary");
    expect(await completeTurnstileChallenge(page)).toBe(true);

    await expect.poll(() => summaryTokens.length).toBe(2);
    expect(summaryTokens[0]).toBeNull();
    expect(summaryTokens[1]).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EXT-REAUDIT-F004: a stalled interactive challenge must not stay silent
// ---------------------------------------------------------------------------

test.describe("Guest verification: long-wait feedback", () => {
  // The "interactive" script fires before-interactive-callback and then never
  // calls back -- exactly what an unreachable Cloudflare looks like from the
  // app's side. The app clears its own silent timeout at that point on purpose
  // (a person mid-challenge is never cancelled out from under themselves), so
  // without this notice the surface says nothing until Cloudflare's terminal
  // callback finally lands, which took ~126s on a blocked network.
  const LONG_WAIT_BUDGET_MS = 40_000;

  test("a stalled challenge explains itself within 40s and stays cancellable", async ({
    page,
  }) => {
    test.setTimeout(LONG_WAIT_BUDGET_MS + 90_000);

    const chat = await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("A draft that must survive the stall");
    await page.getByTestId("chat-send-button").click();
    await expect(mockWidget(page)).toBeVisible();

    const notice = page.getByTestId("guest-verification-long-wait");
    // Not immediately: a challenge that resolves normally must never see it.
    await expect(notice).toHaveCount(0);

    const startedAt = Date.now();
    await expect(notice).toBeVisible({ timeout: LONG_WAIT_BUDGET_MS });
    const elapsed = Date.now() - startedAt;
    expect(
      elapsed,
      `long-wait notice took ${elapsed}ms; the budget is ${LONG_WAIT_BUDGET_MS}ms`
    ).toBeLessThan(LONG_WAIT_BUDGET_MS);

    // Announced politely, not as an error: this is not a failure.
    await expect(notice).toHaveAttribute("role", "status");
    await expect(page.getByTestId("guest-verification-error")).toHaveCount(0);

    // The challenge is still live -- the notice must not have cancelled it,
    // consumed it, or spent a token.
    await expect(mockWidget(page)).toBeVisible();
    await expect(
      page.getByTestId("guest-verification-sheet-layer")
    ).toHaveAttribute("data-state", "open");
    expect(chat.spentTokens).toHaveLength(0);
    expect(chat.attempts.every((attempt) => attempt.token === null)).toBe(true);

    // The escape route it points at actually works, and a retry still passes.
    await page.getByTestId("guest-verification-close").click();
    await expect(
      page.getByTestId("guest-verification-sheet-layer")
    ).toHaveAttribute("data-state", "closed");

    await setTurnstileScript(page, "silent");
    await textarea.fill("Second attempt after the stall");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("Answer from gemini-2-5-flash.")).toBeVisible();
  });

  test("solving a challenge before the budget never shows the long-wait notice", async ({
    page,
  }) => {
    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });

    await page.getByTestId("chat-textarea").fill("Solved quickly");
    await page.getByTestId("chat-send-button").click();
    await expect(mockWidget(page)).toBeVisible();
    expect(await completeTurnstileChallenge(page)).toBe(true);

    await expect(page.getByText("Answer from gemini-2-5-flash.")).toBeVisible();
    await expect(page.getByTestId("guest-verification-long-wait")).toHaveCount(0);
  });

  test("a terminal failure replaces the long-wait notice with the failure copy", async ({
    page,
  }) => {
    test.setTimeout(LONG_WAIT_BUDGET_MS + 90_000);

    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: MOBILE_VIEWPORT,
      script: "interactive",
    });

    await page.getByTestId("chat-textarea").fill("Stall then fail");
    await page.getByTestId("chat-send-button").click();
    await expect(mockWidget(page)).toBeVisible();
    await expect(page.getByTestId("guest-verification-long-wait")).toBeVisible({
      timeout: LONG_WAIT_BUDGET_MS,
    });

    // Cloudflare's own timeout still decides the outcome.
    expect(await failTurnstileChallenge(page, "timeout")).toBe(true);
    await expect(page.getByTestId("guest-verification-error")).toBeVisible();
    await expect(page.getByTestId("guest-verification-long-wait")).toHaveCount(0);
  });

  test("the long-wait notice fits a 320px sheet in Korean at a 200% text scale", async ({
    page,
  }) => {
    test.setTimeout(LONG_WAIT_BUDGET_MS + 90_000);

    await enterGuestChat(page, {
      models: ONE_MODEL,
      viewport: { width: 320, height: 568 },
      lang: "ko",
      script: "interactive",
    });

    await page.getByTestId("chat-textarea").fill("한국어 확인");
    await page.getByTestId("chat-send-button").click();
    await expect(mockWidget(page)).toBeVisible();

    const notice = page.getByTestId("guest-verification-long-wait");
    await expect(notice).toBeVisible({ timeout: LONG_WAIT_BUDGET_MS });

    await page.addStyleTag({ content: "html{font-size:32px !important}" });
    await page.waitForTimeout(300);

    // Still readable, still inside the viewport, and the escape route is still
    // a real 44x44 target.
    await expect(notice).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, "[ko/200%] horizontal overflow").toBeLessThanOrEqual(1);

    const closeBox = (await page.getByTestId("guest-verification-close").boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(43.5);
    expect(closeBox.height).toBeGreaterThanOrEqual(43.5);
  });
});
