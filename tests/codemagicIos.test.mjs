import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";
import { iosBuildPlan } from "../apps/mobile/scripts/build-ios.mjs";

const document = parseDocument(readFileSync(new URL("../codemagic.yaml", import.meta.url), "utf8"), { uniqueKeys: true });
const config = document.toJS();
const workflow = config.workflows["ios-simulator"];
const scripts = workflow.scripts.map(step => step.script);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("Codemagic YAML parses and uses the supported macOS build tools", () => {
  assert.deepEqual(document.errors, []);
  assert.equal(workflow.instance_type, "mac_mini_m2");
  assert.ok(Number(workflow.environment.node.split(".")[0]) === 22);
  assert.ok(Number(workflow.environment.xcode.split(".")[0]) >= 26);
  assert.ok(workflow.max_build_duration > 0 && workflow.max_build_duration <= 45);
});

test("the initial workflow requires no signing credentials or automatic external action", () => {
  assert.equal(workflow.triggering, undefined);
  assert.equal(workflow.publishing, undefined);
  assert.equal(workflow.integrations, undefined);
  assert.equal(workflow.environment.groups, undefined);
  assert.equal(workflow.environment.ios_signing, undefined);
  const command = iosBuildPlan("/checkout");
  assert.ok(command.args.includes("CODE_SIGNING_ALLOWED=NO"));
  assert.ok(command.args.includes("generic/platform=iOS Simulator"));
});

test("preparation and validation complete before the native build and artifact packaging", () => {
  const install = scripts.findIndex(script => script.includes("npm ci"));
  const prepare = scripts.findIndex(script => script.includes("npm run prepare:ios"));
  const compile = scripts.findIndex(script => script.includes("npm run build:ios"));
  const archive = scripts.findIndex(script => script.includes("ditto "));
  assert.ok(install >= 0 && install < prepare && prepare < compile && compile < archive);
  for (const name of ["prepare:ios", "test:ios-prebuild", "test:mobile-billing", "check:ios-prebuild", "build:ios"]) assert.ok(packageJson.scripts[name]);
  assert.ok(scripts[prepare].includes("npm run test:ios-prebuild"));
  assert.ok(scripts[prepare].includes("npm run test:mobile-billing"));
  assert.ok(scripts[compile].includes("set -euo pipefail"), "tee must not hide a failed Xcode build");
  assert.ok(scripts[archive].includes("test -d"), "do not archive a missing application");
  const plan = iosBuildPlan(".");
  const buildPath = plan.args[plan.args.indexOf("-derivedDataPath") + 1].replaceAll("\\", "/");
  assert.ok(scripts[archive].includes(`${buildPath}/Build/Products/Debug-iphonesimulator/App.app`),
    "archive the application from the build wrapper's output directory");
});

test("collected artifacts are limited to the readiness receipt, build log and Simulator zip", () => {
  for (const path of workflow.artifacts) {
    assert.ok(path.startsWith(".tmp/codemagic/") && !path.includes("..", 1));
    assert.match(path, /\.(json|log|zip)$/);
    assert.ok(!path.includes("*"), "do not collect arbitrary checkout files");
  }
  assert.ok(workflow.artifacts.some(path => path.endsWith(".zip")));
  assert.ok(existsSync(new URL("../apps/mobile/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme", import.meta.url)));
});

test("TestFlight signing is manual and uses only the configured account identities", () => {
  const signed = config.workflows["ios-testflight"];
  assert.equal(signed.triggering, undefined);
  assert.equal(signed.integrations.app_store_connect, "Tomverse Codemagic Signing");
  assert.deepEqual(signed.environment.ios_signing, {
    provisioning_profiles: ["tomverse-app-store"],
    certificates: ["tomverse-apple-distribution"],
  });
  assert.equal(signed.environment.groups, undefined);
  assert.equal(signed.environment.vars.XCODE_PROJECT, "apps/mobile/ios/App/App.xcodeproj");
  assert.ok(!JSON.stringify(signed).includes("PRIVATE KEY"));
  assert.ok(!JSON.stringify(signed).includes("--create"));
});

test("TestFlight export cannot submit to external beta review or the public store", () => {
  const signed = config.workflows["ios-testflight"];
  assert.deepEqual(signed.publishing, { app_store_connect: {
    auth: "integration", submit_to_testflight: false, submit_to_app_store: false,
  } });
  const steps = signed.scripts.map(step => step.script);
  const profile = steps.findIndex(script => script.includes("xcode-project use-profiles"));
  const archive = steps.findIndex(script => script.includes("xcode-project build-ipa"));
  assert.ok(profile >= 0 && archive > profile);
  assert.ok(steps[profile].includes('"testFlightInternalTestingOnly":true'));
  assert.ok(steps[profile].includes("--archive-method app-store"));
  assert.ok(steps[archive].includes("--config Release"));
  assert.ok(steps[archive].includes("set -euo pipefail"));
  assert.ok(!steps[archive].includes("CODE_SIGNING_ALLOWED=NO"));
  for (const artifact of signed.artifacts) {
    assert.ok(!/\.(p8|p12|pem|mobileprovision)|Certificates|Keychain/i.test(artifact));
    assert.ok(artifact.startsWith("build/ios/ipa/") || artifact.startsWith(".tmp/codemagic/") || artifact.startsWith("/tmp/xcodebuild_logs/"));
  }
});

test("signed builds verify the bundle before signing and assign an explicit CI build number", () => {
  const steps = config.workflows["ios-testflight"].scripts.map(step => step.script);
  const prepare = steps.findIndex(script => script.includes("npm run prepare:ios"));
  const version = steps.findIndex(script => script.includes("agvtool new-version"));
  const profile = steps.findIndex(script => script.includes("xcode-project use-profiles"));
  assert.ok(prepare >= 0 && version > prepare && profile > version);
  assert.ok(steps[prepare].includes("npm run test:ios-prebuild"));
  assert.ok(steps[prepare].includes("npm run test:codemagic"));
  assert.ok(steps[version].includes("PROJECT_BUILD_NUMBER:?"));
  assert.ok(steps[version].includes('"$PROJECT_BUILD_NUMBER" =~ ^[1-9][0-9]*$'));
  assert.ok(steps[version].includes('agvtool new-version -all "$PROJECT_BUILD_NUMBER"'));
  const plist = readFileSync(new URL("../apps/mobile/ios/App/App/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
});
