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
mock.module(mod("components/marketing/MarketingChatAvailability.tsx"), {
  namedExports: { MarketingChatAvailabilityProvider: () => null },
});
mock.module(mod("components/LanguageProvider.tsx"), {
  namedExports: { LanguageProvider: () => null },
});

const { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } = await import(mod("lib/landingWorkspaceEntry.ts"));
const { default: LandingPage } = await import(mod("app/(site)/(marketing)/page.tsx"));
const { default: LocalizedLandingPage } = await import(mod("app/[locale]/page.tsx"));

test.after(() => { delete globalThis.React; });

test("the public trial is available without session, auth-secret or account rollout reads", () => {
  assert.equal(PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE, true);
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});

test("the root static document passes public Guest entry rather than a build-time account offer", () => {
  const element = LandingPage();
  assert.equal(element.props.guestTrialAvailable, true);
  assert.equal("chatSurfaceAvailable" in element.props, false);
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});

test("each localized static document carries the same public entry without account reads", async () => {
  for (const locale of ["en", "ko", "zh", "fr", "de", "es", "pt"]) {
    const element = await LocalizedLandingPage({ params: Promise.resolve({ locale }) });
    const landing = element.props.children.props.children;
    assert.equal(landing.props.guestTrialAvailable, true);
    assert.equal("chatSurfaceAvailable" in landing.props, false);
  }
  assert.equal(sessionReads, 0);
  assert.equal(availabilityReads, 0);
});
