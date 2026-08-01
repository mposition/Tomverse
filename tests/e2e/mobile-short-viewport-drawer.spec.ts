import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { setRootFontSize } from "./support/chat-state-fixtures";
import {
  closeOnScreenKeyboard,
  openOnScreenKeyboard,
  readVisualViewport,
} from "./support/ui-audit";

/**
 * SHORT-VIEWPORT-001.
 *
 * On a mobile browser whose *visible* height is under ~620 CSS px -- a short
 * device, a short window, dynamic browser chrome, a raised keyboard, or a
 * rotated phone -- the chat sidebar drawer used to clip its own account footer.
 * The measured cause was not a hidden element and not horizontal overflow: the
 * drawer's fixed chrome (245px) plus the conversation list's `min-h-[10rem]`
 * floor plus the account footer (up to 253px) need about 658px, and the only
 * scroller in the panel was the conversation list, which does not contain the
 * footer. At 382x560 the guest analytics/cookie button's box was 542..582 with
 * the viewport ending at 560: invisible, un-tappable, and with a list scroll
 * range of 0 there was no scroll path to it at all.
 *
 * What these tests hold to, and why each assertion is the shape it is:
 *
 * - Reachability is measured after a real scroll, from the control's centre
 *   point, with `elementFromPoint` -- `toBeAttached()` and a programmatic
 *   `.click()` both passed on the broken build.
 * - The drawer must have exactly one scroll owner at these heights. A list that
 *   keeps its own scroller while the drawer scrolls too is the nested trap the
 *   contract forbids, so the list's own scroll range is asserted to be 0 here.
 * - Nothing may be solved by shrinking a target below 44px, hiding a control,
 *   or letting the page behind the drawer scroll instead.
 */

const MIN_TARGET = 44;
const TOUCH_TOLERANCE = 0.5;

type DrawerControl = {
  label: string;
  locator: Locator;
  /**
   * The height floor this control must keep. Where the product already ships a
   * 44px box it stays 44px; the rest carry the height they measure *today* at
   * the normal-height reference (390x844 -- see the recorded baseline in
   * .github/audits/short-viewport-drawer-2026-07-30.md), which every short
   * viewport in this matrix also measures.
   *
   * The point of the recorded value is not to bless it. Four drawer controls
   * are below 44px before this change and stay exactly as tall after it: the
   * chat search field and organizer toggle (36px rows), the language `<select>`
   * (an 18px control inside a 40px row) and the account/feedback buttons
   * (40px). Making a short viewport work must never be paid for by shaving
   * them, and a later change that does still fails here.
   */
  minHeight?: number;
};

const seedGuestConversations = async (page: Page, count: number) => {
  await page.addInitScript((total) => {
    const conversations = Array.from({ length: total }, (_, index) => ({
      id: `short_viewport_${index}`,
      title: `Short viewport conversation ${index + 1}`,
      selectedModels: ["gpt-5-4-mini"],
      disabledPanels: [],
      webSearchMode: "off",
      // A fixed epoch: Date.now() would make the seeded order depend on when
      // the suite happens to run.
      createdAt: new Date(1767225600000 - index * 1000).toISOString(),
    }));
    window.localStorage.setItem("guest_conversations", JSON.stringify(conversations));
    for (const conversation of conversations) {
      window.localStorage.setItem(
        `guest_messages_${conversation.id}_gpt-5-4-mini`,
        JSON.stringify([
          { id: "u1", role: "user", content: "Hello", status: "normal" },
          { id: "a1", role: "assistant", content: "Hi.", status: "normal" },
        ])
      );
    }
  }, count);
};

const setOrganizerPreference = async (page: Page, value: "expanded" | "collapsed") => {
  await page.addInitScript((preference) => {
    window.localStorage.setItem("tomverse_sidebar_organizer_v1", preference);
  }, value);
};

