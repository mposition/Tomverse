import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

type MockStatus = "available" | "limited" | "unavailable";

type StatusRecord = {
  id: string;
  provider: string;
  status: MockStatus;
  fallbackModelIds?: string[];
  fallbackHealth?: "operational" | "degraded" | "none" | "unknown";
};

// The guest default selection, in the order lib/appDefaults resolves it. Every
// "selected" fixture below picks from here and every "non-selected" one
// deliberately avoids it.
const SELECTED = {
  gemini: { id: "gemini-2-5-flash", provider: "google", name: "Gemini 3.1 Flash-Lite" },
  gpt: { id: "gpt-5-4-mini", provider: "openai", name: "GPT-5.4 mini" },
  claude: { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5" },
} as const;

/**
 * Six public models no default selection contains. The guest-plan ones lead:
 * the catalogue shows a plan lock ahead of an outage reason, so only a model a
 * guest could otherwise select proves the outage itself is still disclosed.
 */
const UNSELECTED_SIX: Array<{ id: string; provider: string; name: string }> = [
  { id: "llama-3-1", provider: "groq", name: "Llama 3.1" },
  { id: "grok-3-mini", provider: "xai", name: "Grok 3 Mini" },
  { id: "gemini-3-5-flash", provider: "google", name: "Gemini 3.5 Flash" },
  { id: "llama-3-3", provider: "groq", name: "Llama 3.3" },
  { id: "grok-3", provider: "xai", name: "Grok 3" },
  { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek-V4 Pro" },
];

const unselectedOutage = (count: number): StatusRecord[] =>
  UNSELECTED_SIX.slice(0, count).map((model) => ({
    id: model.id,
    provider: model.provider,
    status: "unavailable" as const,
    fallbackModelIds: ["mistral-medium-3-1"],
    fallbackHealth: "operational" as const,
  }));

/**
 * Serves a fixed snapshot and reports how many times it was asked for. The
 * banner and the model catalogue both read this same route, which is the point:
 * hiding an outage from the workspace must not hide it from the picker.
 */
async function mockProviderStatus(page: Page, models: StatusRecord[]) {
  let requestCount = 0;
  await page.route("**/api/models/status", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models,
      }),
    });
  });
  return () => requestCount;
}

/** Same, but the snapshot can be swapped out between polls. */
async function mockMutableProviderStatus(page: Page, initial: StatusRecord[]) {
  let current = initial;
  let requestCount = 0;
  await page.route("**/api/models/status", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: current,
      }),
    });
  });
  return {
    requestCount: () => requestCount,
    set: (models: StatusRecord[]) => {
      current = models;
    },
  };
}

/**
 * Waits until the status route stops being asked. The catalogue provider
 * reloads the model list after mount, which re-identifies the banner's fetcher
 * and costs one extra poll; a test that flips the snapshot before that lands
 * would race a refresh it never asked for.
 */
async function settleStatusPolls(page: Page, requestCount: () => number) {
  let last = -1;
  while (last !== requestCount()) {
    last = requestCount();
    await page.waitForTimeout(400);
  }
}

async function dismissOnboarding(page: Page) {
  const cta = page.getByRole("button", { name: "Start using Tomverse" });
  if (await cta.isVisible().catch(() => false)) await cta.click();
}

const banner = (page: Page) => page.getByTestId("provider-outage-banner");

async function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

test("limited provider health stays hidden from users", async ({ page }) => {
  await prepareGuestPage(page, "en");
  const requestCount = await mockProviderStatus(page, [
    {
      id: SELECTED.gemini.id,
      provider: SELECTED.gemini.provider,
      status: "limited",
      fallbackModelIds: ["claude-haiku-4-5"],
    },
  ]);

  await page.goto("/chat");
  await expect.poll(requestCount).toBeGreaterThan(0);
  await page.waitForTimeout(150);

  await expect(banner(page)).toHaveCount(0);
  await dismissOnboarding(page);
  await openModelPickerCatalogue(page);
  await expect(page.locator('[title="limited"]')).toHaveCount(0);
});

test("outage remains visible with a fallback suggestion", async ({ page }) => {
  await prepareGuestPage(page, "en");
  // The guest default already includes the GPT/Claude/Gemini brand trio, so
  // the fallback suggestion must be a model outside that trio -- otherwise
  // it's filtered out as "already selected" and no suggestion is shown.
  await mockProviderStatus(page, [
    {
      id: SELECTED.gemini.id,
      provider: SELECTED.gemini.provider,
      status: "unavailable",
      fallbackModelIds: ["deepseek-v4-flash"],
      fallbackHealth: "operational",
    },
  ]);

  await page.goto("/chat");

  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(
    `${SELECTED.gemini.name} is temporarily unavailable`
  );
  await expect(
    banner(page).getByRole("button", {
      name: `Switch ${SELECTED.gemini.name} for DeepSeek-V4 Flash`,
    })
  ).toBeVisible();
});

