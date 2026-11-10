import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const theme of ["light", "dark"] as const) {
  test(`Korean home model notes retain readable contrast in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.goto("/ko");
    const notes = page.getByText("한곳에서 선택", { exact: true }).filter({ visible: true });
    await expect(notes).toHaveCount(3, { timeout: 30_000 });
    for (const note of await notes.all()) {
      await expect(note).toBeVisible();
      const sample = await expectAccessibleContrast(note, `${theme} model note`);
      expect(sample.ratio).toBeGreaterThanOrEqual(4.5);
      console.log(`${theme} model note contrast: ${sample.ratio.toFixed(2)}:1`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileNote = page.getByTestId("launch-mobile-model-note");
    await expect(mobileNote).toBeVisible();
    const mobileSample = await expectAccessibleContrast(mobileNote, `${theme} mobile model note`);
    expect(mobileSample.ratio).toBeGreaterThanOrEqual(4.5);
  });
}
