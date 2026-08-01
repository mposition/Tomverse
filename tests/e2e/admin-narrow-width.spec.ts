import { expect, test, type Page } from "@playwright/test";

/**
 * The admin console at narrow widths and at 200% text scaling.
 *
 * The defect this exists to close: `<input type="datetime-local">` has an
 * intrinsic width that a CSS grid item, whose default is `min-width: auto`,
 * refuses to shrink below. Three admin panels own one -- customer security
 * controls, the privacy request queue and the operational readiness
 * checkpoints -- and the page scrolled sideways at 320px with no visible cause.
 *
 * Nothing here may be satisfied by hiding the overflow: a clipped control is
 * asserted as a failure through `elementFromPoint`, not merely through a
 * bounding box.
 */

const FIXTURE = "/e2e/admin-console-fixture?view=narrow&state=pendingDeletion";

const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "390x844", width: 390, height: 844 },
] as const;

const ROOT_FONT_SIZES = [
  { name: "16px", px: 16 },
  // The browser-level equivalent of 200% text scaling.
  { name: "32px", px: 32 },
] as const;

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const PRIVACY_ROWS = {
  requests: [
    {
      id: "qa-privacy-1",
      userId: "qa-target-user",
      email: "customer@example.test",
      requestType: "deletion",
      status: "open",
      dueAt: "2026-09-01T09:00:00.000Z",
      legalHold: false,
      legalHoldReason: null,
      note: null,
      completedAt: null,
      handledByEmail: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
    },
  ],
  nextCursor: null,
};

const READINESS_ROWS = {
  checkpoints: [
    {
      key: "qa-restore-drill",
      name: "Database restore drill",
      status: "warning",
      observedAt: "2026-07-01T09:00:00.000Z",
      nextDueAt: "2026-09-01T09:00:00.000Z",
      detail: null,
      evidenceUrl: null,
      updatedByEmail: null,
      updatedAt: "2026-07-01T09:00:00.000Z",
      overdue: false,
      defaultDueDays: 90,
    },
  ],
};

/**
 * The fixture page mounts the real panels, which fetch on mount. Their
 * responses are controlled here, at the network, so nothing on the server is
 * relaxed for the test.
 */
async function mockAdminPanelData(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/admin/privacy-requests",
    (route) => route.fulfill(json(PRIVACY_ROWS))
  );
  await page.route(
    (url) => url.pathname === "/api/admin/operational-checkpoints",
    (route) => route.fulfill(json(READINESS_ROWS))
  );
}

