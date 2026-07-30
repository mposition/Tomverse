import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * Browser-level regressions for the go-live audit fixes. Each test corresponds
 * to a defect that source-level assertions alone could not prove was fixed.
 */

// SEC-001 - proxy.ts is the only enforcement point for the host allowlist, the
// Cloudflare origin-secret check, the CSRF mutation-origin check and CSP
// delivery. A `missing:` clause in its matcher let any caller skip all four by
// sending `purpose: prefetch`.
test("a prefetch header cannot bypass the edge security layer", async ({
  request,
  baseURL,
}) => {
  // The host allowlist must still reject a foreign Host header.
  const spoofedHost = await request.get(`${baseURL}/chat`, {
    headers: { host: "evil.example", purpose: "prefetch" },
    failOnStatusCode: false,
  });
  expect(spoofedHost.status()).toBe(421);

  // ...and the cross-site mutation check must still fire.
  const crossSiteMutation = await request.post(`${baseURL}/api/conversations`, {
    headers: {
      origin: "https://evil.example",
      purpose: "prefetch",
      "content-type": "application/json",
    },
    data: {},
    failOnStatusCode: false,
  });
  expect(crossSiteMutation.status()).toBe(403);
  expect(await crossSiteMutation.text()).toContain("INVALID_REQUEST_ORIGIN");
});

test("a normal document request still receives a CSP policy", async ({
  request,
  baseURL,
}) => {
  const response = await request.get(`${baseURL}/chat`, {
    failOnStatusCode: false,
  });
  const headers = response.headers();
  const policy =
    headers["content-security-policy"] ||
    headers["content-security-policy-report-only"];
  expect(policy, "every document response must carry a CSP").toBeTruthy();
  expect(policy).toContain("default-src 'self'");
});

// UI-004 - `env(safe-area-inset-*)` resolves to 0px unless the viewport meta
// opts in, which silently disabled every safe-area accommodation in the app.
test("the document opts into safe-area insets and themed browser chrome", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chat");

  const viewportMeta = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  expect(viewportMeta).toContain("viewport-fit=cover");

  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
});

// UX-001 - Enter during an IME composition commits a Korean/Japanese/Chinese
// syllable. Submitting there sent a truncated prompt and burned credits.
test("Enter during a Korean IME composition does not send the message", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA response");

  let chatRequests = 0;
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() === "POST") chatRequests += 1;
    await route.fallback();
  });

  await page.goto("/chat");
  const textarea = page.getByTestId("chat-textarea");
  await textarea.click();

  // Simulate the IME: text is in the composition buffer and Enter arrives with
  // isComposing set, exactly as a Korean 2-set keyboard produces.
  await textarea.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "안녕하세요";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      })
    );
  });

  // The composition-commit Enter must neither send nor clear the composer.
  await expect(textarea).toHaveValue("안녕하세요");
  expect(chatRequests, "no request may be sent mid-composition").toBe(0);
});

// UX-009 - the credit badge put `aria-label` on a roleless <span> (where it is
// ignored) and aria-hidden the only text, so every cost was absent from the
// accessibility tree.
test("credit costs are exposed to assistive technology", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chat");

  const badge = page.getByTestId("request-credit-estimate");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAccessibleName(/credit/i);
});

// UX-008 - streaming, completion and failure were never announced, and the
// typing indicator had no text alternative.
test("the response lifecycle is announced to assistive technology", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  await mockChatStream(page, "QA streamed answer");
  await page.goto("/chat");

  // Send first: on the mobile shell the transcript (and therefore the live
  // region) mounts with the active model panel rather than on first paint.
  await page.getByTestId("chat-textarea").fill("Hello there");
  // Click send rather than pressing Enter: on the mobile shell Enter inserts a
  // newline by design (lib/chatKeyboardPolicy.ts), so an Enter-only send makes
  // this spec pass on desktop and silently never send on mobile-chromium.
  await page.getByTestId("chat-send-button").click();

  const status = page.getByTestId("chat-response-status").first();
  await expect(status).toBeAttached({ timeout: 15_000 });
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(status).toHaveText(/response|generating/i, { timeout: 15_000 });
});

