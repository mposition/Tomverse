// Does this change need the vendored AMUX server built and tested?
//
//   git diff --name-only <base> HEAD | node scripts/rust-vendor-scope.mjs
//
// Prints `vendor=true` or `vendor=false` (and appends it to $GITHUB_OUTPUT when
// set), with the reason on stderr.
//
// The vendored server (vendor/amux) is self-contained: its crates reach no file
// outside vendor/amux, so a change that touches none of the paths below cannot
// change its build or its test result. Running its ~14 minutes of build and
// 2,676 tests on every pull request and every develop push anyway made it the
// slowest check Railway's Wait for CI held staging for (2026-10-03: p50 ~17
// minutes for the lane, against ~2 before the vendor landed).
//
// When in doubt this says true: no input (the caller could not compute a diff)
// runs everything, and so does any path that names the Rust toolchain or this
// lane itself.

const TRIGGERS = [
    /^vendor\/amux\//,
    /^\.github\/workflows\/orchestrator-rust\.yml$/,
    /^scripts\/rust-vendor-scope\.mjs$/,
    /^rust-toolchain(\.toml)?$/,
];

export const vendorScope = (changedPaths) => {
    const paths = changedPaths.map((path) => path.trim()).filter((path) => path !== "");
    if (paths.length === 0) {
        return { vendor: true, reason: "no changed paths were given, so everything runs" };
    }
    const hit = paths.find((path) => TRIGGERS.some((pattern) => pattern.test(path)));
    if (hit) return { vendor: true, reason: `${hit} can change the vendored server's result` };
    return {
        vendor: false,
        reason: `none of ${paths.length} changed path(s) is under vendor/amux or names the Rust toolchain or this lane`,
    };
};

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { readFileSync, appendFileSync } = await import("node:fs");
    const input = process.argv.includes("--all") ? "" : readFileSync(0, "utf8");
    const { vendor, reason } = vendorScope(input.split("\n"));
    console.error(`vendored AMUX server: ${vendor ? "runs" : "skipped"} -- ${reason}.`);
    console.log(`vendor=${vendor}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `vendor=${vendor}\n`);
}
