import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * The landing page's content contract.
 *
 * The audit in .github/audits/insight-homepage-content-audit-2026-07-30.md
 * found that roughly 40% of the landing copy had been translated into seven
 * locales while rendering nowhere, and that the four capabilities which make
 * the product more than "several answers at once" were absent from the page
 * entirely. Nothing caught either, because no spec asserted what the landing
 * page says -- the marketing specs covered language switching, the status
 * link and the consent banner, and stopped there.
 *
 * So this file asserts on structure, not prose: section ids, test ids,
 * condition keywords, CTA destinations, and the phrases that must never come
 * back. Rewording a paragraph must not break it; deleting a section must.
 *
 * ## Updated for landing V2
 *
 * V2 merged eight sections into five, because three of the eight retold the
 * hero demonstration and two more pairs answered one question in two scroll
 * stops. This file follows the merge rather than freezing the old shape:
 *
 * - `ai-review` folded into `how-it-works`. The section that owned it existed
 *   to repeat the loop and then describe AI Review; the loop is told once now
 *   and AI Review's output, modes, dual reviewer and boundary are all in
 *   `how-it-works`. The assertions that lived on `landing-proof-section` are
 *   below, on `landing-loop-section`.
 * - `model-catalogue` folded into `trust`. Both answered "what am I getting
 *   and can I rely on it", so the catalogue is the block at the top of the
 *   trust section. Its own test ids (`landing-models-cta`,
 *   `landing-status-cta`, `landing-provider-count`, `landing-provider-list`)
 *   are all unchanged, because the block is unchanged in what it claims.
 * - `landing-guest-note` is gone and `landing-hero-signup-note` carries the
 *   single guest promise. V1 stated "no sign-up required" twice in the hero,
 *   once above the CTA and once below it, in near-identical words. The
 *   promise itself is still asserted here, and still must not be qualified.
 * - `landing-workflow-disclosure` moved from the retired workflow diagram to
 *   the hero demonstration, which is the illustration it now describes.
 *
 * Two things it deliberately does NOT assert: that the hero qualifies its
 * guest-start note, and that the "How it works" steps mark file attachments
 * or AI Review as account-only. Guest access to both is real, so this page
 * must not describe them as locked -- the last two tests here guard that from
 * the other direction.
 */

const SECTION_IDS = [
  "how-it-works",
  "evidence",
  "after-comparison",
  "trust",
  "pricing",
] as const;

const openLanding = async (page: Page, path: "/" | "/ko") => {
  await prepareGuestPage(page, path === "/ko" ? "ko" : "en");
  await page.goto(path);
  await expect(page.getByTestId("landing-hero-title")).toBeVisible();
};