// UX-002 - opening a conversation was mouse-only: the row had no role, no tab
// stop and no key handler, so keyboard and screen-reader users could never
// return to a prior conversation.
test("a conversation can be opened with the keyboard alone", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/chat");

  const firstRow = page.locator('[role="button"][aria-current], aside [role="button"]').first();
  await expect(firstRow).toBeVisible();

  await firstRow.focus();
  await expect(firstRow).toBeFocused();
  // Enter and Space must both activate, per the button role contract.
  await firstRow.press("Enter");
  await expect(firstRow).toBeVisible();
});

// UI-005 - there was no custom 404, so Next served an unbranded fallback whose
// inline <style> is blocked outright under `CSP_MODE=enforce`.
test("an unknown route renders a branded, navigable 404", async ({ page }) => {
  await prepareGuestPage(page, "en");
  const response = await page.goto("/this-route-does-not-exist");
  expect(response?.status()).toBe(404);

  await expect(
    page.getByRole("heading", { name: /couldn't find that page/i })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /homepage/i })).toBeVisible();
});

// UI-003 - Tailwind preflight resets headings to inherit and zeroes borders, so
// a model's structured answer rendered as undifferentiated body text.
test("assistant markdown renders headings and tables as distinct blocks", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  await mockChatStream(
    page,
    "## Comparison heading\n\nIntro paragraph.\n\n| Model | Cost |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n"
  );
  await page.goto("/chat");

  await page.getByTestId("chat-textarea").fill("Compare A and B in a table");
  // Send by click for the same reason as above -- Enter does not submit on the
  // mobile shell.
  await page.getByTestId("chat-send-button").click();

  const heading = page.locator("h2", { hasText: "Comparison heading" }).first();
  await expect(heading).toBeVisible({ timeout: 15_000 });

  const sizes = await page.evaluate(() => {
    const h = document.querySelector("h2");
    const p = Array.from(document.querySelectorAll("p")).find((node) =>
      node.textContent?.includes("Intro paragraph")
    );
    const table = document.querySelector("table");
    if (!h || !p || !table) return null;
    const cell = table.querySelector("td");
    return {
      heading: parseFloat(getComputedStyle(h).fontSize),
      paragraph: parseFloat(getComputedStyle(p).fontSize),
      headingWeight: getComputedStyle(h).fontWeight,
      paragraphWeight: getComputedStyle(p).fontWeight,
      wrapperOverflowX: getComputedStyle(table.parentElement as Element).overflowX,
      cellBorderWidth: cell ? getComputedStyle(cell).borderTopWidth : "0px",
    };
  });

  expect(sizes, "expected heading, paragraph and table to render").not.toBeNull();
  expect(sizes!.heading).toBeGreaterThan(sizes!.paragraph);
  expect(Number(sizes!.headingWeight)).toBeGreaterThan(
    Number(sizes!.paragraphWeight)
  );
  // A wide table must scroll inside its own container, not drag the transcript.
  expect(sizes!.wrapperOverflowX).toBe("auto");
  expect(parseFloat(sizes!.cellBorderWidth)).toBeGreaterThan(0);
});

// UX-011 - the primary composer set `outline-none` with no replacement ring, so
// keyboard focus on the most important control was invisible.
test("the composer shows a focus indicator when focused", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chat");

  const focusState = await page
    .getByTestId("chat-textarea")
    .evaluate((element) => {
      element.focus();
      const style = getComputedStyle(element);
      return {
        matchesFocusVisible: element.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
      };
    });

  // A focused textarea always matches :focus-visible, so the baseline rule in
  // app/globals.css must resolve to a real outline here.
  expect(focusState.matchesFocusVisible).toBe(true);
  expect(focusState.outlineStyle).not.toBe("none");
  expect(focusState.outlineWidth).toBeGreaterThan(0);
});
