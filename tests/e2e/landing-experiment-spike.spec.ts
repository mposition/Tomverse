import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { prepareGuestPage } from "./support/app-fixtures";

/**
 * The cache, CSP and rewrite spike for landing experiments
 * (docs/policy/marketing-automation.md 9.1: it has to pass before the feature
 * is built, and 14 S5 asks for zero cache leaks).
 *
 * What is under test is the request boundary, not the copy: a visitor whose
 * assignment cookie names a variant is answered from that variant's
 * prerendered path by `proxy.ts`, and nobody else ever is. Four claims, each
 * with its own tests:
 *
 *  (a) no consent, no cookie, no variant -- ever;
 *  (b) consent plus an assignment shows the variant, at the URL that was asked
 *      for;
 *  (c) a variant response never reaches a shared cache and a default response
 *      never carries a variant, whatever order visitors arrive in;
 *  (d) the CSP on the rewritten response covers the variant's own inline
 *      scripts and the browser reports no violation.
 *
 * The server is the production build with no database. The experiment comes
 * from `E2E_MARKETING_EXPERIMENT` (playwright.config.ts) and is visible only to
 * requests that carry the fixture header, so no other spec can be affected.
 */

const EXPERIMENT_ID = "e2e-home-hero";
const BUNDLE_ID = "home-hero-v1";
const VARIANT_COOKIE = `${EXPERIMENT_ID}.${BUNDLE_ID}.b`;
const CONTROL_COOKIE = `${EXPERIMENT_ID}.${BUNDLE_ID}.control`;
const DEFAULT_HEADLINE_EN = "Which AI should you use?";
const VARIANT_HEADLINE_EN = "Several AI answers.";
const VARIANT_HEADLINE_KO = "AI 답변은 여럿.";
const CONSENT_KEY = "tomverse_analytics_consent_v1";
const ORIGIN = "http://127.0.0.1:3100";
const HTML = { accept: "text/html,application/xhtml+xml" };

/** The text of the hero `<h1>` in a served document, tags removed. */
const heroHeadline = (html: string) => {
  const match = html.match(
    /<h1\b[^>]*data-testid="landing-hero-title"[^>]*>([\s\S]*?)<\/h1>/
  );
  expect(match, "the document has a hero headline").not.toBeNull();
  return match![1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
};

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The request-boundary spike runs once, on the canonical desktop project."
  );
});

