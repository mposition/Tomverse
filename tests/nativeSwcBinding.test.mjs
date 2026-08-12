import { strict as assert } from "node:assert";
import test from "node:test";

import {
  checkNativeSwc,
  detectLibc,
  nativeSwcPackageName,
  VERDICTS,
} from "../scripts/check-native-swc-core.mjs";

/**
 * The rule this pins is narrow on purpose: fail only when the platform *does*
 * have a published binding and it is not installed. That is exactly the case
 * where Next's own error ("Turbopack is not supported on this platform") is
 * false, and the only case where failing early saves anyone anything.
 */

const LINUX_X64 = [
  "@next/swc-linux-x64-gnu",
  "@next/swc-linux-x64-musl",
  "@next/swc-darwin-arm64",
  "@next/swc-win32-x64-msvc",
];

const check = (overrides) =>
  checkNativeSwc({
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    publishedPackages: LINUX_X64,
    isInstalled: () => true,
    ...overrides,
  });

test("glibc and musl on the same arch are different packages", () => {
  assert.equal(
    nativeSwcPackageName({ platform: "linux", arch: "x64", libc: "glibc" }),
    "@next/swc-linux-x64-gnu"
  );
  assert.equal(
    nativeSwcPackageName({ platform: "linux", arch: "x64", libc: "musl" }),
    "@next/swc-linux-x64-musl"
  );
});

test("libc does not enter the name off linux", () => {
  // macOS and Windows publish one binding per arch. Threading libc into those
  // names would look for a package that has never existed.
  assert.equal(
    nativeSwcPackageName({ platform: "darwin", arch: "arm64", libc: "musl" }),
    "@next/swc-darwin-arm64"
  );
  assert.equal(
    nativeSwcPackageName({ platform: "win32", arch: "x64", libc: "glibc" }),
    "@next/swc-win32-x64-msvc"
  );
});

test("glibc is detected from Node's own report, and its absence means musl", () => {
  assert.equal(detectLibc({ header: { glibcVersionRuntime: "2.39" } }), "glibc");
  assert.equal(detectLibc({ header: {} }), "musl");
  assert.equal(detectLibc(undefined), "musl");
});

test("a published binding that is installed passes", () => {
  const result = check({});
  assert.equal(result.verdict, VERDICTS.ok);
  assert.equal(result.failing, false);
});

test("a published binding that is missing fails", () => {
  // The develop failure: glibc runner, gnu binding published, not installed.
  const result = check({ isInstalled: () => false });
  assert.equal(result.verdict, VERDICTS.missing);
  assert.equal(result.failing, true);
  assert.equal(result.expected, "@next/swc-linux-x64-gnu");
  assert.match(result.message, /optionalDependency/);
  assert.match(result.message, /npm ci/);
});

test("the wrong libc's binding being present is not a pass", () => {
  // This is the shape of the actual failure: musl installed, gnu not. Loading
  // the musl binary on glibc gives "invalid ELF header", so counting any
  // linux-x64 binding as satisfaction would let exactly this through.
  const result = check({
    isInstalled: (name) => name === "@next/swc-linux-x64-musl",
  });
  assert.equal(result.verdict, VERDICTS.missing);
  assert.equal(result.expected, "@next/swc-linux-x64-gnu");
});

test("a platform with no published binding is reported, not failed", () => {
  // Here Next's message is accurate and `--webpack` is a real answer, so
  // failing the build would be this check inventing a problem.
  const result = check({
    arch: "riscv64",
    isInstalled: () => false,
  });
  assert.equal(result.verdict, VERDICTS.unsupportedPlatform);
  assert.equal(result.failing, false);
  assert.match(result.message, /--webpack/);
});

test("a platform the naming scheme does not cover claims nothing", () => {
  const result = check({ platform: "freebsd", isInstalled: () => false });
  assert.equal(result.verdict, VERDICTS.unknownPlatform);
  assert.equal(result.failing, false);
  assert.equal(result.expected, null);
});

test("the failure message names the package and contradicts Next's diagnosis", () => {
  // The whole point is not repeating Next's diagnosis. The message may quote
  // it -- connecting the two is what saves the reader the search -- but it has
  // to say it is wrong. A message that only echoed it would have become the
  // thing this check exists to correct.
  const result = check({ isInstalled: () => false });
  assert.match(result.message, /@next\/swc-linux-x64-gnu/);
  assert.match(result.message, /is not what went wrong/);
});