test("retired models stay out of the user model catalogue", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockProviderStatus(page, [
    {
      id: "gemini-2-5-pro",
      provider: "google",
      status: "unavailable",
      fallbackModelIds: ["gemini-3-1-pro"],
    },
  ]);

  await page.goto("/chat");
  await expect(banner(page)).toHaveCount(0);
  await dismissOnboarding(page);

  const dialog = await openModelPickerCatalogue(page);
  await expect(page.getByText("Gemini 2.5 Pro", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByTestId("model-option").filter({ hasText: "Gemini 3.1 Pro" })
  ).toBeVisible();
});

/**
 * UI-STATUS-002. The workspace banner is scoped to the user's own selection.
 *
 * Before this, any unavailable public model raised a global red warning that
 * said "Some models are currently limited" and "6 unavailable" over a session
 * that was working perfectly, and offered an add-a-model chip that no-ops at
 * the selection cap. These tests pin the disclosure policy from both ends: a
 * non-selected outage costs the workspace nothing, and a selected outage is
 * described precisely enough to act on.
 */
test.describe("contextual outage disclosure (UI-STATUS-002)", () => {
  test("a single non-selected outage does not raise the workspace banner", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    const requestCount = await mockProviderStatus(page, unselectedOutage(1));

    await page.goto("/chat");
    await expect.poll(requestCount).toBeGreaterThan(0);
    await page.waitForTimeout(250);

    await expect(banner(page)).toHaveCount(0);

    // Hidden from the workspace, still fully disclosed where the user chooses.
    await dismissOnboarding(page);
    const dialog = await openModelPickerCatalogue(page);
    const option = dialog.locator(
      `[data-testid="model-option"][data-model-id="${UNSELECTED_SIX[0].id}"]`
    );
    await option.scrollIntoViewIfNeeded();
    await expect(option).toContainText("Temporarily unavailable");
    await expect(option).toBeDisabled();
  });

  test("six non-selected outages cost the workspace no height and no banner", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");

    const measure = async () => {
      const textarea = await page.getByTestId("chat-textarea").boundingBox();
      return {
        textarea: textarea!,
        scrollHeight: await page.evaluate(
          () => document.documentElement.scrollHeight
        ),
        overflow: await horizontalOverflow(page),
      };
    };

    // Baseline: nothing wrong anywhere.
    const healthy = await mockProviderStatus(page, []);
    await page.goto("/chat");
    await expect.poll(healthy).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    const before = await measure();

    await page.unroute("**/api/models/status");
    const outage = await mockProviderStatus(page, unselectedOutage(6));
    await page.goto("/chat");
    await expect.poll(outage).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    const after = await measure();

    await expect(banner(page)).toHaveCount(0);
    expect(after.textarea.y).toBeCloseTo(before.textarea.y, 0);
    expect(after.textarea.height).toBeCloseTo(before.textarea.height, 0);
    expect(after.scrollHeight).toBe(before.scrollHeight);
    expect(after.overflow).toBeLessThanOrEqual(1);
  });

  test("a selected outage names only the selected model, never the global count", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockProviderStatus(page, [
      ...unselectedOutage(6),
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(
      `${SELECTED.gemini.name} is temporarily unavailable`
    );

    const text = (await banner(page).innerText()).toLowerCase();
    // Neither the unrelated models nor the catalogue-wide tally may leak in.
    for (const model of UNSELECTED_SIX) {
      expect(text, `banner must not name ${model.name}`).not.toContain(
        model.name.toLowerCase()
      );
    }
    expect(text).not.toContain("7");
    expect(text).not.toContain("6 unavailable");
    expect(text).not.toContain("limited");
  });

  test("a selected model that is only limited raises no banner", async ({ page }) => {
    await prepareGuestPage(page, "en");
    const requestCount = await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "limited",
        fallbackModelIds: ["deepseek-v4-flash"],
      },
      {
        id: SELECTED.gpt.id,
        provider: SELECTED.gpt.provider,
        status: "limited",
        fallbackModelIds: ["mistral-small-4"],
      },
    ]);

    await page.goto("/chat");
    await expect.poll(requestCount).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    await expect(banner(page)).toHaveCount(0);
  });

  test("two selected outages describe one recovery each, recomputed after the first swap", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gpt.id,
        provider: SELECTED.gpt.provider,
        status: "unavailable",
        fallbackModelIds: ["mistral-small-4"],
        fallbackHealth: "operational",
      },
      {
        id: SELECTED.claude.id,
        provider: SELECTED.claude.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(
      "2 selected models are temporarily unavailable"
    );

    const gptSwap = banner(page).getByRole("button", {
      name: `Switch ${SELECTED.gpt.name} for Mistral Small 4`,
    });
    const claudeSwap = banner(page).getByRole("button", {
      name: `Switch ${SELECTED.claude.name} for DeepSeek-V4 Flash`,
    });
    await expect(gptSwap).toBeVisible();
    await expect(claudeSwap).toBeVisible();
    await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(2);

    await gptSwap.click();

    // The remaining outage is now the only one, so the banner drops to the
    // singular sentence and keeps exactly the one recovery still owed.
    await expect(banner(page)).toContainText(
      `${SELECTED.claude.name} is temporarily unavailable`
    );
    await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(1);
    await expect(claudeSwap).toBeVisible();
    await expect(banner(page)).not.toContainText(SELECTED.gpt.name);
  });

  test("two selected outages never offer the same replacement twice", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    // Both impacted models nominate the same candidate. Offering it twice
    // would let the user take both swaps and end up one model short.
    await mockProviderStatus(page, [
      {
        id: SELECTED.gpt.id,
        provider: SELECTED.gpt.provider,
        status: "unavailable",
        fallbackModelIds: ["mistral-small-4"],
        fallbackHealth: "operational",
      },
      {
        id: SELECTED.claude.id,
        provider: SELECTED.claude.provider,
        status: "unavailable",
        fallbackModelIds: ["mistral-small-4"],
        fallbackHealth: "operational",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(1);
    // The model left without a replacement still gets a real recovery path,
    // and it is named so the two offers cannot be confused.
    await expect(
      banner(page).getByRole("button", {
        name: `Choose another model for ${SELECTED.claude.name}`,
      })
    ).toBeVisible();
  });

  test("with no eligible replacement the banner offers the model picker", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: [],
        fallbackHealth: "none",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(
      "No eligible replacement model is available right now."
    );
    await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(0);

    const choose = banner(page).getByRole("button", { name: "Choose another model" });
    await expect(choose).toBeVisible();

    // Keyboard-operable, and it really opens the picker rather than just
    // telling the user to try again later.
    await choose.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#chat-input-popover")).toBeVisible();
  });

  test("fallback health caveats survive the rescope", async ({ page }) => {
    const cases: Array<{
      health: "operational" | "degraded" | "unknown" | "none";
      expected: string | null;
      forbidden?: string;
    }> = [
      { health: "operational", expected: null },
      {
        health: "degraded",
        expected: "These replacements are also reporting problems right now.",
      },
      {
        health: "unknown",
        expected: "Availability of these replacements could not be verified.",
      },
      { health: "none", expected: "No eligible replacement model is available right now." },
    ];

    await prepareGuestPage(page, "en");
    for (const { health, expected } of cases) {
      await page.unroute("**/api/models/status");
      await mockProviderStatus(page, [
        {
          id: SELECTED.gemini.id,
          provider: SELECTED.gemini.provider,
          status: "unavailable",
          fallbackModelIds: health === "none" ? [] : ["deepseek-v4-flash"],
          fallbackHealth: health,
        },
      ]);
      await page.goto("/chat");
      await expect(banner(page)).toBeVisible();

      if (expected) {
        await expect(banner(page), `health=${health}`).toContainText(expected);
      } else {
        // A healthy replacement is offered without a caveat, and never with
        // one that belongs to a different health verdict.
        await expect(banner(page), `health=${health}`).not.toContainText(
          "could not be verified"
        );
        await expect(banner(page), `health=${health}`).not.toContainText(
          "also reporting problems"
        );
      }

      if (health === "none") {
        await expect(banner(page)).toHaveCount(1);
        await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(0);
      } else {
        await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(1);
      }
    }
  });

  test("a candidate the same snapshot reports down is never offered", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    // The route filters these out before they ship (selectFallbackCandidates),
    // so this is a stale-or-malformed-payload fixture: the banner is holding
    // the evidence that the nominated replacement is itself out, and must not
    // offer a swap straight onto a second outage.
    await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["llama-3-1", "mistral-small-4"],
        fallbackHealth: "operational",
      },
      {
        id: "llama-3-1",
        provider: "groq",
        status: "unavailable",
        fallbackModelIds: [],
        fallbackHealth: "none",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    // It skips the downed candidate and takes the next eligible one rather
    // than giving up on recovery altogether.
    await expect(
      banner(page).getByRole("button", {
        name: `Switch ${SELECTED.gemini.name} for Mistral Small 4`,
      })
    ).toBeVisible();
    await expect(banner(page)).not.toContainText("Llama 3.1");
  });

  test("with every candidate down the banner falls back to the picker", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["llama-3-1"],
        fallbackHealth: "operational",
      },
      {
        id: "llama-3-1",
        provider: "groq",
        status: "unavailable",
        fallbackModelIds: [],
        fallbackHealth: "none",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).getByTestId("provider-status-swap")).toHaveCount(0);
    // fallbackHealth said "operational", but the snapshot says otherwise and
    // the snapshot wins -- so the banner reports no replacement rather than
    // repeating the payload's claim.
    await expect(banner(page)).toContainText(
      "No eligible replacement model is available right now."
    );
    await expect(
      banner(page).getByRole("button", { name: "Choose another model" })
    ).toBeVisible();
  });

  test("one healthy replacement does not vouch for a degraded one", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gpt.id,
        provider: SELECTED.gpt.provider,
        status: "unavailable",
        fallbackModelIds: ["mistral-small-4"],
        fallbackHealth: "operational",
      },
      {
        id: SELECTED.claude.id,
        provider: SELECTED.claude.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "degraded",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    // Each impacted model owns its own replacement now, so a shaky offer next
    // to a healthy one must still be called out rather than averaged away.
    await expect(banner(page)).toContainText(
      "These replacements are also reporting problems right now."
    );
  });

  test("a recovered provider removes the banner without dropping focus", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    const status = await mockMutableProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
    ]);

    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();
    await settleStatusPolls(page, status.requestCount);

    const refresh = banner(page).getByTestId("provider-status-refresh");
    await refresh.focus();
    await expect(refresh).toBeFocused();

    status.set([
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "available",
        fallbackModelIds: [],
      },
    ]);
    await page.keyboard.press("Enter");

    await expect(banner(page)).toHaveCount(0);
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      testId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    expect(active.tag).not.toBe("BODY");
    expect(
      ["mobile-header-model-summary", "composer-model-select", "mobile-model-tab"],
      `focus landed on ${active.testId || active.tag}`
    ).toContain(active.testId);
  });

  test("a swap keeps keyboard focus in the workspace", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
    ]);

    await page.goto("/chat");
    const swap = banner(page).getByTestId("provider-status-swap");
    await expect(swap).toBeVisible();
    await swap.focus();
    await page.keyboard.press("Enter");

    await expect(banner(page)).toHaveCount(0);
    const activeTag = await page.evaluate(
      () => document.activeElement?.tagName ?? ""
    );
    expect(activeTag).not.toBe("BODY");
  });

  test("Korean copy names the impacted selected model", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
      ...unselectedOutage(6),
    ]);

    await page.goto("/chat?lang=ko");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(
      `${SELECTED.gemini.name}을(를) 일시적으로 사용할 수 없습니다`
    );
    await expect(
      banner(page).getByRole("button", {
        name: `${SELECTED.gemini.name}을(를) DeepSeek-V4 Flash(으)로 교체`,
      })
    ).toBeVisible();
    // role="status" carries the sentence as its accessible name, so the
    // announcement is about the user's own model rather than the catalogue.
    await expect(banner(page)).toHaveAccessibleName(
      `${SELECTED.gemini.name}을(를) 일시적으로 사용할 수 없습니다`
    );
  });

  test("Korean copy pluralises without leaking the catalogue count", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockProviderStatus(page, [
      {
        id: SELECTED.gpt.id,
        provider: SELECTED.gpt.provider,
        status: "unavailable",
        fallbackModelIds: ["mistral-small-4"],
        fallbackHealth: "operational",
      },
      {
        id: SELECTED.claude.id,
        provider: SELECTED.claude.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
      ...unselectedOutage(6),
    ]);

    await page.goto("/chat?lang=ko");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(
      "선택한 모델 2개를 일시적으로 사용할 수 없습니다"
    );
  });
});

