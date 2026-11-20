import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { NotFoundBody, notFoundCopy } from "@/components/NotFoundContent";
import { SUPPORTED_LANGUAGES } from "@/lib/language";
import { HELP_CENTRE_PATH } from "@/lib/localizedHelpHref";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

/**
 * The 404 body, rendered.
 *
 * Both files that can serve a 404 render this component -- `app/not-found.tsx`
 * for a `notFound()` thrown inside a route, and `app/global-not-found.tsx` for
 * a URL that matches none. The second one exists because an unmatched URL has
 * no root layout to compose the first one with, which Next answered with a 500
 * rather than a 404; a visitor who guessed `/help` got "something went wrong"
 * and no way on from it. So what is asserted here is that the page a visitor
 * reaches instead actually carries somewhere to go.
 */
const ssrRouter: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "not-found-ssr-fixture",
};

const render = (signInHref: string | null) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={ssrRouter}>
      <NotFoundBody signInHref={signInHref} />
    </AppRouterContext.Provider>
  );

const SWITCH_ACCOUNT_LABEL = "Sign out and use another account";

test("every 404 offers a way on: the homepage, the workspace, the guides and support", () => {
  for (const signInHref of [null, "/auth/signin?callbackUrl=%2Fadmin%2Foverview&reason=switch-account"]) {
    const html = render(signInHref);
    assert.match(html, /We couldn&#x27;t find that page/);
    assert.match(html, /href="\/"/);
    assert.match(html, new RegExp(`href="${REVIEW_WORKSPACE_PATH}"`));
    // The help centre is named in its own right. "Contact support" was the
    // only thing here that could stand for it, and a visitor looking for a
    // guide does not read "contact" as "read the guides".
    assert.match(html, new RegExp(`href="${HELP_CENTRE_PATH}"`));
    assert.match(html, /Browse the help centre/);
    assert.match(html, /href="\/support"/);
    assert.match(html, /Contact support/);
  }
});

test("an ordinary 404 keeps its own copy and offers no account switch", () => {
  const html = render(null);
  assert.match(html, /Nothing is wrong with your account/);
  // Nobody who mistyped a public URL is asked to end their session.
  assert.ok(!html.includes(SWITCH_ACCOUNT_LABEL));
  assert.ok(!html.includes("/auth/signin"));
});

test("a 404 that may be the account's fault offers the switch and says so", () => {
  const signInHref =
    "/auth/signin?callbackUrl=%2Fadmin%2Funmatched&reason=switch-account";
  const html = render(signInHref);
  assert.match(
    html,
    /The link may be out of date, the page may have moved, or you may need to use a different account\./
  );
  assert.ok(!html.includes("Nothing is wrong with your account"));
  assert.match(html, new RegExp(SWITCH_ACCOUNT_LABEL));
  // Nothing names the console, a role, or an allowlist.
  assert.doesNotMatch(html, /admin console|administrat/i);
});

test("a Korean document renders the whole 404, account switch included, in Korean", () => {
  const html = renderToStaticMarkup(
    <AppRouterContext.Provider value={ssrRouter}>
      <NotFoundBody
        signInHref="/auth/signin?callbackUrl=%2Fadmin%2Foverview&reason=switch-account"
        language="ko"
      />
    </AppRouterContext.Provider>
  );
  const ko = notFoundCopy.ko;
  for (const text of [ko.title, ko.accountDescription, ko.home, ko.workspace, ko.helpCentre, ko.support, ko.switchAccount]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /답변 비교 화면으로 이동/);
  assert.ok(!html.includes("couldn&#x27;t find"));
  assert.ok(!html.includes(SWITCH_ACCOUNT_LABEL));
  assert.match(html, new RegExp(`href="${REVIEW_WORKSPACE_PATH}"`));
});

test("every supported language has its own 404 copy", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = notFoundCopy[language];
    assert.ok(copy, language);
    for (const value of Object.values(copy)) assert.ok(value.trim(), language);
  }
});
