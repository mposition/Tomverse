import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { mobileAuthReturnPath, readMobileAuthReturn } from "../lib/mobileBrowserLogin.ts";
import { mobileAppLinks } from "../lib/mobileAppLinks.ts";
import { GET as callbackPage } from "../app/mobile/auth/callback/route.ts";
import { GET as androidAssociation } from "../app/.well-known/assetlinks.json/route.ts";
import { GET as iosAssociation } from "../app/.well-known/apple-app-site-association/route.ts";

const origin = "https://tomverse.app";
const challenge = "a".repeat(43);
const grant = "g".repeat(43);
const callback = origin + mobileAuthReturnPath(challenge, grant);
const fingerprint = Array(32).fill("AB").join(":");

test("the browser handoff accepts only the exact pending request and carries no secret in a query", () => {
  assert.equal(new URL(callback).search, "");
  assert.equal(readMobileAuthReturn(callback, origin, challenge), grant);
  assert.equal(readMobileAuthReturn(callback, origin + "/", challenge), grant);
  for (const [value, api, pending] of [
    [callback, origin, null], [callback, origin, "b".repeat(43)],
    [callback.replace(origin, "https://evil.test"), origin, challenge],
    [callback.replace("https:", "http:"), origin, challenge],
    [callback.replace("tomverse.app", "tomverse.app.evil.test"), origin, challenge],
    [callback.replace("https://", "https://user:password@"), origin, challenge],
    [callback.replace("/callback#", "/callback/extra#"), origin, challenge],
    [callback.replace("#", "?grant=leak#"), origin, challenge],
    [callback + "&grant=" + grant, origin, challenge],
    [callback + "&extra=value", origin, challenge],
    [callback.replace(grant, "invalid"), origin, challenge],
    [callback, "http://tomverse.app", challenge], [callback, origin + "/path", challenge],
    ["tomverse://auth/callback#grant=" + grant, origin, challenge],
  ]) assert.equal(readMobileAuthReturn(value, api, pending), null, value);
});

test("associations are default-off and publish only configured release signing identities", async () => {
  assert.deepEqual(mobileAppLinks({}), { android: [], ios: [] });
  assert.deepEqual(mobileAppLinks({ MOBILE_AUTH_APP_LINKS_ENABLED: "true" }), { android: [], ios: [] });
  const config = { MOBILE_AUTH_APP_LINKS_ENABLED: "true", MOBILE_AUTH_ANDROID_SHA256_CERT_FINGERPRINTS: fingerprint,
    MOBILE_AUTH_IOS_APP_ID: "A1B2C3D4E5.app.tomverse.shell" };
  const result = mobileAppLinks(config);
  assert.deepEqual(result.android[0].target, { namespace: "android_app", package_name: "app.tomverse.shell", sha256_cert_fingerprints: [fingerprint] });
  assert.deepEqual(result.ios, [{ appID: config.MOBILE_AUTH_IOS_APP_ID, paths: ["/mobile/auth/callback"] }]);
  assert.deepEqual(mobileAppLinks({ ...config, MOBILE_AUTH_ANDROID_SHA256_CERT_FINGERPRINTS: fingerprint + ",invalid", MOBILE_AUTH_IOS_APP_ID: "A1B2C3D4E5.other.app" }), { android: [], ios: [] });
  const previous = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, config);
    assert.deepEqual(await androidAssociation().json(), result.android);
    assert.deepEqual((await iosAssociation().json()).applinks.details, result.ios);
    delete process.env.MOBILE_AUTH_APP_LINKS_ENABLED;
    assert.equal(androidAssociation().status, 404);
    assert.equal(iosAssociation().status, 404);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("the browser fallback clears the URL, shows only a short-lived code, and loads no third-party resources", async () => {
  const response = callbackPage(new Request(origin + "/mobile/auth/callback"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const html = await response.text();
  assert.doesNotMatch(html, /<script[^>]*src=|<link|<iframe|<img/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const input = { value: "" };
  const history = [];
  let expire;
  runInNewContext(script, { URLSearchParams, location: new URL(callback),
    history: { replaceState: (...args) => history.push(args) }, document: { querySelector: () => input },
    setTimeout: (fn, delay) => { assert.equal(delay, 60_000); expire = fn; },
  });
  assert.equal(history[0][2], "/mobile/auth/callback");
  assert.equal(input.value, grant);
  expire();
  assert.equal(input.value, "");
});
