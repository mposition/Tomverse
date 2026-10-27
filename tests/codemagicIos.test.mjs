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
