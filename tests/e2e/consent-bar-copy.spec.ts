import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

// The analytics consent notice on public pages is a bar fixed to the bottom of
// the screen (owner decision 2026-11-16). This one spec replaces the per-page
// copy and layout specs that pinned the earlier header card (#3571, #3581,
// #3592) and keeps what they protected, on every public route:
//
// - What is measured and what is excluded stays explicit in both regional
//   modes: the full body on a desktop-width bar; on a phone the short
//   sentence, with the privacy policy one tap away.
// - The decision buttons carry their full accessible names, sit under the
//   sentence on a phone, and declining is stored.
// - Text is at least 14px on a phone, the policy link never wraps, contrast
//   holds, and nothing widens the page -- also at 200% text.

type Lang = "en" | "ko";
type Country = "DE" | "AU";

const ROUTES: { path: string; lang: Lang }[] = [
  { path: "/?lang=en", lang: "en" },
  { path: "/en", lang: "en" },
  { path: "/about?lang=en", lang: "en" },
  { path: "/faq?lang=en", lang: "en" },
  { path: "/ai-for-file-analysis?lang=en", lang: "en" },
  { path: "/support?lang=en", lang: "en" },
  { path: "/support/help-centre?lang=en", lang: "en" },
  { path: "/en/support/help-centre", lang: "en" },
  { path: "/models?lang=en", lang: "en" },
  { path: "/pricing?lang=en", lang: "en" },
  { path: "/privacy?lang=en", lang: "en" },
  { path: "/safety?lang=en", lang: "en" },
  { path: "/terms?lang=en", lang: "en" },
  { path: "/chatgpt-vs-claude?lang=en", lang: "en" },
  { path: "/en/chatgpt-vs-claude", lang: "en" },
  { path: "/compare-ai-models?lang=en", lang: "en" },
  { path: "/en/compare-ai-models", lang: "en" },
  { path: "/?lang=ko", lang: "ko" },
  { path: "/ko", lang: "ko" },
  { path: "/faq?lang=ko", lang: "ko" },
  { path: "/models?lang=ko", lang: "ko" },
  { path: "/pricing?lang=ko", lang: "ko" },
  { path: "/support?lang=ko", lang: "ko" },
];

const COPY: Record<Lang, Record<Country, { desktop: string[]; phone: string[]; accept: string }>> = {
  en: {
    DE: {
      desktop: [
        "measures product usage and campaign attribution",
        "Prompts, responses, filenames, and file contents are never included",
      ],
      phone: ["Usage analytics excludes prompts and file content."],
      accept: "Allow analytics",
    },
    AU: {
      desktop: [
        "product analytics with a clear opt-out",
        "Prompts, responses, filenames, and file contents are never included",
      ],
      phone: ["Usage analytics is on; prompts and file content are excluded."],
      accept: "Keep analytics on",
    },
  },
  ko: {
    DE: {
      desktop: ["동의하면 기능 사용·유입 경로 통계를 수집해 Tomverse를 개선합니다.", "프롬프트, 응답, 파일명 및 파일 내용"],
      phone: ["기능 사용·유입 경로 통계를 수집해 제품을 개선합니다.", "질문·파일 내용은 제외합니다."],
      accept: "사용 통계 허용",
    },
    AU: {
      desktop: ["개인정보를 최소화한 제품 분석", "프롬프트, 응답, 파일명 및 파일 내용"],
      phone: ["분석이 켜져 있습니다.", "질문과 파일은 수집하지 않습니다."],
      accept: "분석 유지",
    },
  },
};

const PRIVACY: Record<Lang, string> = { en: "Privacy policy", ko: "개인정보 처리방침" };

async function openWithPendingConsent(
  page: Page,
  path: string,
  lang: Lang,
  country: Country,
  width: number,
  theme?: "light" | "dark"
) {
  await page.setViewportSize({ width, height: 900 });
  await prepareGuestPage(page, lang);
  if (theme) await setDeterministicTheme(page, theme);
  await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.setExtraHTTPHeaders({ "cf-ipcountry": country });
  await page.route("**/api/analytics/events", (route) => route.fulfill({ status: 202, body: "" }));
  await page.route("https://www.googletagmanager.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" })
  );
  await page.goto(path);
  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("data-variant", "bottom-bar");
  return notice;
}

const linkLines = (page: Page, name: string) =>
  page
    .getByTestId("chat-consent-notice")
    .getByRole("link", { name, exact: true })
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });

for (const { path, lang } of ROUTES) {
  for (const country of ["DE", "AU"] as const) {
    test(`consent bar states purpose and exclusions on ${path} in ${country}`, async ({ page }, info) => {
      const phone = info.project.name.includes("mobile");
      const notice = await openWithPendingConsent(page, path, lang, country, phone ? 320 : 1440);
      const copy = COPY[lang][country];

      for (const text of phone ? copy.phone : copy.desktop) {
        await expect(notice).toContainText(text, { useInnerText: true });
      }
      await expect(notice.getByTestId("analytics-consent-accept")).toHaveAccessibleName(copy.accept);
      expect(await linkLines(page, PRIVACY[lang])).toBe(1);

      if (phone) {
        const layout = await notice.evaluate((node) => {
          const sentence = node.querySelector("p")!;
          const decline = node.querySelector('[data-testid="analytics-consent-decline"]')!;
          return {
            size: Number.parseFloat(getComputedStyle(sentence).fontSize),
            sentenceBottom: sentence.getBoundingClientRect().bottom,
            actionsTop: decline.getBoundingClientRect().top,
          };
        });
        expect(layout.size, "phone sentence is at least 14px").toBeGreaterThanOrEqual(14);
        expect(layout.actionsTop, "the decisions sit under the sentence").toBeGreaterThan(layout.sentenceBottom);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

      await notice.getByTestId("analytics-consent-decline").click();
      await expect(notice).toBeHidden();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("tomverse_analytics_consent_v1")))
        .toBe("declined");
    });
  }
}

for (const path of ["/?lang=en", "/privacy?lang=en", "/support/help-centre?lang=en", "/compare-ai-models?lang=en"]) {
  for (const theme of ["light", "dark"] as const) {
    test(`consent bar text and policy link keep their contrast on ${path} in ${theme}`, async ({ page }, info) => {
      const phone = info.project.name.includes("mobile");
      const notice = await openWithPendingConsent(page, path, "en", "DE", phone ? 320 : 1440, theme);
      await expectAccessibleContrast(notice.locator("p").first(), "Consent sentence");
      await expectAccessibleContrast(notice.getByRole("link", { name: "Privacy policy", exact: true }), "Privacy link");
      // Keyboard path: the decline control is reachable and works from Enter.
      await notice.getByTestId("analytics-consent-decline").focus();
      await page.keyboard.press("Enter");
      await expect(notice).toBeHidden();
    });
  }
}

test("at 200% text the policy link stays whole and the page does not widen", async ({ page }) => {
  const notice = await openWithPendingConsent(page, "/privacy?lang=en", "en", "DE", 320);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  expect(await linkLines(page, "Privacy policy")).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const box = await notice.boundingBox();
  expect(box!.height, "the bar stays within half the screen").toBeLessThanOrEqual(900 / 2 + 1);
});