test("clicking the banner's suggestion swaps the failed model instead of silently failing at the cap", async ({
  page,
}, testInfo) => {
  // Regression test for a reported bug: with 3 models already selected (the
  // max), the banner's suggestion button used to call the plain add/toggle
  // handler, which rejects once at the cap -- so clicking it did nothing at
  // all, and the failed model stayed selected. It must swap instead.
  //
  // desktop-model-panel only exists in DesktopChatShell, so this has always
  // been a desktop-shell assertion; without the guard it fails on the
  // mobile-* projects for that reason alone.
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "The 3-panel cap assertion only applies to the desktop chat shell."
  );
  await mockAuthenticatedApi(page);
  await mockProviderStatus(page, [
    {
      id: SELECTED.gpt.id,
      provider: SELECTED.gpt.provider,
      status: "unavailable",
      fallbackModelIds: ["mistral-small-4"],
      fallbackHealth: "operational",
    },
  ]);

  await page.goto("/chat?lang=en");
  await openModelPickerCatalogue(page);
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();
  await page
    .locator('[data-testid="model-option"][data-model-id="claude-haiku-4-5"]')
    .click();
  // Escape steps back to the recommendations first, then closes the picker.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-input-popover")).toBeHidden();

  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);

  await expect(banner(page)).toBeVisible();
  const swapButton = banner(page).getByRole("button", {
    name: "Switch GPT-5.4 mini for Mistral Small 4",
  });
  await expect(swapButton).toBeVisible();

  await swapButton.click();

  await expect(
    page.locator('[data-testid="desktop-model-panel"][data-model-id="gpt-5-4-mini"]')
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="desktop-model-panel"][data-model-id="mistral-small-4"]')
  ).toBeVisible();
  // Still exactly 3 panels -- the failed model was replaced in place, not
  // just added on top (which the cap would have rejected outright).
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);
});

