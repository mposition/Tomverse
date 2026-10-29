import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { checkIosPrebuild, repositoryRoot } from "../apps/mobile/scripts/check-ios-prebuild.mjs";
import { buildIos, iosBuildPlan } from "../apps/mobile/scripts/build-ios.mjs";

const native = "apps/mobile/ios/App/App";
const project = "apps/mobile/ios/App/App.xcodeproj";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tomverse-ios-prebuild-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const edit = (path, transform) => write(path, transform(readFileSync(join(root, path), "utf8")));
  for (const path of [`${native}/Info.plist`, `${native}/PrivacyInfo.xcprivacy`, `${project}/project.pbxproj`,
    `${project}/xcshareddata/xcschemes/App.xcscheme`, "apps/mobile/native-auth/Package.swift",
    "apps/mobile/native-auth/ios/Sources/MobileAuth/PrivacyInfo.xcprivacy", "apps/mobile/ios/App/CapApp-SPM/Package.swift"]) {
    write(path, readFileSync(join(repositoryRoot, path)));
  }
  const packagePath = "apps/mobile/ios/App/CapApp-SPM/Package.swift";
  for (const [, relative] of readFileSync(join(root, packagePath), "utf8").matchAll(/\.package\(name:\s*"[^"]+",\s*path:\s*"([^"]+)"\)/g)) {
    const target = join(dirname(packagePath), relative, "Package.swift");
    if (!existsSync(join(root, target))) write(target, "// fixture dependency");
  }
  cpSync(join(repositoryRoot, native, "Assets.xcassets/AppIcon.appiconset"), join(root, native, "Assets.xcassets/AppIcon.appiconset"), { recursive: true });
  write(`${native}/capacitor.config.json`, JSON.stringify({ appId: "app.tomverse.shell", loggingBehavior: "none",
    packageClassList: ["MobileAuthPlugin", "MobileFilesPlugin", "MobileUpdatesPlugin", "PurchasesPlugin", "CAPBrowserPlugin", "GeolocationPlugin"] }));
  write("apps/mobile/dist/index.html", "<html>fixture</html>");
  write(`${native}/public/index.html`, "<html>fixture</html>");
  return { root, write, edit };
}

test("a synced project reports local readiness without claiming a Swift build", async t => {
  const result = await checkIosPrebuild(fixture(t).root);
  assert.equal(result.status, "ready-for-remote-mac-build");
  assert.equal(result.swiftCompilation, "not-run");
});

test("a privacy file must be included in the actual target resources", async t => {
  const f = fixture(t);
  f.edit(`${project}/project.pbxproj`, text => text.replace(/^.*PrivacyInfo\.xcprivacy in Resources.*,[\r\n]+/m, ""));
  await assert.rejects(checkIosPrebuild(f.root), /Resources does not include PrivacyInfo/);
});

test("iOS purchases require the capability on the actual App target", async t => {
  const f = fixture(t);
  f.edit(`${project}/project.pbxproj`, text => text.replace(/com\.apple\.InAppPurchase = \{\s*enabled = 1;/, "com.apple.InAppPurchase = { enabled = 0;"));
  await assert.rejects(checkIosPrebuild(f.root), /In-App Purchase capability/);
});

test("the Purchases Swift SDK requires a compatible target language version", async t => {
  const f = fixture(t);
  f.edit(`${project}/project.pbxproj`, text => text.replaceAll("SWIFT_VERSION = 5.0", "SWIFT_VERSION = 4.0"));
  await assert.rejects(checkIosPrebuild(f.root), /RevenueCat requires Swift 5/);
});

test("UserDefaults requires a valid privacy reason in the native plugin resource", async t => {
  const f = fixture(t);
  f.edit("apps/mobile/native-auth/ios/Sources/MobileAuth/PrivacyInfo.xcprivacy", text => text.replace("CA92.1", ""));
  await assert.rejects(checkIosPrebuild(f.root), /declare app-only UserDefaults/);
});

test("a copied bundle that differs from production output is refused", async t => {
  const f = fixture(t); f.write(`${native}/public/index.html`, "old bundle");
  await assert.rejects(checkIosPrebuild(f.root), /Stale iOS web asset/);
});

for (const plugin of ["MobileFilesPlugin", "MobileUpdatesPlugin"]) test(`missing ${plugin} registration is found before reaching a Mac`, async t => {
  const f = fixture(t);
  f.edit(`${native}/capacitor.config.json`, text => { const data = JSON.parse(text); data.packageClassList = data.packageClassList.filter(name => name !== plugin); return JSON.stringify(data); });
  await assert.rejects(checkIosPrebuild(f.root), new RegExp(`plugin ${plugin} is missing`));
});

test("the shared scheme must reference the real native target", async t => {
  const f = fixture(t);
  f.edit(`${project}/xcshareddata/xcschemes/App.xcscheme`, text => text.replaceAll('BlueprintIdentifier="504EC3031FED79650016851F"', 'BlueprintIdentifier="MISSING"'));
  await assert.rejects(checkIosPrebuild(f.root), /scheme does not build the App target/);
});

test("missing local SPM dependencies are caught after a checkout is moved", async t => {
  const f = fixture(t);
  f.edit("apps/mobile/ios/App/CapApp-SPM/Package.swift", text => text.replace('path: "../../../native-auth"', 'path: "../../../absent-plugin"'));
  await assert.rejects(checkIosPrebuild(f.root), /SPM dependency TomverseMobileAuth cannot be resolved/);
});

test("build plans use an unsigned simulator by default and never upload", async () => {
  const result = await buildIos(["--dry-run"], { platform: "win32", run: () => { throw Error("must not execute"); } });
  assert.equal(result.executed, false); assert.equal(result.uploaded, false);
  assert.ok(result.args.includes("generic/platform=iOS Simulator"));
  assert.ok(result.args.includes("CODE_SIGNING_ALLOWED=NO"));
  assert.equal(result.args.at(-1), "build");
  assert.ok(iosBuildPlan("/source", ["--device", "--release"]).args.includes("iphoneos"));
  assert.throws(() => iosBuildPlan("/source", ["--upload"]), /Supported options/);
});

test("Windows cannot accidentally execute the remote build step", async () => {
  await assert.rejects(buildIos([], { platform: "win32", run: () => { throw Error("must not execute"); } }), /Run the iOS build on a Mac/);
});

test("an old Xcode is rejected without dispatching a build", async t => {
  let commands = 0;
  await assert.rejects(buildIos([], { root: fixture(t).root, platform: "darwin", run: () => { commands++; return { status: 0, stdout: "Xcode 25.0\n" }; } }), /Xcode 26/);
  assert.equal(commands, 1);
});

test("a failing Xcode command is not reported as a completed iOS build", async t => {
  await assert.rejects(buildIos([], { root: fixture(t).root, platform: "darwin", run: (_cmd, args) => args.includes("-version") ? { status: 0, stdout: "Xcode 26.0\n" } : { status: 65 } }), /xcodebuild failed/);
});

test("a successful command reports only an unsigned build and does not publish", async t => {
  const commands = [];
  const result = await buildIos([], { root: fixture(t).root, platform: "darwin", run: (command, args) => {
    commands.push([command, args]); return { status: 0, stdout: "Xcode 26.0\n" };
  } });
  assert.equal(commands.length, 2);
  assert.equal(result.status, "unsigned-build-complete");
  assert.equal(result.signed, false); assert.equal(result.uploaded, false);
});
