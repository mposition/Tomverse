import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import React from "react";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let sessionReads = 0;
let availabilityReads = 0;
globalThis.React = React;

mock.module("next/navigation", { namedExports: {
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url) => { throw new Error(`REDIRECT:${url}`); },
} });

// Static public entry must not depend on either account API or an auth secret.
mock.module("next-auth/next", { namedExports: { getServerSession: async () => {
  sessionReads += 1;
  throw new Error("NO_SECRET");
} } });
mock.module(mod("lib/autoAvailability.ts"), { namedExports: { autoAvailabilityFor: async () => {
  availabilityReads += 1;
  throw new Error("ACCOUNT_AVAILABILITY_MUST_NOT_BE_READ");
} } });
mock.module(mod("components/marketing/LaunchHomepage.tsx"), {
  defaultExport: () => null,
});
const MarketingChatAvailabilityProvider = () => null;
mock.module(mod("components/marketing/MarketingChatAvailability.tsx"), {
  namedExports: { MarketingChatAvailabilityProvider },
});
mock.module(mod("components/LanguageProvider.tsx"), {
  namedExports: { LanguageProvider: () => null },
});
mock.module(mod("components/analytics/MarketingConsentReservation.tsx"), {
  namedExports: { MarketingConsentReservation: () => null },
});
mock.module(mod("components/AppToastViewport.tsx"), {
  namedExports: { AppToastViewport: () => null },
});
mock.module(mod("components/marketing/MarketingProviders.tsx"), {
  namedExports: { MarketingProviders: () => null },
});
mock.module(mod("components/seo/StructuredData.tsx"), {
  namedExports: { StructuredData: () => null },
});

const { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } = await import(mod("lib/landingWorkspaceEntry.ts"));
const { default: LandingPage } = await import(mod("app/(site)/(marketing)/page.tsx"));
const { default: LocalizedLandingPage } = await import(mod("app/[locale]/page.tsx"));
const { MarketingShell } = await import(mod("components/marketing/MarketingShell.tsx"));

const findElement = (element, type) => {
  if (!React.isValidElement(element)) return null;
  if (element.type === type) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
};

const assertPublicProductLinks = (element, locale) => {
  assert.equal(element.props.chatHref, `/chat?lang=${locale}`);
  assert.equal(element.props.reviewHref, `/review?lang=${locale}`);
  assert.equal(element.props.reviewInfoHref, `/${locale}/products/review`);
  assert.equal("chatSurfaceAvailable" in element.props, false);
};

test.after(() => { delete globalThis.React; });

test("the public trial is available without session, auth-secret or account rollout reads", () => {
  assert.equal(PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE, true);
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});

test("the shared static shell supplies the public Guest offer without account reads", () => {
  const shell = MarketingShell({ children: LandingPage() });
  const availability = findElement(shell, MarketingChatAvailabilityProvider);
  assert.ok(availability);
  assert.equal(availability.props.guestTrialAvailable, true);
  assert.equal("chatSurfaceAvailable" in availability.props, false);
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});

test("the root static document carries both public product entries without a build-time account offer", () => {
  const element = LandingPage();
  assertPublicProductLinks(element, "en");
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});

test("each localized static document carries the same public entry without account reads", async () => {
  for (const locale of ["en", "ko", "zh", "fr", "de", "es", "pt"]) {
    const element = await LocalizedLandingPage({ params: Promise.resolve({ locale }) });
    const landing = element.props.children.props.children;
    assertPublicProductLinks(landing, locale);
  }
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});
