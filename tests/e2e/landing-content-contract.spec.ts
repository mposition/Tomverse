import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { layoutBox } from "./support/engine-capabilities";
import { reviewPageContent } from "@/components/marketing/v2/review/reviewPageContent";
import { AI_REVIEW_CREDITS, QUICK_SUMMARY_CREDITS } from "@/lib/comparisonReviewCost";

/**
 * The answer comparison page's content contract (/products/review, V2).
 *
 * This file used to pin the old landing page: five sections, a quick-summary
 * card, web search and Deep Research cards, plan credit cards and a catalogue
 * block, all behind `landing-*` test ids. V2 replaced that page with the concept
 * the owner approved on 2026-11-20 (components/marketing/v2/review), so what is
 * guarded here follows the new page rather than the old one. The purposes that
 * carried over:
 *
 * - every section is there, in order, and the retired structure does not return;
 * - AI Review is offered as the deep read next to the quick summary, never as a
 *   replacement, and its boundary (quote match, not truth; no winner) is stated;
 * - conditions on account-only features are stated, and file attachment is not
 *   described as locked for guests;
 * - the guest promise is made once and is not qualified;
 * - links and CTAs point where they say; credit figures come from code, not prose;
 * - no em dash in customer-facing copy;
 * - the page fits a 320px phone, also at a 200% root font size.
 *
 * It asserts on structure, ids, test ids and condition keywords, so rewording a
 * paragraph does not break it but deleting a section does.
 */

const SECTION_IDS = ["how", "modes", "lens", "trust", "uses", "after", "providers", "faq"] as const;

const openReview = async (page: Page, lang: "en" | "ko") => {
  await prepareGuestPage(page, lang);
  await page.goto(lang === "ko" ? "/ko/products/review" : "/products/review");
  await expect(page.getByTestId("review-product-title")).toBeVisible();
};

