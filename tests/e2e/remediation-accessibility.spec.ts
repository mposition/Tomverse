import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockPublicProofMetrics,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * RECON-A11Y-001, RECON-A11Y-002 and RECON-A11Y-003 were reported as axe
 * findings with node counts, but nothing in the suite ran axe, so nothing
 * could confirm a fix or catch a regression. This file runs the same engine
 * the audit did and asserts on the rules those findings name -- and, for the
 * two that are about a specific control, on the property a screen-reader user
 * actually depends on rather than only on the rule ID.
 */

// Resolved from the repo root, which is where Playwright runs. `addScriptTag`
// takes a filesystem path, so the bundled build is injected directly rather
// than pulled from a CDN -- tests/e2e/block-external-network.cjs would refuse
// the request anyway.
const AXE_PATH = "node_modules/axe-core/axe.min.js";

type AxeViolation = {
  id: string;
  impact: string | null;
  nodes: { target: string[]; failureSummary?: string }[];
};

// The shape this file actually consumes. axe-core ships its own types, but
// importing them into the browser-side evaluate callback is not worth the
// bundling for the three fields read here.
type AxeResultNode = { target: string[]; failureSummary?: string };
type AxeResultViolation = {
  id: string;
  impact?: string;
  nodes: AxeResultNode[];
};
type AxeApi = {
  run: (
    context: unknown,
    options: unknown
  ) => Promise<{ violations: AxeResultViolation[] }>;
};

async function runAxe(
  page: Page,
  options: { include?: string; rules: string[] }
): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(
    async ({ include, rules }) => {
      const axe = (window as unknown as { axe: AxeApi }).axe;
      const result = await axe.run(
        include ? { include: [[include]] } : document,
        {
          runOnly: { type: "rule", values: rules },
          resultTypes: ["violations"],
        }
      );
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
    },
    options
  );
}

const summarize = (violations: AxeViolation[]) =>
  violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}) x${violation.nodes.length}: ${violation.nodes
          .slice(0, 4)
          .map((node) => node.target.join(" "))
          .join(" | ")}`
    )
    .join("\n");

test.describe("RECON-A11Y-001: desktop panel model selects", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Per-panel <select> controls only render in the desktop chat shell."
    );
  });

  for (const lang of ["en", "ko"] as const) {
    test(`[${lang}] every panel select has its own accessible name`, async ({
      page,
    }) => {
      await prepareGuestPage(page, lang);
      await mockAuthenticatedApi(page, {
        selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5", "claude-sonnet-5"],
      });
      await page.goto(`/chat?lang=${lang}`);
      await openRecentConversation(page);

      const selects = page.locator('[data-testid="desktop-model-panel"] select');
      await expect(selects).toHaveCount(3);

      // The visible text of each select is the model name it currently holds,
      // so before the fix a screen reader announced three indistinguishable
      // "combo box"es -- and picking the wrong panel's model spends credits.
      const names: string[] = [];
      for (let index = 0; index < 3; index++) {
        const name = await selects.nth(index).evaluate((element) =>
          element.getAttribute("aria-label")
        );
        expect(name, `panel ${index} accessible name`).toBeTruthy();
        names.push(name as string);
      }
      expect(new Set(names).size, `duplicate names: ${names.join(", ")}`).toBe(3);

      // The name identifies the panel, not the model, so it must survive the
      // user changing that panel's model.
      await selects.first().selectOption("gemini-2-5-flash");
      await expect(
        page.getByTestId("desktop-model-panel").first()
      ).toHaveAttribute("data-model-id", "gemini-2-5-flash");
      expect(
        await selects.first().evaluate((element) => element.getAttribute("aria-label"))
      ).toBe(names[0]);

      const violations = await runAxe(page, {
        rules: ["select-name", "aria-prohibited-attr"],
      });
      expect(violations, summarize(violations)).toEqual([]);
    });
  }
});

test.describe("RECON-A11Y-002: pricing comparison scroll region", () => {
  for (const lang of ["en", "ko"] as const) {
    test(`[${lang}] the comparison table is reachable and named for keyboard users`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await prepareGuestPage(page, lang);
      await mockPublicProofMetrics(page);
      await page.goto(`/pricing?lang=${lang}`);

      const region = page.getByRole("region", {
        name: lang === "ko" ? /플랜 비교표/ : /Plan comparison table/,
      });
      await expect(region).toBeVisible();

      // At 390px the region hides ~436px of the Pro and Max columns, and it
      // held no focusable element of its own -- keyboard-only visitors could
      // not reach them at all.
      const hidden = await region.evaluate(
        (element) => element.scrollWidth - element.clientWidth
      );
      expect(hidden, "the region really is scrolling horizontally").toBeGreaterThan(100);

      await region.focus();
      await expect(region).toBeFocused();

      // Arrow keys, not End -- on a scroll container End goes to the bottom,
      // not to the right edge. The whole hidden width has to be reachable,
      // not just the first screenful of it, so this keeps stepping until the
      // Max column is on screen or the region stops responding.
      const scrollLeft = () =>
        region.evaluate((element) => element.scrollLeft);
      for (let step = 0; step < 120; step++) {
        if ((await scrollLeft()) >= hidden) break;
        await page.keyboard.press("ArrowRight");
      }
      // Polled rather than read straight after the last press: the scroll can
      // be animated, so the value settles a frame or two later. The assertion
      // itself is unchanged -- the far column has to be fully reachable.
      await expect
        .poll(scrollLeft, { timeout: 5_000, message: "keyboard reached the far column" })
        .toBe(hidden);

      const violations = await runAxe(page, {
        rules: ["scrollable-region-focusable"],
      });
      expect(violations, summarize(violations)).toEqual([]);

      // The region must not have traded keyboard access for page overflow.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return Math.max(0, doc.scrollWidth - doc.clientWidth);
      });
      expect(overflow, "document overflow").toBeLessThanOrEqual(1);
    });
  }
});

/**
 * RECON-A11Y-003 was reported as 70 contrast nodes on /status, 27 on /pricing
 * and 4 on /, all measured at a SHA whose product code differs from the gate
 * SHA and with no raw artifact handed over. This runs the same rule at the
 * gate SHA so the finding is either reproduced with current numbers or
 * recorded as not reproducible -- rather than "fixed" by changing colours no
 * measurement asked for.
 */
test.describe("RECON-A11Y-003: colour contrast at the gate SHA", () => {
  for (const route of ["/", "/pricing", "/status"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      test(`[${scheme}] ${route} meets AA for contrast`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await prepareGuestPage(page, "en");
        await mockPublicProofMetrics(page);
        await page.goto(`${route}?lang=en`);
        await page.waitForLoadState("networkidle").catch(() => undefined);

        const violations = await runAxe(page, { rules: ["color-contrast"] });
        const nodeCount = violations.reduce(
          (total, violation) => total + violation.nodes.length,
          0
        );
        console.log(
          `RECON-A11Y-003 ${route} (${scheme}): ${nodeCount} contrast nodes\n${summarize(violations)}`
        );
        expect(violations, summarize(violations)).toEqual([]);
      });
    }
  }
});