const openDrawer = async (page: Page) => {
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await page.getByTestId("mobile-sidebar-open").click();
  const drawer = page.getByTestId("mobile-sidebar-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
};

/**
 * Every control the audit requires to stay reachable, in the state it is
 * actually rendered in. Guests get a usage card, an inline login button and the
 * inline analytics/cookie entry point; an account gets the account card whose
 * menu carries sign-out and analytics settings. Asking for the wrong set is how
 * a matrix silently stops covering one of them, so the shape is chosen by the
 * fixture, not by the viewport.
 */
const drawerControls = (page: Page, mode: "guest" | "authenticated"): DrawerControl[] => {
  const drawer = page.getByTestId("mobile-sidebar-drawer");
  const shared: DrawerControl[] = [
    {
      label: "close",
      locator: drawer.getByRole("button", { name: /^(Cancel|취소)$/ }).last(),
    },
    { label: "new chat", locator: drawer.getByTestId("sidebar-new-chat") },
    {
      label: "chat search",
      locator: drawer.locator("input[placeholder]").first(),
      minHeight: 36,
    },
    {
      label: "organizer tools",
      locator: drawer.getByTestId("sidebar-organizer-toggle"),
      minHeight: 36,
    },
    {
      label: "conversation item",
      locator: drawer.getByTestId("sidebar-conversation-item").first(),
    },
    {
      label: "conversation menu",
      locator: drawer
        .getByTestId("sidebar-conversation-item")
        .first()
        .getByRole("button")
        .last(),
    },
    {
      label: "feedback",
      locator: drawer.getByTestId("sidebar-feedback-button"),
      minHeight: 40,
    },
  ];

  if (mode === "guest") {
    return [
      ...shared,
      { label: "guest usage", locator: drawer.getByTestId("sidebar-upgrade-card") },
      {
        label: "language control",
        locator: drawer.locator("select").first(),
        minHeight: 16,
      },
      // REAUDIT-P1-02: both were 40px and carried an explicit exemption here.
      // They now hold the same 44px floor as the rest of the drawer, so no
      // `minHeight` override remains to hide a regression.
      {
        label: "login",
        locator: drawer.getByTestId("sidebar-account-controls").getByRole("button").first(),
      },
      {
        label: "analytics cookie settings",
        locator: drawer.getByTestId("guest-analytics-cookie-settings"),
      },
    ];
  }

  return [
    ...shared,
    {
      label: "account menu trigger",
      locator: drawer.getByTestId("account-menu-trigger"),
      minHeight: 40,
    },
  ];
};

/**
 * One evaluate for every number the audit asks to be kept as evidence. Read
 * before any scrolling, so "initial" boxes are genuinely initial.
 */
const readDrawerGeometry = async (page: Page, labels: string[]) =>
  page.evaluate((controlLabels) => {
    const rectOf = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
      };
    };
    const scrollerOf = (element: Element | null) =>
      element
        ? {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: Math.round(element.scrollTop),
            range: element.scrollHeight - element.clientHeight,
            overflowY: getComputedStyle(element).overflowY,
          }
        : null;
    const panel = document.querySelector('[data-testid="mobile-sidebar-drawer"]');
    const aside = document.querySelector('[data-testid="chat-sidebar"]');
    const list = document.querySelector('[data-testid="sidebar-conversation-list"]');
    const footer = document.querySelector('[data-testid="sidebar-account-controls"]')
      ?.parentElement;
    return {
      innerHeight: window.innerHeight,
      documentClientHeight: document.documentElement.clientHeight,
      visualHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
      visualOffsetTop: Math.round(window.visualViewport?.offsetTop ?? 0),
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollTop: Math.round(
        document.scrollingElement?.scrollTop ?? document.body.scrollTop
      ),
      safeAreaBottom: Math.round(
        Number.parseFloat(getComputedStyle(panel!).paddingBottom) || 0
      ),
      panel: rectOf(panel),
      sidebar: rectOf(aside),
      sidebarScroll: scrollerOf(aside),
      list: rectOf(list),
      listScroll: scrollerOf(list),
      footer: rectOf(footer ?? null),
      controls: controlLabels,
    };
  }, labels);

