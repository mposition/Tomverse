import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkIosPrebuild, repositoryRoot } from "./check-ios-prebuild.mjs";

export function iosBuildPlan(root, options = []) {
  assert.ok(options.every(option => ["--dry-run", "--device", "--release"].includes(option)), "Supported options: --dry-run, --device, --release.");
  const device = options.includes("--device");
  const configuration = options.includes("--release") ? "Release" : "Debug";
  return {
    command: "xcodebuild", cwd: root,
    args: ["-project", join(root, "apps/mobile/ios/App/App.xcodeproj"), "-scheme", "App",
      "-configuration", configuration, "-sdk", device ? "iphoneos" : "iphonesimulator",
      "-destination", device ? "generic/platform=iOS" : "generic/platform=iOS Simulator",
      "-derivedDataPath", join(root, ".tmp/ios-build", `${configuration}-${device ? "device" : "simulator"}`),
      "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "build"],
  };
}

export async function buildIos(options, { root = repositoryRoot, platform = process.platform, run = spawnSync } = {}) {
  const plan = iosBuildPlan(root, options);
  if (options.includes("--dry-run")) return { ...plan, executed: false, signed: false, uploaded: false };
  assert.equal(platform, "darwin", "Run the iOS build on a Mac with Xcode 26+. On Windows use npm run prepare:ios and build:ios -- --dry-run.");
  await checkIosPrebuild(root);
  const version = run("xcodebuild", ["-version"], { cwd: root, encoding: "utf8" });
  assert.ok(version.status === 0 && Number(version.stdout?.match(/^Xcode (\d+)/m)?.[1]) >= 26,
    "Select a full Xcode 26+ installation using xcode-select before building.");
  const result = run(plan.command, plan.args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `xcodebuild failed (${result.status ?? result.signal}).`);
  return { status: "unsigned-build-complete", configuration: options.includes("--release") ? "Release" : "Debug", signed: false, uploaded: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await buildIos(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
