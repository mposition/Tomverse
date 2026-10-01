import { expect, test } from "@playwright/test";

const ROUTE = "/e2e/prompt-refiner-fixture";
const SOURCE_PROMPT = "원문 질문";

test.describe("Prompt Refiner focus handoff", { tag: "@ui-risk" }, () => {
  test("a bound state on mount does not steal textarea focus", async ({ page }) => {
    await page.goto(`${ROUTE}?initial=ready`);

    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible();
    await expect(page.getByTestId("prompt-refiner-fixture-textarea")).toBeFocused();
  });

  test("a requesting state does not replay focus after draft reappearance", async ({
    page,
  }) => {
    await page.goto(ROUTE);
    const textarea = page.getByTestId("prompt-refiner-fixture-textarea");

    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-requesting")).toBeFocused();
    await textarea.fill(`${SOURCE_PROMPT} x`);
    await expect(page.getByTestId("prompt-refiner-requesting")).toHaveCount(0);
    await textarea.press("Backspace");
    await textarea.press("Backspace");

    await expect(page.getByTestId("prompt-refiner-requesting")).toBeVisible();
    await expect(textarea).toBeFocused();
  });

  test("focus follows genuine arrivals but not a same-state reappearance", async ({
    page,
  }) => {
    await page.goto(ROUTE);
    const textarea = page.getByTestId("prompt-refiner-fixture-textarea");

    await expect(textarea).toBeFocused();
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-requesting")).toBeFocused();

    await page.getByTestId("prompt-refiner-fixture-failed").click();
    await expect(page.getByTestId("prompt-refiner-retry")).toBeFocused();
    await page.getByTestId("prompt-refiner-retry").click();
    await expect(page.getByTestId("prompt-refiner-requesting")).toBeFocused();

    await page.getByTestId("prompt-refiner-fixture-ready").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();

    await textarea.fill(`${SOURCE_PROMPT} x`);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await textarea.press("Backspace");
    await textarea.press("Backspace");

    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible();
    await expect(textarea).toBeFocused();
  });

  test("a blocked failed handoff is retried when the composer unlocks", async ({
    page,
  }) => {
    await page.goto(ROUTE);

    await page.getByTestId("prompt-refiner-request").click();
    await page.getByTestId("prompt-refiner-fixture-lock").click();
    await page.getByTestId("prompt-refiner-fixture-failed").click();
    await expect(page.getByTestId("prompt-refiner-retry")).toBeDisabled();
    await expect(page.getByTestId("prompt-refiner-retry")).not.toBeFocused();

    await page.getByTestId("prompt-refiner-fixture-lock").click();
    await expect(page.getByTestId("prompt-refiner-retry")).toBeFocused();
  });

  test("a blocked handoff expires if its state becomes hidden", async ({ page }) => {
    await page.goto(ROUTE);
    const textarea = page.getByTestId("prompt-refiner-fixture-textarea");

    await page.getByTestId("prompt-refiner-request").click();
    await page.getByTestId("prompt-refiner-fixture-lock").click();
    await page.getByTestId("prompt-refiner-fixture-failed").click();
    await textarea.fill(`${SOURCE_PROMPT} x`);
    await expect(page.getByTestId("prompt-refiner-retry")).toHaveCount(0);
    await textarea.press("Backspace");
    await textarea.press("Backspace");
    await expect(page.getByTestId("prompt-refiner-retry")).toBeVisible();

    await page.getByTestId("prompt-refiner-fixture-lock").click();
    await expect(page.getByTestId("prompt-refiner-retry")).not.toBeFocused();
    await expect(textarea).not.toBeFocused();
    await textarea.focus();
    await expect(textarea).toBeFocused();
  });
});
