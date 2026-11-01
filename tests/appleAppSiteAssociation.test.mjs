import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET } from "../app/.well-known/apple-app-site-association/route.ts";

test("Apple can retrieve association JSON without a session or redirect", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json\b/);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("cache-control"), /public/);
  assert.ok(JSON.stringify(await response.json()).length < 131072);
});

test("the association authorizes only the existing signed Tomverse app", async () => {
  const body = await GET().json();
  const signedAppID = "F9KS3F6G9F.app.tomverse.shell";
  assert.deepEqual(body.webcredentials.apps, [signedAppID]);
  assert.equal(body.applinks.details.length, 1);
  assert.deepEqual(body.applinks.details[0].appIDs, [signedAppID]);
  assert.equal(body.activitycontinuation, undefined);
  assert.equal(body.appclips, undefined);
});

test("universal links claim the authentication callback without claiming other website pages", async () => {
  const body = await GET().json();
  assert.deepEqual(body.applinks.details[0].components, [{ "/": "/auth/mobile/callback" }]);
});

test("the association and installed app use the same production services and bundle", () => {
  const entitlements = readFileSync(new URL("../apps/mobile/ios/App/App/App.entitlements", import.meta.url), "utf8");
  assert.match(entitlements, /<string>applinks:tomverse\.app<\/string>/);
  assert.match(entitlements, /<string>webcredentials:tomverse\.app<\/string>/);
  const native = readFileSync(new URL("../apps/mobile/native-auth/ios/Sources/MobileAuth/MobileAuthPlugin.swift", import.meta.url), "utf8");
  assert.match(native, /callback: \.https\(host: url\.host!, path: "\/auth\/mobile\/callback"\)/);
});