// UI-TOUCH-001. The outage banner is the recovery path when a selected model
// is down, so on a phone its refresh and its swap/picker chips have to be
// tappable. They were 32x32 and 28px tall. The desktop copy of the same
// banner deliberately keeps its smaller, mouse-appropriate sizing, so both
// directions are asserted here rather than only the one that was failing.
test.describe("outage banner touch targets (UI-TOUCH-001)", () => {
  const MIN_TARGET = 44;
  const TOLERANCE = 0.5;

  async function unavailableSelectedModel(page: Page) {
    await mockProviderStatus(page, [
      {
        id: SELECTED.gemini.id,
        provider: SELECTED.gemini.provider,
        status: "unavailable",
        fallbackModelIds: ["deepseek-v4-flash"],
        fallbackHealth: "operational",
      },
    ]);
  }

  test("compact (phone) banner actions meet 44x44 and hit-test to themselves", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The compact banner is the mobile shell's rendering."
    );
    await prepareGuestPage(page, "en");
    await unavailableSelectedModel(page);

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      // A short viewport: the banner is allowed to exist here because the
      // user's own model is down, but it still must not overflow sideways or
      // stack its actions on top of each other.
      { width: 382, height: 560 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/chat");
      await expect(banner(page)).toBeVisible();
      const label = `[${viewport.width}x${viewport.height}]`;

      const actions = [
        banner(page).getByTestId("provider-status-refresh"),
        // Whichever of the two the banner chose for this state.
        banner(page).getByTestId("provider-status-swap"),
        banner(page).getByTestId("provider-status-choose-model"),
      ];
      let checked = 0;
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const action of actions) {
        const count = await action.count();
        for (let index = 0; index < count; index++) {
          const item = action.nth(index);
          await item.scrollIntoViewIfNeeded();
          const box = (await item.boundingBox())!;
          expect(box.width, `${label} action width`).toBeGreaterThanOrEqual(
            MIN_TARGET - TOLERANCE
          );
          expect(box.height, `${label} action height`).toBeGreaterThanOrEqual(
            MIN_TARGET - TOLERANCE
          );
          // Centre and the four points 22px away must all land on this
          // control, so the 44px box is real rather than a neighbour's.
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          const half = MIN_TARGET / 2 - TOLERANCE;
          for (const [dx, dy] of [
            [0, 0],
            [-half, 0],
            [half, 0],
            [0, -half],
            [0, half],
          ] as Array<[number, number]>) {
            const resolvesToSelf = await item.evaluate((element, [px, py]) => {
              const hit = document.elementFromPoint(px, py);
              return hit === element || Boolean(hit && element.contains(hit));
            }, [cx + dx, cy + dy] as [number, number]);
            expect(
              resolvesToSelf,
              `${label} hit-test at (${dx}, ${dy}) must resolve to this action`
            ).toBe(true);
          }
          boxes.push(box);
          checked += 1;
        }
      }
      expect(checked, `${label} expected the banner to render actions`).toBeGreaterThan(0);

      // No two actions may overlap: growing a chip must not steal its
      // neighbour's taps.
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const overlaps =
            boxes[a].x < boxes[b].x + boxes[b].width &&
            boxes[a].x + boxes[a].width > boxes[b].x &&
            boxes[a].y < boxes[b].y + boxes[b].height &&
            boxes[a].y + boxes[a].height > boxes[b].y;
          expect(overlaps, `${label} banner actions must not overlap`).toBe(false);
        }
      }

      expect(await horizontalOverflow(page), `${label} horizontal overflow`)
        .toBeLessThanOrEqual(1);
    }
  });

  test("selected-outage copy and recovery survive 200% text scaling", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Text scaling is checked on the narrowest shell, where it bites first."
    );
    await prepareGuestPage(page, "en");
    await unavailableSelectedModel(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");
    await expect(banner(page)).toBeVisible();

    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(150);

    // The sentence still reads in full -- no clamp swallowing the model name.
    await expect(banner(page)).toContainText(
      `${SELECTED.gemini.name} is temporarily unavailable`
    );
    const heading = banner(page).locator("p").first();
    const clipped = await heading.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    expect(clipped, "banner sentence must not be clipped at 200%").toBe(false);

    const swap = banner(page).getByTestId("provider-status-swap");
    await swap.scrollIntoViewIfNeeded();
    await expect(swap).toBeVisible();
    const box = (await swap.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET - TOLERANCE);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("desktop banner keeps its original compact sizing", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "This checks the non-touch desktop path specifically."
    );
    await prepareGuestPage(page, "en");
    await unavailableSelectedModel(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/chat");

    const refresh = banner(page).getByTestId("provider-status-refresh");
    await expect(refresh).toBeVisible();
    const box = (await refresh.boundingBox())!;
    expect(
      box.width < MIN_TARGET - TOLERANCE || box.height < MIN_TARGET - TOLERANCE,
      "desktop refresh should not have been enlarged with the mobile fix"
    ).toBe(true);
  });
});