for (const path of ["/", "/ko"] as const) {
  test(`${path} renders every landing section in the intended order`, async ({
    page,
  }) => {
    await openLanding(page, path);

    for (const id of SECTION_IDS) {
      await expect(page.locator(`section#${id}`)).toHaveCount(1);
    }

    // The narrative order: what it does, how you check it, what happens next,
    // what you are getting and can rely on, what it costs.
    const order = await page.$$eval("main section[id]", (sections) =>
      sections.map((section) => section.id)
    );
    expect(order).toEqual([...SECTION_IDS]);

    // The retired anchors must not come back silently: a second section
    // telling the same story is the defect V2 removed.
    await expect(page.locator("section#ai-review")).toHaveCount(0);
    await expect(page.locator("section#model-catalogue")).toHaveCount(0);
  });

  test(`${path} introduces the quick difference summary`, async ({ page }) => {
    await openLanding(page, path);

    const card = page.getByTestId("landing-quick-summary-card");
    await expect(card).toBeVisible();
    // It is offered as the fast read, never as a replacement for AI Review.
    await expect(page.getByTestId("landing-quick-summary-condition")).toBeVisible();
    const text = (await card.innerText()).toLowerCase();
    expect(text).not.toContain("instead of ai review");
    expect(text).not.toContain("ai review 대신");
  });

  test(`${path} introduces web search, Deep Research and source grounding with their conditions`, async ({
    page,
  }) => {
    await openLanding(page, path);

    await expect(page.getByTestId("landing-evidence-section")).toBeVisible();
    for (const testId of [
      "landing-web-search-card",
      "landing-deep-research-card",
      "landing-source-grounding-card",
      "landing-item-verification-card",
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    // Deep Research is a paid-tier feature; the page must say so where it
    // advertises it, not only on /pricing.
    const deepResearch = await page.getByTestId("landing-deep-research-card").innerText();
    expect(deepResearch).toMatch(/Pro/);

    // Source grounding measures quote matching. Presenting it as an accuracy
    // or truth score would be a stronger claim than the product makes.
    const grounding = (
      await page.getByTestId("landing-source-grounding-card").innerText()
    ).toLowerCase();
    expect(grounding).toMatch(
      path === "/ko" ? /사실 정확도나 주장이 참일 확률이 아닙니다/ : /not factual accuracy/
    );
  });

  test(`${path} explains the separate web check without weakening the review boundary`, async ({
    page,
  }) => {
    await openLanding(page, path);

    const boundary = await page.getByTestId("landing-review-boundary").innerText();
    // The boundary itself is accurate about the generation step and stays.
    expect(boundary).toMatch(
      path === "/ko" ? /제공된 답변끼리만 비교/ : /compares only the supplied answers/
    );
    // ...but it no longer reads as "Tomverse cannot check anything".
    expect(boundary).toMatch(path === "/ko" ? /웹 확인/ : /web check/);
  });

  test(`${path} renders the support, catalogue and trust sections`, async ({
    page,
  }) => {
    await openLanding(page, path);

    await expect(page.getByTestId("landing-support-section")).toBeVisible();
    await expect(page.getByTestId("landing-catalogue-block")).toBeVisible();
    await expect(page.getByTestId("landing-trust-section")).toBeVisible();

    // The catalogue is a block inside the trust section now, not a section of
    // its own. It must still actually be there.
    await expect(
      page.locator("section#trust").getByTestId("landing-catalogue-block")
    ).toHaveCount(1);

    // Recovered dead copy has to actually reach the page, CTAs included.
    await expect(page.getByTestId("landing-models-cta")).toHaveAttribute(
      "href",
      "/models"
    );
    await expect(page.getByTestId("landing-status-cta")).toHaveAttribute(
      "href",
      "/status"
    );
    await expect(page.getByTestId("landing-safety-cta")).toHaveAttribute(
      "href",
      "/safety"
    );
    await expect(page.getByTestId("landing-signup-cta")).toHaveAttribute(
      "href",
      "/auth/signin?callbackUrl=%2Fchat"
    );

    // The provider count is derived from the catalogue, not written by hand.
    const declared = await page
      .getByTestId("landing-evidence-section")
      .getAttribute("data-provider-count");
    expect(Number(declared)).toBeGreaterThan(1);
    const providerNote = await page.getByTestId("landing-provider-count").innerText();
    expect(providerNote).toContain(String(declared));
  });

  test(`${path} states the account condition on account-only features only`, async ({
    page,
  }) => {
    await openLanding(page, path);

    const accountPattern = path === "/ko" ? /계정이 필요합니다/ : /Account required/i;

    // Projects, sharing and Model Finder genuinely need an account today.
    const support = await page.getByTestId("landing-support-section").innerText();
    expect(support).toMatch(accountPattern);

    // Attachments must not be described as account-only: guests can attach
    // files (one per message, ephemeral) since the guest attachment work
    // landed.
    const lower = support.toLowerCase();
    expect(lower).not.toContain("log in to attach");
    expect(lower).not.toContain("첨부는 로그인");
  });

  test(`${path} does not resurface the superseded walkthrough capture`, async ({
    page,
  }) => {
    await openLanding(page, path);

    // The 2026-07-27 recording showed "4 credits used" (superseded two days
    // later) and "Review confidence" (renamed to source grounding).
    await expect(page.locator("main video")).toHaveCount(0);
    const main = await page.locator("main").innerText();
    expect(main).not.toContain("4 credits used");
    expect(main).not.toContain("Review confidence");

    // The disclosure now sits under the hero demonstration, which is the
    // illustration it describes.
    const disclosure = await page
      .getByTestId("landing-workflow-disclosure")
      .innerText();
    expect(disclosure).not.toMatch(/Real product UI/i);
    expect(disclosure).toMatch(path === "/ko" ? /설명용 도식/ : /Illustrative/i);
  });

  test(`${path} drops the unguaranteed file-analysis outcome claims`, async ({
    page,
  }) => {
    await openLanding(page, path);

    const main = await page.locator("main").innerText();
    expect(main.toLowerCase()).not.toContain("source-linked");
    expect(main).not.toContain("근거와 연결된 체크리스트");
  });

  test(`${path} keeps no em dash in its customer-facing copy`, async ({
    page,
  }) => {
    // The em dash and en dash were a house style the copy had drifted into:
    // 37 of them across seven locales, several inside claims where a full
    // stop reads plainly. Asserted on rendered text so a locale that
    // reintroduces one fails here rather than in review.
    await openLanding(page, path);

    const main = await page.locator("main").innerText();
    expect(main).not.toMatch(/[–—]/);
  });

  test(`${path} keeps the public metric disclosure and the locale support banner`, async ({
    page,
  }) => {
    await openLanding(page, path);

    const disclosure = await page.getByTestId("landing-metric-disclosure").innerText();
    expect(disclosure).toMatch(path === "/ko" ? /10단위로 내림/ : /rounded down to the nearest ten/);

    // en and ko are both `primary` locales, so the notice must stay absent
    // here -- its presence would mean the tier policy had been misread.
    await expect(page.locator("#marketing-locale-support-notice")).toHaveCount(0);
  });

  test(`${path} keeps every CTA's accessible name pointing at its own destination`, async ({
    page,
  }) => {
    await openLanding(page, path);

    const expectedHrefs: Array<[string, string]> = [
      ["landing-models-cta", "/models"],
      ["landing-status-cta", "/status"],
      ["landing-safety-cta", "/safety"],
      ["landing-signup-cta", "/auth/signin?callbackUrl=%2Fchat"],
      ["landing-secondary-cta", "#how-it-works"],
    ];
    for (const [testId, href] of expectedHrefs) {
      const link = page.getByTestId(testId);
      await expect(link).toHaveAttribute("href", href);
      const name = await link.evaluate(
        (node) => node.getAttribute("aria-label") || node.textContent?.trim() || ""
      );
      expect(name.length).toBeGreaterThan(0);
    }

    // Both product CTAs go to the same resolved workspace entry. The
    // destination is decided on the server; this only checks the link the
    // page actually rendered has not been swapped for a different surface.
    for (const testId of ["landing-primary-cta", "landing-final-cta"]) {
      await expect(page.getByTestId(testId)).toHaveAttribute(
        "href",
        /\/chat\?lang=/
      );
    }
  });
}

test("the hero names Tomverse Review and sends its CTA to a comparison", async ({
  page,
}) => {
  // The first screen has to answer four questions: Tomverse is the brand,
  // Tomverse Review is this product, it compares several AI answers, and the
  // button opens that comparison rather than the unreleased Tomverse Chat.
  await openLanding(page, "/");

  const brand = await page.getByTestId("landing-brand-note").innerText();
  expect(brand).toContain("Tomverse Review");
  expect(brand).toContain("Tomverse");

  const cta = await page.getByTestId("landing-primary-cta").innerText();
  // "Chat" in a CTA names an unreleased product in the brand tree. Whatever
  // the label says, it must not be that.
  expect(cta.toLowerCase()).not.toContain("chat");
  expect(cta.toLowerCase()).toContain("compar");
});

test("the hero keeps its guest-start and AI Review messages", async ({ page }) => {
  // Guarded from the opposite direction to everything else here: a future
  // edit must not "fix" the hero by qualifying it. Guests can run AI Review,
  // so an "account required" note would be a false limit, not a disclosure.
  await openLanding(page, "/");

  await expect(page.getByTestId("landing-hero-signup-note")).toHaveText(
    /No sign-up required/i
  );
  // ...and exactly once. V1 carried the same promise in two adjacent
  // elements, which is what made the hero read as padding.
  const hero = await page.locator("section[aria-labelledby='landing-hero-title']").innerText();
  expect(hero.match(/No sign-up required/gi) ?? []).toHaveLength(1);

  expect(hero).toMatch(/AI Review/);
  expect(hero).not.toMatch(/Account required/i);
  expect(hero).not.toMatch(/sign in to use/i);
  expect(hero).not.toMatch(/log in to/i);
});

test("the How it works steps stay unqualified", async ({ page }) => {
  await openLanding(page, "/");

  const steps = await page.getByTestId("landing-loop-section").innerText();
  expect(steps).toMatch(/send one prompt or supported file/i);
  expect(steps).toMatch(/Run AI Review/i);
  expect(steps).not.toMatch(/Account required/i);
  expect(steps).not.toMatch(/sign in to/i);
});

test("/ko keeps the locale on the brand link and the Features anchor", async ({
  page,
}) => {
  await openLanding(page, "/ko");

  await expect(page.getByTestId("marketing-brand-link")).toHaveAttribute(
    "href",
    "/ko"
  );

  // Below `lg` the top menu lives behind the hamburger, so the assertion has
  // to follow whichever nav this shell actually renders -- both must keep the
  // locale.
  const desktopFeatures = page.getByTestId("header-features-link");
  if (!(await desktopFeatures.isVisible())) {
    await page.getByTestId("marketing-menu-button").click();
    await expect(page.getByTestId("mobile-features-link")).toHaveAttribute(
      "href",
      "/ko#how-it-works"
    );
    await expect(page.getByTestId("mobile-trust-link")).toHaveAttribute(
      "href",
      "/ko#trust"
    );
  } else {
    await expect(desktopFeatures).toHaveAttribute("href", "/ko#how-it-works");
    await expect(page.getByTestId("header-trust-link")).toHaveAttribute(
      "href",
      "/ko#trust"
    );
  }

  // Destinations without a `/[locale]` route must NOT be prefixed -- doing so
  // would 404. Only the paths in LOCALIZED_SEO_PATHS have one.
  const header = page.locator("header");
  for (const [name, href] of [
    ["모델", "/models"],
    ["요금", "/pricing"],
  ] as const) {
    await expect(
      header.getByRole("link", { name, exact: true }).first()
    ).toHaveAttribute("href", href);
  }

  // FAQ moved out of the top menu to keep it to four items, so the route has
  // to keep an entry point somewhere. It is in the footer.
  await expect(
    page.locator("footer").getByRole("link", { name: "FAQ", exact: true })
  ).toHaveAttribute("href", "/faq");
});

test("plan credits follow the public billing response", async ({ page }) => {
  await prepareGuestPage(page, "en");
  // Deliberately not the built-in defaults: if the card still says 300, the
  // number is coming from copy rather than from billing config.
  await page.route("**/api/billing/config**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plans: [
          {
            id: "free",
            name: "Free",
            monthlyPriceCents: 0,
            annualPriceCents: 0,
            currency: "USD",
            monthlyMessageLimit: 777,
            dailyMessageLimit: 11,
          },
          {
            id: "pro",
            name: "Pro",
            monthlyPriceCents: 1_500,
            annualPriceCents: 14_400,
            currency: "USD",
            monthlyMessageLimit: 8_888,
            dailyMessageLimit: 99,
          },
          {
            id: "max",
            name: "Max",
            monthlyPriceCents: 2_500,
            annualPriceCents: 24_000,
            currency: "USD",
            monthlyMessageLimit: 99_999,
            dailyMessageLimit: 0,
          },
        ],
        creditPacks: [],
        featuredPromotion: null,
        promotionPolicy: {
          codesListed: false,
          validation: "server_only",
          annualDiscountStacking: "promotion_specific_default_denied",
        },
      }),
    })
  );
  await page.goto("/");

  await expect(page.getByTestId("landing-plan-free-credits")).toContainText("777");
  await expect(page.getByTestId("landing-plan-pro-credits")).toContainText("8,888");
  await expect(page.getByTestId("landing-plan-max-credits")).toContainText("99,999");

  // A zero daily limit is Max's selling point, not a missing value.
  await expect(page.getByTestId("landing-plan-max")).toContainText(
    /no daily credit limit/i
  );
  await expect(page.getByTestId("landing-daily-limit-note")).toBeVisible();
  await expect(page.getByTestId("landing-plan-pro-deep-research")).toContainText(
    /Pro/
  );
});

