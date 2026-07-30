import assert from "node:assert/strict";
import test from "node:test";

/**
 * RECON-I18N-001. `marketing_language_switched` is emitted from a handler whose
 * next statement navigates to a different root layout, which reloads the
 * document. The event only survives that unload because the internal delivery
 * sets `keepalive`.
 *
 * An end-to-end test cannot hold this. Route interception observes a request
 * when it is *issued*, and a request issued without `keepalive` is still issued
 * -- the browser cancels it in flight, after the observation. Dropping the flag
 * leaves the whole browser suite green, so the property is asserted here, on
 * the request the client actually builds.
 */

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

const installBrowser = () => {
  const requests = [];
  const win = {
    localStorage: storage(),
    sessionStorage: storage(),
    location: new URL("https://tomverse.app/"),
    setTimeout: () => 0,
    clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
  };
  globalThis.window = win;
  globalThis.localStorage = win.localStorage;
  globalThis.sessionStorage = win.sessionStorage;
  globalThis.document = { cookie: "" };
  globalThis.fetch = (url, init) => {
    requests.push({ url, init });
    return Promise.resolve({ ok: true, status: 202 });
  };
  return requests;
};

test("internal analytics delivery keeps the request alive across an unload", async () => {
  const requests = installBrowser();
  const { configureAnalyticsClient, trackProductEvent } = await import(
    "../lib/productAnalyticsClient.ts"
  );

  configureAnalyticsClient({
    country: "KR",
    language: "en",
    measurementId: null,
    plan: "Guest",
  });
  trackProductEvent("marketing_language_switched", 0, {
    language_from: "en",
    language_to: "ko",
    navigation: "document",
  });

  const delivery = requests.find((request) =>
    String(request.url).includes("/api/analytics/events")
  );
  assert.ok(delivery, "the switch event was never delivered");
  assert.equal(
    delivery.init.keepalive,
    true,
    "without keepalive the request is cancelled by the navigation it reports"
  );

  const body = JSON.parse(delivery.init.body);
  assert.equal(body.event_name, "marketing_language_switched");
  // The client also merges the locale's own marketing properties into every
  // event, so this checks the switch's own fields rather than the whole bag.
  assert.equal(body.properties.language_from, "en");
  assert.equal(body.properties.language_to, "ko");
  assert.equal(body.properties.navigation, "document");
});