test.describe("fixture experiment, forced variant", () => {
  test.use({ extraHTTPHeaders: { "x-e2e-marketing-experiment": "variant" } });

  const assign = (
    request: import("@playwright/test").APIRequestContext,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) =>
    request.post("/api/marketing/experiments", {
      data: { action: "assign", locale: "en", ...body },
      headers: { origin: ORIGIN, ...headers },
    });

  test("(a) without analytics consent no assignment is made and no cookie is set", async ({
    request,
  }) => {
    // Country unknown: the policy is explicit opt-in, so "unset" is not consent.
    const unset = await assign(request, { consent: "unset" });
    expect(unset.status()).toBe(200);
    expect((await unset.json()).status).toBe("off");
    expect(unset.headers()["set-cookie"] ?? "").not.toContain(
      `tv_exp=${EXPERIMENT_ID}`
    );

    const declined = await assign(request, { consent: "declined" });
    expect((await declined.json()).status).toBe("off");
    expect(declined.headers()["set-cookie"] ?? "").not.toContain(
      `tv_exp=${EXPERIMENT_ID}`
    );

    // Strict opt-in countries stay opt-in even when the visitor has not declined.
    const germany = await assign(
      request,
      { consent: "unset" },
      { "cf-ipcountry": "DE" }
    );
    expect((await germany.json()).status).toBe("off");

    // A notice-with-opt-out country is on until declined, by the consent provider's own rule.
    const australia = await assign(
      request,
      { consent: "unset" },
      { "cf-ipcountry": "AU" }
    );
    expect((await australia.json()).status).toBe("assigned");
    expect(australia.headers()["set-cookie"]).toContain(
      `tv_exp=${VARIANT_COOKIE}`
    );
    const australiaDeclined = await assign(
      request,
      { consent: "declined" },
      { "cf-ipcountry": "AU" }
    );
    expect((await australiaDeclined.json()).status).toBe("off");
  });

  test("(a) a visitor who never consented sees the default page and keeps no cookie", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await page.goto("/");
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      DEFAULT_HEADLINE_EN
    );
    // Give the beacon time to run; it must not have created anything.
    await page.waitForLoadState("networkidle");
    expect(
      (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
    ).toBeUndefined();
    await page.reload();
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      DEFAULT_HEADLINE_EN
    );
  });

  test("(a) declining after an assignment returns the visitor to the default copy", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await context.addCookies([
      { name: "tv_exp", value: VARIANT_COOKIE, url: ORIGIN },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "declined");
    }, CONSENT_KEY);
    await page.goto("/");
    // The cookie may serve the variant for one load; the beacon then removes it
    // and the page settles on the default copy.
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      DEFAULT_HEADLINE_EN
    );
    await expect
      .poll(async () =>
        (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
      )
      .toBeUndefined();
  });

  test("(b) consent plus an assignment serves the variant at the original URL", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "accepted");
    }, CONSENT_KEY);

    // First view: always the default page, whichever arm is drawn.
    await page.goto("/");
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      DEFAULT_HEADLINE_EN
    );
    await expect
      .poll(async () =>
        (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
          ?.value
      )
      .toBe(VARIANT_COOKIE);

    // Next document load: the variant, and the exposure is counted.
    const exposure = page.waitForResponse(
      (response) =>
        response.url().includes("/api/marketing/experiments") &&
        response.request().postDataJSON()?.action === "exposure"
    );
    const document = await page.reload();
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      VARIANT_HEADLINE_EN
    );
    expect(new URL(page.url()).pathname).toBe("/");
    expect(document?.headers()["cache-control"]).toBe("private, no-store");
    expect(document?.headers()["x-robots-tag"]).toContain("noindex");
    expect((await (await exposure).json()).status).toBe("recorded");
  });

  test("(b) the Korean home page has its own variant copy", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "ko");
    await context.addCookies([
      { name: "tv_exp", value: VARIANT_COOKIE, url: ORIGIN },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "accepted");
    }, CONSENT_KEY);
    await page.goto("/ko");
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      VARIANT_HEADLINE_KO
    );
    expect(new URL(page.url()).pathname).toBe("/ko");
  });

  test("(b) an assignment for another experiment is dropped and the page returns to the default", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await context.addCookies([
      {
        name: "tv_exp",
        value: `finished-experiment.${BUNDLE_ID}.b`,
        url: ORIGIN,
      },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "accepted");
    }, CONSENT_KEY);
    await page.goto("/");
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      DEFAULT_HEADLINE_EN
    );
    await expect
      .poll(async () =>
        (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
      )
      .toBeUndefined();
  });

  test("(c) variant and default responses never mix, in any order", async ({
    request,
  }) => {
    const get = (cookie?: string, path = "/") =>
      request.get(path, {
        headers: { ...HTML, ...(cookie ? { cookie: `tv_exp=${cookie}` } : {}) },
      });

    let variantResponses = 0;
    let defaultResponses = 0;
    // A fixed shuffle of visitors: with a cookie, without, control, without...
    const visitors = [
      VARIANT_COOKIE,
      undefined,
      undefined,
      VARIANT_COOKIE,
      CONTROL_COOKIE,
      undefined,
      VARIANT_COOKIE,
      VARIANT_COOKIE,
      undefined,
      CONTROL_COOKIE,
      undefined,
      VARIANT_COOKIE,
    ];
    for (const cookie of visitors) {
      const response = await get(cookie);
      expect(response.status()).toBe(200);
      const body = await response.text();
      const headers = response.headers();
      // The hero is the only thing a variant changes: the document title and
      // description are the default page's, so the headline is read from the h1.
      const hero = heroHeadline(body);
      if (cookie === VARIANT_COOKIE) {
        variantResponses += 1;
        expect(hero).toContain(VARIANT_HEADLINE_EN);
        expect(hero).not.toContain(DEFAULT_HEADLINE_EN);
        expect(headers["cache-control"]).toBe("private, no-store");
      } else {
        defaultResponses += 1;
        expect(hero).toContain(DEFAULT_HEADLINE_EN);
        expect(hero).not.toContain(VARIANT_HEADLINE_EN);
        expect(body).not.toContain(VARIANT_HEADLINE_EN);
        // The default page keeps its shared-cache policy: it is the same bytes for everyone.
        expect(headers["cache-control"]).toContain("s-maxage=3600");
        expect(headers["cache-control"]).not.toContain("private");
      }
    }
    expect(variantResponses).toBeGreaterThan(0);
    expect(defaultResponses).toBeGreaterThan(0);
  });

  test("(c) only document loads are rewritten, and only to a variant that exists", async ({
    request,
  }) => {
    const cookie = `tv_exp=${VARIANT_COOKIE}`;

    // A client navigation asks for a Flight payload, not a document.
    const flight = await request.get("/", {
      headers: { cookie, rsc: "1", accept: "*/*" },
    });
    expect(await flight.text()).not.toContain(VARIANT_HEADLINE_EN);

    // No variant copy for French: the default page, not a 404.
    const french = await request.get("/fr", { headers: { ...HTML, cookie } });
    expect(french.status()).toBe(200);
    expect(await french.text()).not.toContain(VARIANT_HEADLINE_EN);

    // A forged or unknown bundle is no variant at all.
    for (const forged of [
      `${EXPERIMENT_ID}.home-unknown-v9.b`,
      `${EXPERIMENT_ID}.pricing-hero-v1.b`,
      `${EXPERIMENT_ID}.${BUNDLE_ID}.zz`,
      "not-a-cookie",
      `${EXPERIMENT_ID}.${BUNDLE_ID}.b.extra`,
    ]) {
      const response = await request.get("/", {
        headers: { ...HTML, cookie: `tv_exp=${forged}` },
      });
      expect(response.status()).toBe(200);
      expect(await response.text()).not.toContain(VARIANT_HEADLINE_EN);
    }

    // Surfaces outside the home page are never rewritten.
    const pricing = await request.get("/pricing", {
      headers: { ...HTML, cookie },
    });
    expect(pricing.status()).toBe(200);
    expect(await pricing.text()).not.toContain(VARIANT_HEADLINE_EN);
  });

  test("(c) a variant path is private, noindex and absent from the sitemap", async ({
    request,
  }) => {
    const direct = await request.get(`/en/lx/${BUNDLE_ID}/b`, { headers: HTML });
    expect(direct.status()).toBe(200);
    expect(direct.headers()["cache-control"]).toBe("private, no-store");
    expect(direct.headers()["x-robots-tag"]).toContain("noindex");
    const body = await direct.text();
    expect(body).toMatch(/<meta name="robots" content="[^"]*noindex/);

    expect((await request.get("/en/lx/home-unknown-v9/b")).status()).toBe(404);

    const sitemap = await (await request.get("/sitemap.xml")).text();
    expect(sitemap).not.toContain("/lx/");
  });

  test("(d) the rewritten response carries a CSP that covers its own inline scripts", async ({
    request,
  }) => {
    const response = await request.get("/", {
      headers: { ...HTML, cookie: `tv_exp=${VARIANT_COOKIE}` },
    });
    const html = await response.text();
    const headers = response.headers();
    const policy =
      headers["content-security-policy"] ??
      headers["content-security-policy-report-only"];
    expect(policy, "a CSP header is on the rewritten response").toBeTruthy();

    const inlineScripts = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
    ]
      .filter(([, attributes, content]) => !/\bsrc\s*=/.test(attributes) && content)
      .map(([, , content]) => content);
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const content of inlineScripts) {
      const hash = `'sha384-${createHash("sha384").update(content, "utf8").digest("base64")}'`;
      expect(policy, "inline script hash is in the policy").toContain(hash);
    }
  });

  test("(d) the browser reports no CSP violation on the rewritten page", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await context.addCookies([
      { name: "tv_exp", value: VARIANT_COOKIE, url: ORIGIN },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "accepted");
      const store: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = store;
      document.addEventListener("securitypolicyviolation", (event) => {
        store.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    }, CONSENT_KEY);

    await page.goto("/");
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      VARIANT_HEADLINE_EN
    );
    await page.waitForLoadState("networkidle");

    const read = (target: Page) =>
      target.evaluate(
        () => (window as unknown as { __violations: string[] }).__violations
      );
    expect(await read(page)).toEqual([]);

    // Control: the recorder does see a violation when one happens, so an empty
    // list above is a measurement and not a listener that never ran.
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__injected = 1;";
      document.head.appendChild(script);
    });
    await expect.poll(() => read(page)).not.toEqual([]);
  });
});

test.describe("fixture experiment, forced control", () => {
  test.use({ extraHTTPHeaders: { "x-e2e-marketing-experiment": "control" } });

  test("(b) a control assignment keeps the default copy and is still measured", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "accepted");
    }, CONSENT_KEY);
    await page.goto("/");
    await expect
      .poll(async () =>
        (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
          ?.value
      )
      .toBe(CONTROL_COOKIE);

    const exposure = page.waitForResponse(
      (response) =>
        response.url().includes("/api/marketing/experiments") &&
        response.request().postDataJSON()?.action === "exposure"
    );
    const document = await page.reload();
    await expect(page.getByTestId("landing-hero-title")).toContainText(
      DEFAULT_HEADLINE_EN
    );
    expect((await (await exposure).json()).status).toBe("recorded");
    // A control visitor is served the shared default page, not a private copy.
    expect(document?.headers()["cache-control"]).toContain("s-maxage=3600");
  });
});