async function openFixture(page: Page, rootFontPx: number) {
  await page.addInitScript((size) => {
    // Set before first paint so the whole page lays out at this scale, which
    // is what a browser-level text-size setting actually does.
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.fontSize = `${size}px`;
    });
  }, rootFontPx);
  const response = await page.goto(FIXTURE);
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByTestId("admin-user-security-controls")).toBeVisible();
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size}px`;
  }, rootFontPx);
}

/** Every element wider than the viewport that is not an opt-in scroller. */
async function horizontalOffenders(page: Page) {
  return page.evaluate(() => {
    const documentWidth = document.documentElement.clientWidth;
    const offenders: Array<{ tag: string; testId: string; className: string; right: number }> = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right <= documentWidth + 0.5 && box.left >= -0.5) continue;
      // A wrapper that declares its own horizontal scroll is allowed to be
      // wider than the viewport -- that is the documented escape for tables.
      const scrollable = element.closest<HTMLElement>(
        '[data-allows-horizontal-scroll="true"], .overflow-x-auto, .overflow-x-scroll'
      );
      if (scrollable && scrollable !== element) continue;
      offenders.push({
        tag: element.tagName,
        testId: element.getAttribute("data-testid") || "",
        className: String(element.className).slice(0, 80),
        right: Math.round(box.right),
      });
    }
    // Text can overflow without any element box leaving the viewport -- a long
    // unbreakable word in a heading is the usual cause at 200% text scaling,
    // and it grows scrollWidth while every getBoundingClientRect() stays in
    // bounds. Ranges are the only way to see it.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = (node.textContent || "").trim();
      const parent = node.parentElement;
      if (text && parent) {
        const style = window.getComputedStyle(parent);
        // Deliberately clipped text (`truncate`) is not page overflow.
        if (style.overflowX !== "hidden" && style.overflowX !== "clip") {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.right > documentWidth + 0.5) {
            offenders.push({
              tag: `TEXT in ${parent.tagName}`,
              testId: parent.getAttribute("data-testid") || "",
              className: String(parent.className).slice(0, 80),
              right: Math.round(rect.right),
            });
          }
        }
      }
      node = walker.nextNode();
    }
    return { documentWidth, offenders: offenders.slice(0, 10) };
  });
}

/**
 * Scrolls a control to the middle of the viewport before measuring it.
 *
 * A minimal scroll parks the control under the console's 64px sticky header,
 * so the element at its centre point is the header -- and the measurement then
 * reports "blocked" about something that is not what is being tested. Centring
 * clears the header on every viewport in this matrix.
 */
async function centreInViewport(locator: ReturnType<Page["locator"]>) {
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" })
  );
}

for (const viewport of VIEWPORTS) {
  for (const rootFont of ROOT_FONT_SIZES) {
    test(`admin console never scrolls sideways at ${viewport.name} with a ${rootFont.name} root font`, async ({
      page,
    }) => {
      await mockAdminPanelData(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openFixture(page, rootFont.px);

      const { documentWidth, offenders } = await horizontalOffenders(page);
      expect(
        offenders,
        `elements overflowing ${documentWidth}px: ${JSON.stringify(offenders)}`
      ).toEqual([]);

      const overflow = await page.evaluate(() => {
        const clientWidth = document.documentElement.clientWidth;
        const widest = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .map((element) => ({
            tag: element.tagName,
            className: String(element.className).slice(0, 70),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          }))
          .filter((entry) => entry.scrollWidth > entry.clientWidth + 0.5)
          .slice(0, 6);
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth,
          widest,
        };
      });
      expect(
        overflow.scrollWidth,
        `document scrolls sideways; inner scrollers: ${JSON.stringify(overflow.widest)}`
      ).toBeLessThanOrEqual(overflow.clientWidth);
    });

    test(`every admin datetime-local fits its section at ${viewport.name} with a ${rootFont.name} root font`, async ({
      page,
    }) => {
      await mockAdminPanelData(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openFixture(page, rootFont.px);

      const inputs = page.locator('input[type="datetime-local"]');
      // Security controls, the privacy request queue and one readiness
      // checkpoint -- the three admin surfaces that own one.
      await expect(inputs).toHaveCount(3);

      const clientWidth = await page.evaluate(
        () => document.documentElement.clientWidth
      );
      const count = await inputs.count();
      for (let index = 0; index < count; index += 1) {
        const input = inputs.nth(index);
        await centreInViewport(input);
        const box = await input.boundingBox();
        expect(box, `datetime-local #${index} has no box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(-0.5);
        expect(
          box!.x + box!.width,
          `datetime-local #${index} runs past the viewport`
        ).toBeLessThanOrEqual(clientWidth + 0.5);

        // And inside the section that owns it, so it is not merely clipped.
        const fits = await input.evaluate((element) => {
          const section = element.closest("section, article, details, form, div");
          if (!section) return { inside: false, reason: "no owning section" };
          const inputBox = element.getBoundingClientRect();
          const sectionBox = section.getBoundingClientRect();
          return {
            inside: inputBox.right <= sectionBox.right + 0.5,
            reason: `${Math.round(inputBox.right)} vs ${Math.round(sectionBox.right)}`,
          };
        });
        expect(
          fits.inside,
          `datetime-local #${index} overflows its section (${fits.reason})`
        ).toBe(true);
      }
    });

    test(`admin controls stay reachable at their centre point at ${viewport.name} with a ${rootFont.name} root font`, async ({
      page,
    }) => {
      await mockAdminPanelData(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openFixture(page, rootFont.px);

      for (const testId of [
        "admin-security-reason",
        "admin-security-until",
        "admin-security-ticket",
        "admin-security-restore",
        "admin-security-toggle-ai",
        "admin-security-revoke-sessions",
      ]) {
        const control = page.getByTestId(testId);
        await centreInViewport(control);
        const box = await control.boundingBox();
        expect(box, `${testId} has no bounding box`).not.toBeNull();
        const owns = await page.evaluate(
          ({ point, id }) => {
            const element = document.elementFromPoint(point.x, point.y);
            return Boolean(element?.closest(`[data-testid="${id}"]`));
          },
          {
            point: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
            id: testId,
          }
        );
        expect(owns, `${testId} is not the element at its own centre`).toBe(true);
      }
    });
  }
}

test("a long error toast wraps instead of widening the page, and blocks no control", async ({
  page,
}) => {
  await mockAdminPanelData(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await openFixture(page, 16);

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("tomverse:toast", {
        detail: {
          message:
            "The \"restore_account\" action does not accept an expiry. Clear the control expiry field and retry the restoration, then confirm the support ticket reference is still attached.",
          tone: "error",
        },
      })
    );
  });
  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();

  const { documentWidth, offenders } = await horizontalOffenders(page);
  expect(
    offenders,
    `elements overflowing ${documentWidth}px with a toast up: ${JSON.stringify(offenders)}`
  ).toEqual([]);

  for (const testId of [
    "admin-security-reason",
    "admin-security-until",
    "admin-security-restore",
  ]) {
    const control = page.getByTestId(testId);
    await centreInViewport(control);
    const box = await control.boundingBox();
    const hit = await page.evaluate(
      ({ point, id }) => {
        const element = document.elementFromPoint(point.x, point.y);
        return {
          owns: Boolean(element?.closest(`[data-testid="${id}"]`)),
          blocker: element
            ? `${element.tagName}.${String(element.className).slice(0, 60)}`
            : "nothing",
        };
      },
      {
        point: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
        id: testId,
      }
    );
    expect(
      hit.owns,
      `${testId} was blocked at its centre point by ${hit.blocker}`
    ).toBe(true);
  }
});