const saveGeometry = async (
  testInfo: TestInfo,
  name: string,
  payload: Record<string, unknown>
) => {
  const output = resolve(
    testInfo.project.outputDir,
    "short-viewport-drawer",
    `${name}.json`
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(payload, null, 2));
  await testInfo.attach(`${name}.json`, {
    path: output,
    contentType: "application/json",
  });
};

/**
 * The completion criterion. A control passes only if, after being scrolled the
 * way a user reaching for it would, its centre is inside the *visible* viewport
 * and a hit-test at that centre lands on the control or one of its children.
 */
const expectReachableAndTappable = async (
  page: Page,
  control: DrawerControl,
  context: string
) => {
  const label = `${context} / ${control.label}`;
  await expect(control.locator, `${label}: must stay in the DOM`).toHaveCount(1);
  await control.locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" })
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  );
  const box = await control.locator.boundingBox();
  expect(box, `${label}: expected a visible box`).not.toBeNull();
  const metrics = await readVisualViewport(page);
  const visibleTop = metrics.offsetTop;
  const visibleBottom = metrics.offsetTop + metrics.visualHeight;
  const centreX = box!.x + box!.width / 2;
  const centreY = box!.y + box!.height / 2;
  expect(
    centreY,
    `${label}: centre above the visible viewport (${Math.round(centreY)} < ${Math.round(visibleTop)})`
  ).toBeGreaterThanOrEqual(visibleTop);
  expect(
    centreY,
    `${label}: centre below the visible viewport (${Math.round(centreY)} > ${Math.round(visibleBottom)})`
  ).toBeLessThanOrEqual(visibleBottom);
  const hit = await control.locator.evaluate(
    (element, [x, y]) => {
      const target = document.elementFromPoint(x as number, y as number);
      return {
        hitsSelf: Boolean(target) && (target === element || element.contains(target)),
        description: target
          ? `${target.tagName.toLowerCase()}${
              target.getAttribute("data-testid")
                ? `[data-testid=${target.getAttribute("data-testid")}]`
                : ""
            }`
          : "null",
      };
    },
    [centreX, centreY]
  );
  expect(
    hit.hitsSelf,
    `${label}: centre point hit ${hit.description} instead of the control`
  ).toBe(true);
  expect(box!.height, `${label}: touch target height`).toBeGreaterThanOrEqual(
    (control.minHeight ?? MIN_TARGET) - TOUCH_TOLERANCE
  );
  return {
    label: control.label,
    box: {
      top: Math.round(box!.y),
      bottom: Math.round(box!.y + box!.height),
      height: Math.round(box!.height),
      width: Math.round(box!.width),
    },
    hit: hit.description,
  };
};

/** The whole drawer stays inside the visible viewport, top and bottom. */
const expectPanelInsideVisibleViewport = async (page: Page, context: string) => {
  const geometry = await readDrawerGeometry(page, []);
  const visibleBottom = geometry.visualOffsetTop + geometry.visualHeight;
  expect(
    geometry.panel!.top,
    `${context}: drawer starts above the visible viewport`
  ).toBeGreaterThanOrEqual(geometry.visualOffsetTop - 1);
  expect(
    geometry.panel!.bottom,
    `${context}: drawer ends below the visible viewport`
  ).toBeLessThanOrEqual(visibleBottom + 1);
  return geometry;
};

