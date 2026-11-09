// Does this change need the vendored AMUX server built and tested?
//
//   git diff --name-only <base> HEAD | node scripts/rust-vendor-scope.mjs
//
// Prints `vendor=` and `workspace=` true/false lines (and appends them to
// $GITHUB_OUTPUT when set), with the reasons on stderr.
//
// The root workspace (crates/, apps/tomverse-orchestrator) is gated the same
// way since 2026-11-09, to cut CI minutes before the repository goes private:
// it ran on every pull request and develop push (~190 a week) although most of
// them touch no Rust. Its crates reach outside their own trees only through
// include_str! of tests/fixtures/amux-*.json; tests/rustVendorScope.test.mjs
// fails if an include_str! or include_bytes! ever names a path these triggers
// do not cover. The job itself always runs and reports, so the required check
// never waits on a run that does not come.
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

const WORKSPACE_TRIGGERS = [
    /^crates\//,
    /^apps\/tomverse-orchestrator\//,
    /^Cargo\.(toml|lock)$/,
    /^tests\/fixtures\/amux-[^/]+\.json$/,
    /^\.github\/workflows\/orchestrator-rust\.yml$/,
    /^scripts\/rust-vendor-scope\.mjs$/,
    /^rust-toolchain(\.toml)?$/,
];

export const workspaceScope = (changedPaths) => {
    const paths = changedPaths.map((path) => path.trim()).filter((path) => path !== "");
    if (paths.length === 0) {
        return { workspace: true, reason: "no changed paths were given, so everything runs" };
    }
    const hit = paths.find((path) => WORKSPACE_TRIGGERS.some((pattern) => pattern.test(path)));
    if (hit) return { workspace: true, reason: `${hit} can change the root workspace's result` };
    return {
        workspace: false,
        reason: `none of ${paths.length} changed path(s) is in the root Rust workspace, its fixtures, the toolchain or this lane`,
    };
};

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
    const lines = input.split("\n");
    const { vendor, reason } = vendorScope(lines);
    const { workspace, reason: workspaceReason } = workspaceScope(lines);
    console.error(`vendored AMUX server: ${vendor ? "runs" : "skipped"} -- ${reason}.`);
    console.error(`root workspace: ${workspace ? "runs" : "skipped"} -- ${workspaceReason}.`);
    console.log(`vendor=${vendor}`);
    console.log(`workspace=${workspace}`);
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `vendor=${vendor}\nworkspace=${workspace}\n`);
    }
}
