import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLinkHost, configureAuthAppLinks, withAndroidAuthAppLink, withIosAuthAppLink } from "../apps/mobile/scripts/configure-auth-app-links.mjs";
import viteConfig from "../apps/mobile/vite.config.ts";

const android = '<manifest><application><activity android:name=".MainActivity"><intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter></activity><activity android:name=".OtherActivity"></activity></application></manifest>';
const ios = '<plist><dict><key>existing</key><true/></dict></plist>';

test("native links enroll only HTTPS on the exact callback and preserve other capabilities", () => {
  assert.equal(authLinkHost("https://tomverse.app"), "tomverse.app");
  for (const value of ["http://tomverse.app", "https://tomverse.app/path", "https://user@tomverse.app", "https://tomverse.app:1234", "https://tomverse.app?x=y"]) {
    assert.throws(() => authLinkHost(value));
  }
  const manifest = withAndroidAuthAppLink(android, "tomverse.app");
  assert.match(manifest, /android:autoVerify="true"/);
  assert.match(manifest, /android:path="\/mobile\/auth\/callback"/);
  assert.doesNotMatch(manifest, /android:pathPrefix|android:scheme="tomverse"/);
  assert.equal(withAndroidAuthAppLink(manifest, "tomverse.app"), manifest);
  assert.match(withAndroidAuthAppLink(manifest, null), /android.intent.action.MAIN/);
  assert.doesNotMatch(withAndroidAuthAppLink(manifest, null), /autoVerify/);
  const entitlements = withIosAuthAppLink(ios, "tomverse.app");
  assert.match(entitlements, /<key>existing<\/key><true\/>/);
  assert.match(entitlements, /applinks:tomverse.app/);
  assert.equal(withIosAuthAppLink(entitlements, "tomverse.app"), entitlements);
  assert.doesNotMatch(withIosAuthAppLink(entitlements, null), /applinks:/);
  assert.doesNotMatch(withIosAuthAppLink(entitlements, null), /com.apple.developer.associated-domains/);
  const existing = '<plist><dict><key>com.apple.developer.associated-domains</key><array><string>webcredentials:existing.test</string></array></dict></plist>';
  const preserved = withIosAuthAppLink(withIosAuthAppLink(existing, "tomverse.app"), null);
  assert.match(preserved, /webcredentials:existing.test/);
});

test("sync configures generated projects idempotently and disabling removes only managed links", () => {
  const root = mkdtempSync(join(tmpdir(), "tomverse-auth-links-"));
  try {
    mkdirSync(join(root, "android/app/src/main"), { recursive: true });
    mkdirSync(join(root, "ios/App/App.xcodeproj"), { recursive: true });
    mkdirSync(join(root, "ios/App/App"), { recursive: true });
    const manifest = join(root, "android/app/src/main/AndroidManifest.xml");
    const project = join(root, "ios/App/App.xcodeproj/project.pbxproj");
    const entitlements = join(root, "ios/App/App/TomverseAuth.entitlements");
    writeFileSync(manifest, android);
    writeFileSync(project, 'buildSettings = {\nPRODUCT_BUNDLE_IDENTIFIER = app.tomverse.shell;\n};');
    const env = { NATIVE_AUTH_APP_LINKS_ENABLED: "true", VITE_MOBILE_AUTH_APP_LINK_ORIGIN: "https://links.tomverse.test" };
    configureAuthAppLinks(root, env);
    const before = [manifest, project, entitlements].map((path) => readFileSync(path, "utf8"));
    configureAuthAppLinks(root, env);
    assert.deepEqual([manifest, project, entitlements].map((path) => readFileSync(path, "utf8")), before);
    assert.match(before[1], /CODE_SIGN_ENTITLEMENTS = App\/TomverseAuth.entitlements/);
    configureAuthAppLinks(root, {});
    assert.doesNotMatch(readFileSync(manifest, "utf8"), /autoVerify/);
    assert.doesNotMatch(readFileSync(entitlements, "utf8"), /applinks:/);
    assert.doesNotMatch(readFileSync(entitlements, "utf8"), /com.apple.developer.associated-domains/);
    assert.doesNotMatch(readFileSync(project, "utf8"), /CODE_SIGN_ENTITLEMENTS/);
    configureAuthAppLinks(root, env);
    const withCapability = readFileSync(entitlements, "utf8").replace("</dict>", "<key>aps-environment</key><string>development</string></dict>");
    writeFileSync(entitlements, withCapability);
    configureAuthAppLinks(root, {});
    assert.match(readFileSync(project, "utf8"), /CODE_SIGN_ENTITLEMENTS/);
    assert.match(readFileSync(entitlements, "utf8"), /aps-environment/);
    assert.doesNotMatch(readFileSync(entitlements, "utf8"), /applinks:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enabled native auth links require an explicit return origin at build and sync", () => {
  assert.throws(() => configureAuthAppLinks("unused", { NATIVE_AUTH_APP_LINKS_ENABLED: "true" }), /VITE_MOBILE_AUTH_APP_LINK_ORIGIN/);
  const previous = [process.env.VITE_MOBILE_AUTH_APP_LINKS_ENABLED, process.env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN];
  try {
    process.env.VITE_MOBILE_AUTH_APP_LINKS_ENABLED = "true";
    process.env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN = "";
    assert.throws(() => viteConfig({ mode: "test", command: "build" }), /VITE_MOBILE_AUTH_APP_LINK_ORIGIN/);
    process.env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN = "https://links.tomverse.test";
    assert.ok(viteConfig({ mode: "test", command: "build" }));
  } finally {
    ["VITE_MOBILE_AUTH_APP_LINKS_ENABLED", "VITE_MOBILE_AUTH_APP_LINK_ORIGIN"].forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
});