const expectSingleScrollOwner = async (page: Page, context: string) => {
  const geometry = await readDrawerGeometry(page, []);
  const sidebar = geometry.sidebarScroll!;
  // Whatever the drawer overflows by has to be scrollable somewhere. A panel
  // taller than its own content is fine and needs no scroller at all.
  const overflows = geometry.sidebar!.height < sidebar.scrollHeight - 1;
  if (overflows) {
    expect(
      ["auto", "scroll"],
      `${context}: the drawer overflows by ${
        sidebar.scrollHeight - geometry.sidebar!.height
      }px with no way to scroll it`
    ).toContain(sidebar.overflowY);
  }
  if (sidebar.range > 0) {
    // The drawer scrolls, so the list must not be a second, competing scroller.
    expect(
      geometry.listScroll!.range,
      `${context}: conversation list still owns a nested scroll range while the drawer scrolls`
    ).toBe(0);
  }
  return geometry;
};

const expectNoHorizontalOverflowInDrawer = async (page: Page, context: string) => {
  const overflow = await page.evaluate(() => {
    const aside = document.querySelector('[data-testid="chat-sidebar"]')!;
    return {
      document:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      drawer: aside.scrollWidth - aside.clientWidth,
    };
  });
  expect(overflow.document, `${context}: document scrolls horizontally`).toBeLessThanOrEqual(1);
  expect(overflow.drawer, `${context}: drawer scrolls horizontally`).toBeLessThanOrEqual(1);
};

const SHORT_VIEWPORTS = [
  { width: 320, height: 480, note: "smallest supported portrait" },
  { width: 360, height: 520, note: "browser chrome / keyboard shrink" },
  { width: 382, height: 560, note: "reported repro" },
  { width: 320, height: 568, note: "existing minimum baseline" },
  { width: 390, height: 568, note: "existing minimum baseline" },
  { width: 568, height: 320, note: "short landscape" },
  { width: 667, height: 375, note: "fold cover / landscape" },
] as const;