test("the landing page carries no motion to suppress under reduced motion", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await openLanding(page, "/");

  await expect(page.locator("main video")).toHaveCount(0);
  await expect(page.locator("main [autoplay]")).toHaveCount(0);
  await context.close();
});

for (const width of [320, 390]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openLanding(page, "/ko");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  });
}

for (const path of ["/", "/ko", "/fr"] as const) {
  test(`${path} stays inside the viewport at 200% text scale on 320px`, async ({
    page,
  }) => {
    // `main` is `overflow-x-hidden`, so a section that outgrows the viewport
    // is silently cropped rather than showing a scrollbar -- a document-level
    // overflow assertion cannot see it. This measures each section instead.
    //
    // The hero is included. Keeping its wording untouched (the guest promises
    // are the product's, not this page's to qualify) is a copy constraint and
    // says nothing about layout, so excluding it from a reflow check was
    // wrong: the fix is gutters and padding frozen in px, `min-w-0` on the
    // grid items and overflow-wrap on the text, none of which touch a word.
    await page.setViewportSize({ width: 320, height: 640 });
    await prepareGuestPage(page, path === "/ko" ? "ko" : "en");
    await page.addInitScript(() => {
      const apply = () => {
        if (document.documentElement) document.documentElement.style.fontSize = "32px";
      };
      apply();
      document.addEventListener("DOMContentLoaded", apply);
    });
    await page.goto(path);
    await expect(page.getByTestId("landing-hero-title")).toBeVisible();

    const clipped = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const out: Record<string, number> = {};
      for (const section of Array.from(document.querySelectorAll("main section"))) {
        let count = 0;
        for (const child of Array.from(section.querySelectorAll("*"))) {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.right > viewport + 1) count += 1;
        }
        if (count > 0) out[section.id || "hero"] = count;
      }
      return out;
    });
    expect(clipped).toEqual({});
  });
}

test("primary copy and CTAs survive a 200% text scale at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await prepareGuestPage(page, "ko");
  await page.addInitScript(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await page.goto("/ko");
  await expect(page.getByTestId("landing-hero-title")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

  for (const testId of [
    "landing-primary-cta",
    "landing-secondary-cta",
    "landing-models-cta",
    "landing-signup-cta",
    "landing-safety-cta",
  ]) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(320);
  }
});
