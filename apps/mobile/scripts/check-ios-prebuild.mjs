import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
// Use the parsers already supplied by the declared Capacitor CLI dependency.
const mobileRequire = createRequire(new URL("../package.json", import.meta.url));
const cliRequire = createRequire(mobileRequire.resolve("@capacitor/cli/package.json"));
const plist = cliRequire("plist");
const xcode = cliRequire("xcode");
const { parseStringPromise } = cliRequire("xml2js");
const unquote = value => String(value ?? "").replace(/^"|"$/g, "");
const entries = value => Object.entries(value ?? {}).filter(([key]) => !key.endsWith("_comment"));

function read(root, path) {
  assert.ok(existsSync(join(root, path)), `Missing ${path}. Run npm run prepare:ios first.`);
  return readFileSync(join(root, path), "utf8");
}

function checkPrivacy(root, path) {
  const privacy = plist.parse(read(root, path));
  assert.ok(privacy.NSPrivacyAccessedAPITypes?.some(item =>
    item.NSPrivacyAccessedAPIType === "NSPrivacyAccessedAPICategoryUserDefaults" &&
    item.NSPrivacyAccessedAPITypeReasons?.includes("CA92.1")), `${path}: declare app-only UserDefaults access.`);
}

function bundleFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? bundleFiles(join(directory, entry.name)).map(path => join(entry.name, path)) : [entry.name]);
}

/** Local preparation evidence only; does not compile Swift, sign, upload or call an API. */
export async function checkIosPrebuild(root = repositoryRoot) {
  const mobile = "apps/mobile";
  const native = `${mobile}/ios/App/App`;
  const projectPath = `${mobile}/ios/App/App.xcodeproj`;
  const config = JSON.parse(read(root, `${native}/capacitor.config.json`));
  assert.equal(config.loggingBehavior, "none", "Synced native bridge logging must stay disabled.");
  for (const option of ["url", "cleartext", "allowNavigation"]) {
    assert.ok(config.server?.[option] === undefined, `Remove production server.${option}.`);
  }
  const info = plist.parse(read(root, `${native}/Info.plist`));
  for (const key of ["NSMicrophoneUsageDescription", "NSFaceIDUsageDescription", "NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription"]) {
    assert.ok(typeof info[key] === "string" && info[key].trim(), `Info.plist: missing ${key}.`);
  }
  assert.equal(info.NSLocationDefaultAccuracyReduced, true, "Retain approximate foreground location.");
  assert.ok(!info.UIBackgroundModes?.includes("location"), "Background location is outside this app's scope.");
  checkPrivacy(root, `${native}/PrivacyInfo.xcprivacy`);
  checkPrivacy(root, `${mobile}/native-auth/ios/Sources/MobileAuth/PrivacyInfo.xcprivacy`);
  const pluginPackage = read(root, `${mobile}/native-auth/Package.swift`);
  assert.ok(pluginPackage.includes('.process("PrivacyInfo.xcprivacy")'), "The Swift package must include its privacy resource.");

  const project = xcode.project(join(root, projectPath, "project.pbxproj"));
  project.parseSync();
  const objects = project.hash.project.objects;
  const [targetId, target] = entries(objects.PBXNativeTarget).find(([, item]) => unquote(item.name) === "App") ?? [];
  assert.ok(target, "Xcode App target is missing.");
  const projectObject = objects.PBXProject[project.hash.project.rootObject];
  assert.equal(Number(projectObject?.attributes?.TargetAttributes?.[targetId]?.SystemCapabilities?.["com.apple.InAppPurchase"]?.enabled), 1,
    "Enable the In-App Purchase capability on the Xcode App target.");
  const configurations = objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations;
  for (const item of configurations) {
    const settings = objects.XCBuildConfiguration[item.value].buildSettings;
    assert.equal(unquote(settings.IPHONEOS_DEPLOYMENT_TARGET), "17.4", "Retain the current iOS 17.4 minimum.");
    assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), config.appId, "Bundle ID and Capacitor appId differ.");
    assert.ok(Number(unquote(settings.SWIFT_VERSION)) >= 5, "RevenueCat requires Swift 5 or newer.");
  }
  const resources = target.buildPhases.flatMap(phase => objects.PBXResourcesBuildPhase?.[phase.value]?.files ?? [])
    .map(file => objects.PBXFileReference[objects.PBXBuildFile[file.value]?.fileRef])
    .filter(Boolean).map(file => unquote(file.path));
  for (const path of ["PrivacyInfo.xcprivacy", "public", "capacitor.config.json"]) {
    assert.ok(resources.includes(path), `Xcode Resources does not include ${path}.`);
  }
  const scheme = await parseStringPromise(read(root, `${projectPath}/xcshareddata/xcschemes/App.xcscheme`));
  const buildable = scheme.Scheme.BuildAction?.[0].BuildActionEntries?.[0].BuildActionEntry?.[0].BuildableReference?.[0].$;
  assert.equal(buildable?.BlueprintIdentifier, targetId, "Shared App scheme does not build the App target.");

  const packagePath = `${mobile}/ios/App/CapApp-SPM/Package.swift`;
  const packageSource = read(root, packagePath);
  const iosVersion = mobileRequire("@capacitor/ios/package.json").version;
  assert.ok(packageSource.includes(`exact: "${iosVersion}"`), "Run cap:sync:ios with the installed iOS runtime.");
  const packages = [...packageSource.matchAll(/\.package\(name:\s*"([^"]+)",\s*path:\s*"([^"]+)"\)/g)];
  for (const [, name, relativePath] of packages) {
    assert.ok(existsSync(resolve(root, dirname(packagePath), relativePath, "Package.swift")), `SPM dependency ${name} cannot be resolved. Run npm ci and cap:sync:ios on this host.`);
  }
  const requiredPlugins = ["MobileAuthPlugin", "MobileFilesPlugin", "MobileUpdatesPlugin", "PurchasesPlugin", "CAPBrowserPlugin", "GeolocationPlugin"];
  for (const name of requiredPlugins) assert.ok(config.packageClassList?.includes(name), `Synced iOS plugin ${name} is missing.`);
  for (const name of ["TomverseMobileAuth", "RevenuecatPurchasesCapacitor", "CapacitorBrowser", "CapacitorGeolocation"]) {
    assert.ok(packages.some(([, packageName]) => packageName === name), `SPM product ${name} is missing.`);
  }
  const icon = JSON.parse(read(root, `${native}/Assets.xcassets/AppIcon.appiconset/Contents.json`));
  for (const image of icon.images ?? []) assert.ok(existsSync(join(root, native, "Assets.xcassets/AppIcon.appiconset", image.filename)), "App icon asset is missing.");

  read(root, `${mobile}/dist/index.html`);
  const files = bundleFiles(join(root, mobile, "dist"));
  for (const path of files) {
    const copied = join(root, native, "public", path);
    assert.ok(existsSync(copied) && readFileSync(join(root, mobile, "dist", path)).equals(readFileSync(copied)), `Stale iOS web asset ${path}. Run prepare:ios.`);
  }
  return {
    status: "ready-for-remote-mac-build", iosMinimum: "17.4", capacitorVersion: iosVersion,
    appId: config.appId, pluginClasses: requiredPlugins, bundledFiles: files.length,
    swiftCompilation: "not-run", signing: "not-configured-by-preparation",
    note: "The first unsigned simulator build needs no Apple signing identity. Device signing and HTTPS browser-login associations require the real Apple Team and Bundle ID later.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await checkIosPrebuild(), null, 2)); }
  catch (error) { console.error(`iOS preparation failed: ${error.message}`); process.exitCode = 1; }
}