for (const lang of ["en", "ko"] as const) {
  const copy = reviewPageContent[lang];

  test(`${lang} renders every section in the intended order`, async ({ page }) => {
    await openReview(page, lang);

    // What it does, how it sums up, what to weigh, how you check it, when to use it,
    // what happens next, which providers, the questions people ask.
    const order = await page.$$eval("main section[id]", (sections) => sections.map((section) => section.id));
    expect(order).toEqual([...SECTION_IDS]);

    // The old landing's anchors must not come back silently.
    for (const id of ["how-it-works", "evidence", "after-comparison", "pricing", "ai-review", "model-catalogue"]) {
      await expect(page.locator(`section#${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("landing-hero-title")).toHaveCount(0);
  });

  test(`${lang} offers the quick difference summary next to AI Review, never instead of it`, async ({ page }) => {
    await openReview(page, lang);

    const tabs = page.getByRole("tablist", { name: copy.modes.tabsLabel }).getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveText(copy.modes.tabs[0]);
    await expect(tabs.nth(1)).toHaveText(copy.modes.tabs[1]);

    // Picking a tab stops the page's own rotation and shows that way of summing up.
    const panel = page.locator("#review-mode-panel");
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator("blockquote").first()).toBeVisible();
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator(".quick-line")).toHaveCount(3);

    const section = (await page.locator("#modes").innerText()).toLowerCase();
    expect(section).not.toContain("instead of ai review");
    expect(section).not.toContain("ai review 대신");
  });

  test(`${lang} lets the visitor pick what the review weighs`, async ({ page }) => {
    await openReview(page, lang);

    const tabs = page.getByRole("tablist", { name: copy.lens.tabsLabel }).getByRole("tab");
    await expect(tabs).toHaveCount(3);
    const panel = page.locator("#review-lens-panel");
    for (let i = 0; i < 3; i += 1) {
      await tabs.nth(i).click();
      await expect(tabs.nth(i)).toHaveAttribute("aria-selected", "true");
      await expect(panel).toContainText(copy.lens.lenses[i].name);
      await expect(panel.locator(".lens-out p")).toHaveCount(copy.lens.lenses[i].items.length);
    }
  });

  test(`${lang} states the review boundary and the conditions on its checks`, async ({ page }) => {
    await openReview(page, lang);

    const trust = page.locator("#trust");
    await expect(trust.locator(".card")).toHaveCount(4);
    const text = await trust.innerText();
    // Quote matching is not factual accuracy and not a probability that a claim is true.
    expect(text).toMatch(lang === "ko" ? /확률이 아니라/ : /not the probability that a claim is true/);
    // A second reviewer is not a consensus on which answer is correct.
    expect(text).toMatch(lang === "ko" ? /정답인지 합의했다는 뜻은 아닙니다/ : /does not mean they agree about which answer is correct/);
    // The per-item web check is a separate, signed-in, separately charged step.
    expect(text).toMatch(lang === "ko" ? /로그인 필요 · 크레딧 별도/ : /Sign-in required · charged separately/);
    // AI Review compares only what it is given.
    expect(text).toMatch(lang === "ko" ? /받은 답변끼리만 비교/ : /compares only the answers it is given/);
  });

  test(`${lang} states the account condition on account-only features only`, async ({ page }) => {
    await openReview(page, lang);

    const after = await page.locator("#after").innerText();
    expect(after).toMatch(lang === "ko" ? /계정이 필요/ : /account is required/i);

    // Attachments must not be described as account-only: guests can attach
    // supported files temporarily. Only connecting Google Drive needs an account.
    const lower = (await page.locator("main").innerText()).toLowerCase();
    expect(lower).not.toContain("log in to attach");
    expect(lower).not.toContain("첨부는 로그인");
    expect(after).toMatch(lang === "ko" ? /비회원은 지원하는 파일을 임시로 붙일 수 있고/ : /Guests can attach supported files temporarily/);
  });

  test(`${lang} discloses the recording as demonstration data and takes no endorsement`, async ({ page }) => {
    await openReview(page, lang);

    const disclosure = await page.getByTestId("review-demo-caption").innerText();
    expect(disclosure).toMatch(lang === "ko" ? /시연용 데이터/ : /demonstration data/i);
    expect(disclosure).toMatch(lang === "ko" ? /공급자 보증이 아닙니다/ : /Not a provider endorsement/i);
    // The recording is the current interface; the superseded walkthrough's figures stay gone.
    const main = await page.locator("main").innerText();
    expect(main).not.toContain("4 credits used");
    expect(main).not.toContain("Review confidence");
  });

  test(`${lang} keeps no em dash in its customer-facing copy`, async ({ page }) => {
    // The em dash and en dash were a house style the copy had drifted into.
    // Asserted on rendered text so a locale that reintroduces one fails here.
    await openReview(page, lang);

    const main = await page.locator("main").innerText();
    expect(main).not.toMatch(/[–—]/);
  });

  test(`${lang} points every CTA at its own destination`, async ({ page }) => {
    await openReview(page, lang);

    // Both comparison CTAs go to Review's guest preview; the destination is decided
    // by lib/productEntryDestination.ts and this only checks the link was not swapped.
    for (const testId of ["landing-primary-cta", "review-final-cta"]) {
      await expect(page.getByTestId(testId)).toHaveAttribute("href", `/review?lang=${lang}&entry=guest-preview`);
    }
    await expect(page.locator("#landing-hero-primary")).toHaveCount(1);
    await expect(page.locator("section.page-hero").getByRole("link", { name: copy.hero.secondary })).toHaveAttribute("href", "#how");

    await expect(page.locator(".cta-band").getByRole("link", { name: copy.cta.pricing })).toHaveAttribute("href", `/${lang}/pricing`);
    await expect(page.locator("#providers").getByRole("link", { name: copy.providers.modelsLink })).toHaveAttribute("href", `/${lang}/models`);
    await expect(page.locator("#faq").getByRole("link", { name: copy.faq.calcLink })).toHaveAttribute("href", `/${lang}/pricing#calc`);
  });

  test(`${lang} takes its credit figures and provider count from data, not prose`, async ({ page }) => {
    await openReview(page, lang);

    // The two comparison actions quote lib/comparisonReviewCost.ts.
    const credits = page.locator("#faq details").nth(1);
    await credits.locator("summary").click();
    const answer = await credits.innerText();
    expect(answer).toContain(String(QUICK_SUMMARY_CREDITS));
    expect(answer).toContain(String(AI_REVIEW_CREDITS));
    expect(answer).not.toMatch(/\{\w+\}/);

    // The provider count is the catalogue's (or the 12 fallback), never a typed literal.
    const eyebrow = await page.locator("#providers .eyebrow").innerText();
    expect(Number(eyebrow.match(/\d+/)?.[0])).toBeGreaterThan(2);
    await expect(page.locator("#providers .prov-cell")).toHaveCount(12);
    expect(await page.locator("section.page-hero .hero-lede").innerText()).not.toMatch(/\{\w+\}/);
  });
}

test("the hero keeps its guest-start message and does not qualify it", async ({ page }) => {
  // Guarded from the opposite direction to everything else here: a future edit
  // must not "fix" the hero by qualifying it. Guests can run AI Review, so an
  // "account required" note would be a false limit, not a disclosure.
  await openReview(page, "en");

  await expect(page.getByTestId("review-product-guest-note")).toHaveText(/no sign-up needed/i);
  const hero = await page.locator("section.page-hero").innerText();
  // The promise is made once in the hero.
  expect(hero.match(/no sign-up/gi) ?? []).toHaveLength(1);
  expect(hero).toMatch(/AI Review/);
  expect(hero).not.toMatch(/Account required/i);
  expect(hero).not.toMatch(/sign in to use/i);
  expect(hero).not.toMatch(/log in to/i);
});

test("the How it works steps stay unqualified", async ({ page }) => {
  await openReview(page, "en");

  const steps = await page.locator("#how").innerText();
  expect(steps).toMatch(/send one question or file, once/i);
  expect(steps).toMatch(/AI Review/);
  expect(steps).not.toMatch(/Account required/i);
  expect(steps).not.toMatch(/sign in to/i);
});

test("/ko keeps the locale on the brand link and Review information link", async ({ page }) => {
  await openReview(page, "ko");

  await expect(page.getByTestId("marketing-brand-link")).toHaveAttribute("href", "/ko");

  // Below `lg` the top menu lives behind the hamburger, so the assertion has
  // to follow whichever nav this shell actually renders -- both must keep the
  // locale.
  const desktopReview = page.getByTestId("header-review-link");
  if (!(await desktopReview.isVisible())) {
    await page.getByTestId("marketing-menu-button").click();
    await expect(page.getByTestId("mobile-review-link")).toHaveAttribute("href", "/ko/products/review");
  } else {
    await expect(desktopReview).toHaveAttribute("href", "/ko/products/review");
  }

  // The public model and pricing pages have actual locale routes.
  const header = page.locator("header");
  for (const [name, href] of [
    ["모델 살펴보기", "/ko/models"],
    ["요금제", "/ko/pricing"],
  ] as const) {
    await expect(header.getByRole("link", { name, exact: true }).first()).toHaveAttribute("href", href);
  }

  // FAQ moved out of the top menu to keep it to four items, so the route has
  // to keep an entry point somewhere. It is in the footer.
  await expect(page.locator("footer").locator("a[href='/ko/faq']")).toHaveAttribute("href", "/ko/faq");
});

for (const width of [320, 390]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openReview(page, "ko");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  });
}

for (const path of ["/", "/ko", "/fr"] as const) {
  test(`${path} stays inside the viewport at 200% text scale on 320px`, async ({ page }) => {
    // The page root clips horizontal overflow, so a section that outgrows the
    // viewport is cropped rather than showing a scrollbar -- a document-level
    // assertion cannot see it. This measures each section's content instead. The
    // hero's background media is deliberately wider than the viewport and is skipped.
    await page.setViewportSize({ width: 320, height: 640 });
    await prepareGuestPage(page, path === "/ko" ? "ko" : "en");
    await page.addInitScript(() => {
      const apply = () => {
        if (document.documentElement) document.documentElement.style.fontSize = "32px";
      };
      apply();
      document.addEventListener("DOMContentLoaded", apply);
    });
    await page.goto(path === "/" ? "/products/review" : `${path}/products/review`);
    await expect(page.getByTestId("review-product-title")).toBeVisible();

    const clipped = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const out: Record<string, number> = {};
      for (const section of Array.from(document.querySelectorAll("main section"))) {
        let count = 0;
        for (const child of Array.from(section.querySelectorAll("*"))) {
          if (child.closest(".hero-media")) continue;
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.right > viewport + 1) count += 1;
        }
        if (count > 0) out[section.id || section.getAttribute("aria-labelledby") || "section"] = count;
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
  await page.goto("/ko/products/review");
  await expect(page.getByTestId("review-product-title")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

  for (const target of [page.getByTestId("landing-primary-cta"), page.getByTestId("review-final-cta"), page.locator("#providers").getByRole("link")]) {
    await target.first().scrollIntoViewIfNeeded();
    await expect(target.first()).toBeVisible();
    const box = await layoutBox(target.first());
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(320);
  }
});
