import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLinkHost, configureAuthAppLinks, withAndroidAuthAppLink, withIosAuthAppLink } from "../apps/mobile/scripts/configure-auth-app-links.mjs";

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
});

test("sync configures generated projects idempotently and disabling removes only managed links", () => {
  const root = mkdtempSync(join(tmpdir(), "tomverse-auth-links-"));
  try {
    mkdirSync(join(root, "android/app/src/main"), { recursive: true });
    mkdirSync(join(root, "ios/App/App.xcodeproj"), { recursive: true });
    mkdirSync(join(root, "ios/App/App"), { recursive: true });
    const manifest = join(root, "android/app/src/main/AndroidManifest.xml");
    const project = join(root, "ios/App/App.xcodeproj/project.pbxproj");
    const entitlements = join(root, "ios/App/App/App.entitlements");
    writeFileSync(manifest, android);
    writeFileSync(project, 'buildSettings = {\nPRODUCT_BUNDLE_IDENTIFIER = app.tomverse.shell;\n};');
    const env = { NATIVE_AUTH_APP_LINKS_ENABLED: "true", VITE_TOMVERSE_API_ORIGIN: "https://tomverse.app" };
    configureAuthAppLinks(root, env);
    const before = [manifest, project, entitlements].map((path) => readFileSync(path, "utf8"));
    configureAuthAppLinks(root, env);
    assert.deepEqual([manifest, project, entitlements].map((path) => readFileSync(path, "utf8")), before);
    assert.match(before[1], /CODE_SIGN_ENTITLEMENTS = App\/App.entitlements/);
    configureAuthAppLinks(root, {});
    assert.doesNotMatch(readFileSync(manifest, "utf8"), /autoVerify/);
    assert.doesNotMatch(readFileSync(entitlements, "utf8"), /applinks:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