// RECON-OPS-002, re-pointed by UI-STATUS-002.
//
// #152 added this block against the banner's *global* variant: six models the
// user had not selected, reported with three add-a-fallback chips. That variant
// no longer exists -- a non-selected outage does not raise the workspace banner
// at all -- so the fixture is now three *selected* models down with three
// distinct replacements, which is the widest shape this banner can still reach
// (the selection cap is three).
//
// Every assertion #152 established is kept, because each one is about copy and
// geometry rather than about which models were down: the headline says
// "unavailable" and never "limited", the count is one whole translated sentence
// rather than a number glued to a word, a replacement name appears in exactly
// one place in the banner, each action's accessible name states the action, the
// headline is not clipped, the document never scrolls sideways, and every chip
// keeps its own hit area and stays reachable by keyboard and touch.
test.describe("widespread selected outage copy and layout (RECON-OPS-002)", () => {
  const OUTAGE = [
    { model: SELECTED.gpt, replacementId: "mistral-small-4", replacement: "Mistral Small 4" },
    { model: SELECTED.claude, replacementId: "deepseek-v4-flash", replacement: "DeepSeek-V4 Flash" },
    { model: SELECTED.gemini, replacementId: "grok-3-mini", replacement: "Grok 3 Mini" },
  ];
  const REPLACEMENT_NAMES = OUTAGE.map((entry) => entry.replacement);
  // Six unrelated outages. None may be one of the replacements above, and no
  // name may nest inside a name the banner legitimately prints -- "Grok 3" is
  // a substring of "Grok 3 Mini", so a naive absence check on it would fail on
  // correct output. The precondition below makes that trap loud instead of
  // letting a future model rename re-introduce it silently.
  const UNRELATED = [
    { id: "gemini-3-5-flash", provider: "google", name: "Gemini 3.5 Flash" },
    { id: "llama-3-1", provider: "groq", name: "Llama 3.1" },
    { id: "llama-3-3", provider: "groq", name: "Llama 3.3" },
    { id: "mistral-large-3", provider: "mistral", name: "Mistral Large 3" },
    { id: "grok-4", provider: "xai", name: "Grok 4" },
    { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek-V4 Pro" },
  ];
  const NAMES_THE_BANNER_PRINTS = [
    ...REPLACEMENT_NAMES,
    ...OUTAGE.map((entry) => entry.model.name),
  ];

  // The healthy replacements are reported too, and so are six unrelated
  // outages: a count that says "3" has to be counting the user's own failed
  // models rather than the payload, the chips, or the catalogue.
  async function mockWidespreadSelectedOutage(page: Page) {
    await mockProviderStatus(page, [
      ...OUTAGE.map((entry) => ({
        id: entry.model.id,
        provider: entry.model.provider,
        status: "unavailable" as const,
        fallbackModelIds: [entry.replacementId],
        fallbackHealth: "operational" as const,
      })),
      ...OUTAGE.map((entry) => ({
        id: entry.replacementId,
        provider: "qa-healthy",
        status: "available" as const,
        fallbackModelIds: [],
        fallbackHealth: "none" as const,
      })),
      ...UNRELATED.map((model) => ({
        id: model.id,
        provider: model.provider,
        status: "unavailable" as const,
        fallbackModelIds: ["mistral-medium-3-1"],
        fallbackHealth: "operational" as const,
      })),
    ]);
  }

  test("the headline states unavailability as one localized sentence, and replacement names appear only on the buttons", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockWidespreadSelectedOutage(page);
    await page.goto("/chat");

    await expect(banner(page)).toBeVisible();

    // One whole sentence carrying the count, not a headline plus a bare tally.
    await expect(banner(page).getByTestId("provider-status-title")).toHaveText(
      "3 selected models are temporarily unavailable"
    );
    // The old headline described an outage as a throttle.
    await expect(banner(page)).not.toContainText("limited");
    // And the count is not a number glued to a translated word beside an
    // unrelated number of buttons.
    await expect(banner(page)).not.toContainText("3 unavailable");
    // 9 models are down in the snapshot; only the user's 3 may be counted.
    await expect(banner(page)).not.toContainText("9");

    // A healthy replacement needs no caveat, so there is no guidance line to
    // repeat a name into -- the names live in the buttons and nowhere else.
    await expect(banner(page).getByTestId("provider-status-guidance")).toHaveCount(0);

    const swaps = banner(page).getByTestId("provider-status-swap");
    await expect(swaps).toHaveCount(OUTAGE.length);
    const bannerText = await banner(page).innerText();
    for (const [index, entry] of OUTAGE.entries()) {
      // Naming the action, not just the model: the shuffle glyph is decorative
      // and cannot carry "switch" on its own.
      await expect(swaps.nth(index)).toHaveAccessibleName(
        `Switch ${entry.model.name} for ${entry.replacement}`
      );
      expect(
        bannerText.split(entry.replacement).length - 1,
        `${entry.replacement} must appear exactly once in the banner`
      ).toBe(1);
      expect(
        bannerText.split(entry.model.name).length - 1,
        `${entry.model.name} must appear exactly once in the banner`
      ).toBe(1);
    }
    for (const model of UNRELATED) {
      // Precondition, not the assertion: an unrelated name that nests inside a
      // name the banner is supposed to print would make the check below fail
      // on correct output.
      for (const printed of NAMES_THE_BANNER_PRINTS) {
        expect(
          printed.includes(model.name),
          `fixture error: unrelated "${model.name}" nests inside printed "${printed}"`
        ).toBe(false);
      }
      expect(
        bannerText,
        `the banner must not name the unrelated outage ${model.name}`
      ).not.toContain(model.name);
    }

    await expect(banner(page).getByTestId("provider-status-refresh")).toBeVisible();
  });

  test("Korean renders the same copy as whole sentences rather than assembled words", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockWidespreadSelectedOutage(page);
    await page.goto("/chat?lang=ko");

    await expect(banner(page)).toBeVisible();
    // Korean puts the counter after the noun -- a number glued in front of a
    // translated "unavailable" could not produce this.
    await expect(banner(page).getByTestId("provider-status-title")).toHaveText(
      "선택한 모델 3개를 일시적으로 사용할 수 없습니다"
    );

    const swaps = banner(page).getByTestId("provider-status-swap");
    await expect(swaps).toHaveCount(OUTAGE.length);
    for (const [index, entry] of OUTAGE.entries()) {
      await expect(swaps.nth(index)).toHaveAccessibleName(
        `${entry.model.name}을(를) ${entry.replacement}(으)로 교체`
      );
    }

    const bannerText = await banner(page).innerText();
    for (const name of REPLACEMENT_NAMES) {
      expect(
        bannerText.split(name).length - 1,
        `${name} must appear exactly once in the banner`
      ).toBe(1);
    }
  });

  // The bug report arrived as a screenshot whose right edge was cut off, which
  // looks like a missing refresh button or a page overflowing sideways. Neither
  // reproduces: measured here the document never scrolls horizontally and both
  // the banner and its refresh control sit inside the viewport at every width.
  // What does reproduce is the headline being clipped by `truncate`, which is
  // why it wraps -- so these are the measurements that have to keep holding,
  // rather than a shell or useIsMobileShell change made on a hunch.
  test("banner geometry holds at phone widths and on a narrow desktop pointer", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockWidespreadSelectedOutage(page);

    const viewports = testInfo.project.name.startsWith("mobile")
      ? [
          { width: 320, height: 568 },
          { width: 390, height: 844 },
          { width: 430, height: 932 },
        ]
      : [
          // Narrow enough to share the mobile shell's width breakpoint while
          // keeping a fine pointer -- the case useIsMobileShell exists to tell
          // apart, and where the compact desktop sizing must survive.
          { width: 720, height: 800 },
          { width: 1280, height: 800 },
        ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/chat");
      const label = `[${testInfo.project.name} ${viewport.width}x${viewport.height}]`;

      await expect(banner(page)).toBeVisible();
      const refresh = banner(page).getByTestId("provider-status-refresh");
      await expect(refresh).toBeVisible();

      // The suggestion strip is allowed to scroll sideways; the document is
      // not. Measured, not assumed -- this is the claim the screenshot made.
      expect(
        await horizontalOverflow(page),
        `${label} document horizontal overflow`
      ).toBeLessThanOrEqual(1);

      // The defect the screenshot actually contained. `truncate` hid 98px of
      // the headline at 320px and 28px at 390px, so the one sentence saying
      // what was wrong was the first thing cut. It wraps now, and a future
      // `truncate` would fail here rather than pass every copy assertion while
      // showing "3 selected models are temporarily unavai...".
      const headline = await banner(page)
        .getByTestId("provider-status-title")
        .evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
      expect(
        headline.clientWidth,
        `${label} headline must be a measurable box`
      ).toBeGreaterThan(0);
      expect(
        headline.scrollWidth - headline.clientWidth,
        `${label} headline must not be clipped`
      ).toBeLessThanOrEqual(1);

      for (const [name, locator] of [
        ["banner", banner(page)],
        ["refresh", refresh],
      ] as const) {
        const box = (await locator.boundingBox())!;
        expect(box.x, `${label} ${name} left edge`).toBeGreaterThanOrEqual(0);
        expect(
          box.x + box.width,
          `${label} ${name} right edge inside the viewport`
        ).toBeLessThanOrEqual(viewport.width);
      }

      // Every action measured in a single pass, because scrolling the strip
      // between measurements would report the same screen coordinates for
      // different chips and turn a clean row into a phantom overlap.
      const boxes = await banner(page)
        .locator(
          '[data-testid="provider-status-refresh"], [data-testid="provider-status-choose-model"], [data-testid="provider-status-swap"]'
        )
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          })
        );
      expect(boxes.length, `${label} refresh plus one chip per impacted model`).toBe(
        1 + OUTAGE.length
      );

      // UI-TOUCH-001 still holds at the widths added here, in both directions:
      // a phone gets real 44px targets, and the narrow desktop window keeps its
      // mouse-sized ones instead of inheriting the touch floor by width alone.
      for (const [index, box] of boxes.entries()) {
        if (testInfo.project.name.startsWith("mobile")) {
          expect(box.width, `${label} action ${index} width`).toBeGreaterThanOrEqual(
            43.5
          );
          expect(box.height, `${label} action ${index} height`).toBeGreaterThanOrEqual(
            43.5
          );
        } else {
          expect(box.height, `${label} action ${index} height`).toBeLessThan(43.5);
        }
      }

      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const overlaps =
            boxes[a].x < boxes[b].x + boxes[b].width &&
            boxes[a].x + boxes[a].width > boxes[b].x &&
            boxes[a].y < boxes[b].y + boxes[b].height &&
            boxes[a].y + boxes[a].height > boxes[b].y;
          expect(overlaps, `${label} banner actions must not overlap`).toBe(false);
        }
      }

      // Keyboard and touch both have to reach every recovery, including the
      // ones the strip has scrolled past at 320px.
      const swaps = banner(page).getByTestId("provider-status-swap");
      await expect(swaps).toHaveCount(OUTAGE.length);
      for (let index = 0; index < OUTAGE.length; index++) {
        const action = swaps.nth(index);
        await action.focus();
        await expect(
          action,
          `${label} recovery ${index} must take keyboard focus`
        ).toBeFocused();
        await action.scrollIntoViewIfNeeded();
        const reachable = await action.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return hit === element || Boolean(hit && element.contains(hit));
        });
        expect(
          reachable,
          `${label} recovery ${index} must be reachable by touch`
        ).toBe(true);
      }
    }
  });
});
