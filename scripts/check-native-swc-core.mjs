/**
 * Turbopack has no fallback, and `npm ci` fails silently for the one package
 * it needs.
 *
 * On 2026-08-12 the push build of `develop` (`94545ca`, Admin Console E2E run
 * 31570256385) died three seconds into `next build` with:
 *
 *     ⚠ Attempted to load @next/swc-linux-x64-gnu, but it was not installed
 *     ⚠ Attempted to load @next/swc-linux-x64-musl, but an error occurred:
 *       /lib/x86_64-linux-gnu/libc.so: invalid ELF header
 *     Error: Turbopack is not supported on this platform (linux/x64) because
 *     native bindings are not available.
 *
 * That last line is wrong, and wrong in the direction that costs the most
 * time. linux/x64 is supported -- `@next/swc-linux-x64-gnu` is published for
 * it, the same job had built on it minutes earlier, and the identical commit
 * built on other branches. What actually happened is that the glibc binding
 * was not installed and the musl one was, so Next fell back to WASM and then
 * refused it, because Turbopack requires native bindings.
 *
 * The reason a missing binding is even possible is that the `@next/swc-*`
 * packages are `optionalDependencies`. npm treats a failure to install an
 * optional dependency as success: the install step goes green, and nothing
 * says a word until a build minutes later reports a platform problem that
 * does not exist. The repo's lockfile also carries no `libc` field on those
 * entries, so the lockfile alone cannot tell npm which of the two linux-x64
 * bindings this machine needs.
 *
 * This module decides one thing, and deliberately only one: whether the
 * native binding *this* platform needs is present after an install. The
 * distinction it draws is the whole point --
 *
 *   - the platform has a published binding and it is missing  -> the install
 *     dropped it. Fail, and say so, at install time rather than at build
 *     time, with the message naming the package and the fix.
 *   - the platform has no published binding at all            -> Next's own
 *     message is correct for once. Say so and do not fail, because a
 *     `--webpack` build is still legitimate there.
 *
 * It does not repair anything. Re-running the install is the repair, and
 * mutating `node_modules` from a build hook would hide the next occurrence
 * the same way the silence hid this one.
 */

/**
 * What `next` calls the binding for a given platform/arch/libc.
 *
 * Note the rename: the libc is `glibc` everywhere it is measured -- Node's
 * report, npm's `libc` field -- but the package is spelled `gnu`. Carrying
 * `glibc` into the name looks for `@next/swc-linux-x64-glibc`, which has
 * never existed, and the check then reports the platform as unsupported: the
 * exact wrong answer it was written to stop.
 */
const LIBC_PACKAGE_SUFFIX = { glibc: "gnu", musl: "musl" };

export const nativeSwcPackageName = ({ platform, arch, libc }) => {
  if (platform === "linux") {
    const suffix = LIBC_PACKAGE_SUFFIX[libc];
    return suffix ? `@next/swc-linux-${arch}-${suffix}` : null;
  }
  if (platform === "darwin") return `@next/swc-darwin-${arch}`;
  if (platform === "win32") return `@next/swc-win32-${arch}-msvc`;
  return null;
};

/**
 * glibc or musl, from Node's own report. `glibcVersionRuntime` is present
 * exactly when the process is linked against glibc, which is the standard
 * detection and needs no child process. Only linux distinguishes the two.
 */
export const detectLibc = (report) =>
  report?.header?.glibcVersionRuntime ? "glibc" : "musl";

export const VERDICTS = {
  ok: "ok",
  missing: "missing",
  unsupportedPlatform: "unsupported_platform",
  unknownPlatform: "unknown_platform",
};

/**
 * @param {object} input
 * @param {string} input.platform            `process.platform`
 * @param {string} input.arch                `process.arch`
 * @param {string} input.libc                "glibc" | "musl"; ignored off linux
 * @param {string[]} input.publishedPackages `next`'s optionalDependencies keys
 * @param {(name: string) => boolean} input.isInstalled
 *        Whether the package's own binary is on disk. A directory with no
 *        `.node` file in it is not an install -- a partially unpacked
 *        optional dependency looks exactly like that.
 */
export const checkNativeSwc = ({
  platform,
  arch,
  libc,
  publishedPackages,
  isInstalled,
}) => {
  const expected = nativeSwcPackageName({ platform, arch, libc });
  if (!expected) {
    return {
      verdict: VERDICTS.unknownPlatform,
      expected: null,
      failing: false,
      message:
        `No @next/swc binding is named for ${platform}/${arch}. This check ` +
        `does not know what to look for, so it is not claiming anything.`,
    };
  }

  if (!publishedPackages.includes(expected)) {
    return {
      verdict: VERDICTS.unsupportedPlatform,
      expected,
      failing: false,
      message:
        `next does not publish ${expected}, so ${platform}/${arch}` +
        `${platform === "linux" ? ` (${libc})` : ""} has no native Turbopack ` +
        `binding. Next's own "not supported on this platform" error is ` +
        `accurate here; build with \`next build --webpack\`.`,
    };
  }

  if (isInstalled(expected)) {
    return {
      verdict: VERDICTS.ok,
      expected,
      failing: false,
      message: `${expected} is installed.`,
    };
  }

  return {
    verdict: VERDICTS.missing,
    expected,
    failing: true,
    message:
      `${expected} is published for ${platform}/${arch}` +
      `${platform === "linux" ? ` (${libc})` : ""} but is not installed.\n\n` +
      `It is an optionalDependency, and npm treats a failed optional install ` +
      `as success -- which is why the install step went green. Turbopack has ` +
      `no fallback: the build would download @next/swc-wasm-nodejs, refuse ` +
      `it, and report "Turbopack is not supported on this platform", which ` +
      `is not what went wrong.\n\n` +
      `Re-run the install (\`npm ci\`, or \`rm -rf node_modules && npm ci\`). ` +
      `If it keeps happening on the same machine, install the binding ` +
      `explicitly at the version next asks for.`,
  };
};