test.describe("SHORT-VIEWPORT-001: mobile drawer on a short viewport", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The sidebar drawer only exists in the mobile shell."
    );
  });

  for (const viewport of SHORT_VIEWPORTS) {
    for (const state of [
      { mode: "guest", lang: "en", theme: "light", conversations: 1 },
      { mode: "guest", lang: "ko", theme: "dark", conversations: 3 },
      { mode: "authenticated", lang: "en", theme: "dark", conversations: 1 },
    ] as const) {
      const name = `${state.mode}-${state.lang}-${viewport.width}x${viewport.height}`;

      test(`every drawer control is reachable and tappable: ${name} @ui-risk`, async ({
        page,
      }, testInfo) => {
        await prepareGuestPage(page, state.lang);
        if (state.mode === "authenticated") {
          await mockAuthenticatedApi(page);
        } else {
          await seedGuestConversations(page, state.conversations);
        }
        await page.addInitScript((theme) => {
          window.localStorage.setItem("tomverse_theme_preference", theme);
        }, state.theme);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/chat?lang=${state.lang}`);
        await openDrawer(page);

        const initial = await expectPanelInsideVisibleViewport(page, name);
        await expectNoHorizontalOverflowInDrawer(page, name);

        const controls = drawerControls(page, state.mode);
        const before = await Promise.all(
          controls.map(async (control) => ({
            label: control.label,
            initialBox: await control.locator.boundingBox(),
          }))
        );

        // Reachability first, and only then the structural rule that produces
        // it: a build that strands the account footer should say so in the
        // words of the user who cannot reach it, not in the words of a missing
        // `overflow-y`.
        const after = [];
        for (const control of controls) {
          after.push(await expectReachableAndTappable(page, control, name));
        }
        await expectSingleScrollOwner(page, name);

        // Reaching the footer must not have scrolled the page behind the drawer.
        const settled = await readDrawerGeometry(page, []);
        expect(settled.bodyScrollTop, `${name}: page behind the drawer scrolled`).toBe(
          initial.bodyScrollTop
        );
        await expectNoHorizontalOverflowInDrawer(page, `${name} after scrolling`);

        // The bottom safe area stays as free space below the drawer's content.
        const panelBottomGap =
          initial.visualOffsetTop + initial.visualHeight - initial.panel!.bottom;
        expect(
          panelBottomGap + initial.safeAreaBottom,
          `${name}: bottom safe area was consumed`
        ).toBeGreaterThanOrEqual(initial.safeAreaBottom - 1);

        await saveGeometry(testInfo, name, {
          viewport,
          state,
          initial,
          controlsBefore: before,
          controlsAfterScroll: after,
          finalSidebarScroll: settled.sidebarScroll,
        });
        await testInfo.attach(`${name}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
    }
  }

  test("the drawer scroll range actually reaches its end at 382x560 @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 1);
    await page.setViewportSize({ width: 382, height: 560 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    const sidebar = page.getByTestId("chat-sidebar");
    const range = await sidebar.evaluate(
      (element) => element.scrollHeight - element.clientHeight
    );
    expect(range, "the reported repro must need a real scroll").toBeGreaterThan(0);

    const reached = await sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return Math.round(element.scrollTop);
    });
    expect(reached, "the drawer must scroll all the way to its end").toBe(range);

    // At the end of the scroll the last control is fully on screen, not merely
    // intersecting by a pixel.
    const feedback = page.getByTestId("sidebar-feedback-button");
    const box = (await feedback.boundingBox())!;
    const metrics = await readVisualViewport(page);
    expect(box.y + box.height).toBeLessThanOrEqual(
      metrics.offsetTop + metrics.visualHeight + 1
    );
  });

  test("a long conversation list does not strand the account footer @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 24);
    await page.setViewportSize({ width: 382, height: 560 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    await expectSingleScrollOwner(page, "long list");
    for (const control of drawerControls(page, "guest")) {
      await expectReachableAndTappable(page, control, "long list");
    }
  });

  test("organizer expanded keeps every control reachable at 320x480 @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await setOrganizerPreference(page, "expanded");
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    await expect(page.getByTestId("sidebar-organizer-content")).toBeVisible();
    await expectSingleScrollOwner(page, "organizer expanded");
    await expectNoHorizontalOverflowInDrawer(page, "organizer expanded");
    for (const control of drawerControls(page, "guest")) {
      await expectReachableAndTappable(page, control, "organizer expanded");
    }
  });

  test("200% root text scaling keeps every control reachable @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await page.setViewportSize({ width: 382, height: 560 });
    await page.goto("/chat?lang=en");
    await setRootFontSize(page, 32);
    await openDrawer(page);

    await expectSingleScrollOwner(page, "200% text");
    await expectNoHorizontalOverflowInDrawer(page, "200% text");
    for (const control of drawerControls(page, "guest")) {
      await expectReachableAndTappable(page, control, "200% text");
    }
  });

  test("keyboard focus never lands outside the visible viewport @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await page.setViewportSize({ width: 382, height: 560 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    // The drawer traps Tab, so a full cycle visits every focusable control in
    // it. Each stop has to be on screen with its focus ring intact.
    const seen = new Set<string>();
    let firstKey: string | null = null;
    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return null;
        const drawer = document.querySelector('[data-testid="mobile-sidebar-drawer"]');
        const rect = element.getBoundingClientRect();
        const visualHeight = window.visualViewport?.height ?? window.innerHeight;
        const visualTop = window.visualViewport?.offsetTop ?? 0;
        const intersection =
          Math.max(
            0,
            Math.min(rect.bottom, visualTop + visualHeight) - Math.max(rect.top, visualTop)
          ) * rect.width;
        return {
          key: `${element.tagName}:${element.getAttribute("data-testid") ?? ""}:${
            element.textContent?.trim().slice(0, 24) ?? ""
          }`,
          insideDrawer: Boolean(drawer && drawer.contains(element)),
          intersection: Math.round(intersection),
          area: Math.round(rect.width * rect.height),
        };
      });
      if (!focus) continue;
      expect(focus.insideDrawer, `focus escaped the drawer: ${focus.key}`).toBe(true);
      if (focus.area === 0) continue;
      expect(
        focus.intersection,
        `focused control is outside the visible viewport: ${focus.key}`
      ).toBeGreaterThan(0);
      seen.add(focus.key);
      // The trap cycles, so returning to where the walk started means every
      // focusable control in the drawer has been visited exactly once.
      if (firstKey === null) firstKey = focus.key;
      else if (focus.key === firstKey) break;
    }
    expect(seen.size, "expected the drawer to expose focusable controls").toBeGreaterThan(5);
  });

  test("shrinking the height with the drawer open keeps every control reachable @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    for (const height of [844, 560, 480]) {
      await page.setViewportSize({ width: 390, height });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
      );
      const context = `resize to 390x${height}`;
      await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
      await expectPanelInsideVisibleViewport(page, context);
      await expectSingleScrollOwner(page, context);
      for (const control of drawerControls(page, "guest")) {
        await expectReachableAndTappable(page, control, context);
      }
    }
  });

  test("rotating to landscape with the drawer open keeps every control reachable @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    // 667x375, not 844x390: past 767px wide the app swaps the whole mobile
    // shell for the desktop one (ChatPageClient's `(max-width: 767px)` query),
    // so a wider landscape would be testing a different component.
    await page.setViewportSize({ width: 667, height: 375 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    await expectPanelInsideVisibleViewport(page, "landscape");
    await expectSingleScrollOwner(page, "landscape");
    for (const control of drawerControls(page, "guest")) {
      await expectReachableAndTappable(page, control, "landscape");
    }
  });

  test("a raised on-screen keyboard keeps every control reachable @ui-risk", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    // The layout viewport keeps its full height on iOS Safari and Android
    // Chrome's default mode, so this is the case a `100dvh` panel cannot see.
    await openOnScreenKeyboard(page, 320);
    const metrics = await readVisualViewport(page);
    expect(metrics.visualHeight).toBeLessThan(metrics.layoutHeight);

    for (const control of drawerControls(page, "guest")) {
      await expectReachableAndTappable(page, control, "keyboard raised");
    }
    await closeOnScreenKeyboard(page);
  });

  test("dismissal semantics survive the scroll rework @ui-risk", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 2);
    await page.setViewportSize({ width: 382, height: 560 });
    await page.goto("/chat?lang=en");

    const opener = page.getByTestId("mobile-sidebar-open");
    await openDrawer(page);
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Escape closes and returns focus to whatever opened the drawer.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mobile-sidebar-drawer")).toHaveCount(0);
    await expect(opener).toBeFocused();

    // The backdrop still dismisses, even after the drawer has been scrolled.
    await openDrawer(page);
    await page
      .getByTestId("chat-sidebar")
      .evaluate((element) => (element.scrollTop = element.scrollHeight));
    await page.mouse.click(370, 300);
    await expect(page.getByTestId("mobile-sidebar-drawer")).toHaveCount(0);

    // And so does the close button.
    await openDrawer(page);
    await page
      .getByTestId("mobile-sidebar-drawer")
      .getByRole("button", { name: /^(Cancel|취소)$/ })
      .last()
      .click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toHaveCount(0);
  });

  test("a normal-height viewport keeps its pinned footer and list scroller @ui-risk", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestConversations(page, 24);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?lang=en");
    await openDrawer(page);

    const geometry = await readDrawerGeometry(page, []);
    // No regression at a normal height: the drawer itself does not scroll, the
    // conversation list is still the scroller, and the footer is still pinned to
    // the bottom of the panel.
    expect(geometry.sidebarScroll!.range, "the drawer must not need scrolling here").toBe(0);
    expect(
      geometry.listScroll!.range,
      "the conversation list must still own its scroll here"
    ).toBeGreaterThan(0);
    expect(Math.abs(geometry.footer!.bottom - geometry.panel!.bottom)).toBeLessThanOrEqual(1);

    for (const control of drawerControls(page, "guest")) {
      await expectReachableAndTappable(page, control, "390x844");
    }
    await saveGeometry(testInfo, "guest-en-390x844-pinned", { geometry });
  });
});
