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
// The last part is the languages the assignment was registered for, sorted and
// run together; the fixture experiment covers English and Korean.
const VARIANT_COOKIE = `${EXPERIMENT_ID}.${BUNDLE_ID}.b.enko`;
const CONTROL_COOKIE = `${EXPERIMENT_ID}.${BUNDLE_ID}.control.enko`;
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

  test("(a) a visitor who decides later is assigned from the next view, not shut out for the session", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    const undecided = page.waitForResponse(
      (response) =>
        response.url().includes("/api/marketing/experiments") &&
        response.request().method() === "POST"
    );
    await page.goto("/");
    // No consent yet in an opt-in region: the route answers off, no cookie.
    expect((await (await undecided).json()).status).toBe("off");
    expect(
      (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
    ).toBeUndefined();

    // The visitor now allows analytics, as the consent provider records it, and
    // the next view of the same tab session must not reuse the earlier "off".
    await page.evaluate((key) => {
      window.localStorage.setItem(key, "accepted");
    }, CONSENT_KEY);
    await page.reload();
    await expect
      .poll(async () =>
        (await context.cookies()).find((cookie) => cookie.name === "tv_exp")
          ?.value
      )
      .toBe(VARIANT_COOKIE);
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

  test("(b) a click on the call to action before the exposure answer arrives is still counted", async ({
    page,
    context,
  }) => {
    await prepareGuestPage(page, "en");
    await context.addCookies([
      { name: "tv_exp", value: VARIANT_COOKIE, url: ORIGIN },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "accepted");
    }, CONSENT_KEY);

    // Hold the exposure answer, as a slow database read would.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/marketing/experiments", async (route) => {
      if (route.request().postDataJSON()?.action === "exposure") await held;
      await route.continue().catch(() => undefined);
    });
    const isCall = (action: string) => (request: import("@playwright/test").Request) =>
      request.url().includes("/api/marketing/experiments") &&
      request.postDataJSON()?.action === action;

    const exposureSent = page.waitForRequest(isCall("exposure"));
    const conversionSent = page.waitForRequest(isCall("conversion"));
    await page.goto("/");
    await exposureSent;
    // The page is hydrated: the exposure request is only sent from its effect.
    await page.locator("#landing-hero-primary").click({ noWaitAfter: true });
    await conversionSent;
    release();
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
        value: `finished-experiment.${BUNDLE_ID}.b.enko`,
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

  test("(c) the variant stays inside the languages the assignment was registered for", async ({
    request,
  }) => {
    const english = `tv_exp=${EXPERIMENT_ID}.${BUNDLE_ID}.b.en`;
    // Registered for English: the English home is the variant, the Korean one is not,
    // although the bundle has Korean copy -- and the Korean variant path is not theirs.
    const en = await request.get("/", { headers: { ...HTML, cookie: english } });
    expect(heroHeadline(await en.text())).toContain(VARIANT_HEADLINE_EN);
    const ko = await request.get("/ko", { headers: { ...HTML, cookie: english } });
    expect(ko.status()).toBe(200);
    expect(heroHeadline(await ko.text())).not.toContain(VARIANT_HEADLINE_KO);
    const direct = await request.get(`/ko/lx/${BUNDLE_ID}/b`, {
      headers: { ...HTML, cookie: english },
      maxRedirects: 0,
    });
    expect(direct.status()).toBe(307);
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
      `${EXPERIMENT_ID}.home-unknown-v9.b.enko`,
      `${EXPERIMENT_ID}.pricing-hero-v1.b.enko`,
      `${EXPERIMENT_ID}.${BUNDLE_ID}.zz.enko`,
      // The three-part shape from before the scope travelled in the cookie.
      `${EXPERIMENT_ID}.${BUNDLE_ID}.b`,
      `${EXPERIMENT_ID}.${BUNDLE_ID}.b.xx`,
      "not-a-cookie",
      `${EXPERIMENT_ID}.${BUNDLE_ID}.b.enko.extra`,
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

  test("(a) a variant path named directly is served only to the assignment that matches it", async ({
    request,
  }) => {
    // Without an assignment, with the control's, with another experiment's
    // bundle, and for a variant this build does not have: never the variant
    // copy, never a page of its own -- the visitor is sent to the default home.
    const strangers: Array<string | undefined> = [
      undefined,
      `tv_exp=${CONTROL_COOKIE}`,
      `tv_exp=${EXPERIMENT_ID}.home-other-v1.b.enko`,
      "tv_exp=garbage",
    ];
    for (const [path, home] of [
      [`/en/lx/${BUNDLE_ID}/b`, "/"],
      [`/ko/lx/${BUNDLE_ID}/b`, "/ko"],
      ["/en/lx/home-unknown-v9/b", "/"],
    ] as const) {
      for (const cookie of strangers) {
        const response = await request.get(path, {
          headers: { ...HTML, ...(cookie ? { cookie } : {}) },
          maxRedirects: 0,
        });
        expect(response.status(), `${path} ${cookie ?? "no cookie"}`).toBe(307);
        expect(new URL(response.headers()["location"], ORIGIN).pathname).toBe(home);
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        expect(response.headers()["x-robots-tag"]).toContain("noindex");
      }
    }
    // Followed to the end, the default copy is what arrives.
    const followed = await request.get(`/en/lx/${BUNDLE_ID}/b`, { headers: HTML });
    expect(followed.status()).toBe(200);
    expect(heroHeadline(await followed.text())).toContain(DEFAULT_HEADLINE_EN);

    // The matching assignment is the same visitor the rewrite serves.
    const own = await request.get(`/en/lx/${BUNDLE_ID}/b`, {
      headers: { ...HTML, cookie: `tv_exp=${VARIANT_COOKIE}` },
      maxRedirects: 0,
    });
    expect(own.status()).toBe(200);
    expect(heroHeadline(await own.text())).toContain(VARIANT_HEADLINE_EN);
    expect(own.headers()["cache-control"]).toBe("private, no-store");

    // A matching cookie for a variant that is not in this build gets the
    // default page, as the rewrite does: policy 9.1, a missing target is no variant.
    const missing = await request.get("/en/lx/home-unknown-v9/b", {
      headers: { ...HTML, cookie: `tv_exp=${EXPERIMENT_ID}.home-unknown-v9.b.enko` },
      maxRedirects: 0,
    });
    expect(missing.status()).toBe(307);
    expect(new URL(missing.headers()["location"], ORIGIN).pathname).toBe("/");
  });

  test("(c) the rewritten variant is private and noindex, and no variant path is in the sitemap", async ({
    request,
  }) => {
    const served = await request.get("/", {
      headers: { ...HTML, cookie: `tv_exp=${VARIANT_COOKIE}` },
    });
    expect(served.headers()["cache-control"]).toBe("private, no-store");
    expect(served.headers()["x-robots-tag"]).toContain("noindex");
    expect(await served.text()).toMatch(/<meta name="robots" content="[^"]*noindex/);

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
