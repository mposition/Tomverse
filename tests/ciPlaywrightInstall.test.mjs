import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

/**
 * The Playwright install contract for CI.
 *
 * `npx playwright install --with-deps <browser>` is one command doing two
 * unrelated things: an apt transaction against the distribution mirror, and a
 * browser download from Playwright's CDN. Neither retries, and only the second
 * is covered by the `~/.cache/ms-playwright` cache the workflows restore — so
 * a cache hit still paid the apt cost every run.
 *
 * On 2026-08-05 that cost a red pull request: the mobile-chromium shard of PR
 * Fast Gate spent its whole ten-minute step budget fetching font packages,
 * timed out, and uploaded an empty `test-results` having never started a test.
 * The desktop shard of the same commit passed.
 *
 * The fix is `scripts/ci/install-playwright.sh`, and what makes it a fix rather
 * than a suggestion is that it is the only way in. A workflow that goes back to
 * calling Playwright directly loses the retries silently — nothing fails until
 * the next slow mirror minute — so the ban is asserted here instead.
 */

const WORKFLOW_DIR = ".github/workflows";
const SCRIPT_PATH = "scripts/ci/install-playwright.sh";

const read = (path) => readFileSync(path, "utf8");

const workflows = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({ name, source: read(join(WORKFLOW_DIR, name)) }));

test("no workflow installs Playwright without the retry wrapper", () => {
    for (const { name, source } of workflows) {
        assert.doesNotMatch(
            source,
            /playwright\s+install(-deps)?\b/,
            `${name} calls Playwright's installer directly; use ${SCRIPT_PATH}`
        );
    }
});

test("every workflow that needs a browser goes through the wrapper", () => {
    // Two independent signals of "this job drives a browser": it restores the
    // Playwright cache, or it runs a Playwright suite. Either one without an
    // install step is a job that works only while the cache is warm.
    const browserWorkflows = workflows.filter(
        ({ source }) =>
            source.includes("ms-playwright") || /playwright test/.test(source)
    );
    assert.ok(browserWorkflows.length > 0, "no browser workflow was found");
    for (const { name, source } of browserWorkflows) {
        assert.match(
            source,
            new RegExp(SCRIPT_PATH.replaceAll(".", "\\.")),
            `${name} drives a browser but never installs one through ${SCRIPT_PATH}`
        );
    }
});

const scriptDefault = (variable) => {
    const match = new RegExp(`^${variable}=(\\d+)$`, "m").exec(read(SCRIPT_PATH));
    assert.ok(match, `${SCRIPT_PATH} no longer declares ${variable}`);
    return Number(match[1]);
};

// The script's own budget, in minutes, plus the slack a step needs on top of it
// to report rather than be killed mid-report.
const STEP_SLACK_MINUTES = 5;
const requiredStepMinutes = (browsers) => {
    const heavy = browsers.some((browser) => browser === "webkit" || browser === "firefox");
    const deadline = scriptDefault(heavy ? "DEADLINE_HEAVY_DEFAULT" : "DEADLINE_LIGHT_DEFAULT");
    return Math.ceil(deadline / 60) + STEP_SLACK_MINUTES;
};

const installSteps = workflows.flatMap(({ name, source }) => {
    const lines = source.split("\n");
    return lines.flatMap((line, index) => {
        if (!line.includes(SCRIPT_PATH)) return [];
        const browsers = line.slice(line.indexOf(SCRIPT_PATH) + SCRIPT_PATH.length).trim().split(/\s+/).filter(Boolean);
        const timeout = lines
            .slice(Math.max(0, index - 6), index)
            .map((candidate) => /timeout-minutes:\s*(\d+)/.exec(candidate))
            .filter(Boolean)
            .at(-1);
        return [
            {
                workflow: name,
                browsers: browsers.length > 0 ? browsers : ["chromium"],
                timeoutMinutes: timeout ? Number(timeout[1]) : null,
            },
        ];
    });
});

test("the install step is given more time than its own retry loop needs", () => {
    // A retry loop inside a step timeout shorter than the loop is not a retry
    // loop: the run this script exists for died with two attempts unused, and
    // an exhausted loop killed by the step reports a bare timeout instead of
    // naming the half that failed.
    //
    // The number is read from the script rather than written here, because the
    // two drifted apart once already: the comment said "3 attempts of 5 minutes
    // plus backoff, per half" and the workflows said 20 minutes, and the worst
    // case was in fact above that.
    assert.ok(installSteps.length > 0, "no install step was found");
    for (const { workflow, browsers, timeoutMinutes } of installSteps) {
        // No explicit step timeout is allowed: the job timeout applies and
        // is far larger. What is not allowed is one too small to finish.
        if (timeoutMinutes === null) continue;
        const required = requiredStepMinutes(browsers);
        assert.ok(
            timeoutMinutes >= required,
            `${workflow}: install step for ${browsers.join(" ")} allows ${timeoutMinutes}m, below the ${required}m its budget can need`
        );
    }
});

test("a WebKit install is budgeted as the larger apt transaction it is", () => {
    // The 2026-08-17 daily security audit failure. WebKit's system dependencies
    // pull the GStreamer and FFmpeg stacks: 181 packages and 114 MB, against a
    // mirror giving ~140 kB/s. Three five-minute attempts fetched about half of
    // it and the step reported a mirror failure for a budget that was never
    // large enough to succeed, whatever the mirror did.
    const light = scriptDefault("DEADLINE_LIGHT_DEFAULT");
    const heavy = scriptDefault("DEADLINE_HEAVY_DEFAULT");
    assert.ok(
        heavy >= light * 2,
        `a WebKit install is budgeted ${heavy}s against Chromium's ${light}s, which does not reflect the transaction`
    );
    // 114 MB at the speed actually observed, with nothing left over, was 13
    // minutes; a budget under that is one no retry can rescue.
    assert.ok(heavy >= 20 * 60, `${heavy}s cannot fetch WebKit's dependencies on a slow mirror`);
    const attemptHeavy = scriptDefault("ATTEMPT_TIMEOUT_HEAVY_DEFAULT");
    assert.ok(
        attemptHeavy >= 13 * 60,
        `a single attempt of ${attemptHeavy}s cannot finish a fetch that takes 13 minutes, so every attempt is spent and none completes`
    );
    assert.ok(attemptHeavy < heavy, "an attempt may not be as long as the whole budget, or nothing is left to retry with");
});

test("the whole run is bounded by one deadline, not by attempts times a timeout", () => {
    const script = read(SCRIPT_PATH);
    // Attempts times a timeout says nothing about the waiting between attempts,
    // which is where the 2026-08-17 run spent minutes it was never charged for.
    assert.match(script, /DEADLINE_AT/);
    assert.match(script, /remaining_budget/);
    // Every attempt window is clamped to what is left, or the step timeout
    // becomes the real bound again and the report is lost with it.
    assert.match(script, /window="\$budget"/);
    // The browser download must not be starved by a slow apt half: its own
    // failure has to be its own.
    assert.match(script, /DOWNLOAD_RESERVE/);
});

test("the wrapper retries both halves and bounds each attempt", () => {
    const script = read(SCRIPT_PATH);
    // Split, because only the browser download is what the cache covers.
    assert.match(script, /retry "playwright install-deps"/);
    assert.match(script, /retry "playwright install"/);
    // Bounded per attempt, or the first attempt can consume the whole budget
    // and there is nothing left to retry with — the original failure exactly.
    assert.match(script, /timeout --signal=TERM/);
    assert.match(script, /ATTEMPT_TIMEOUT=/);
    // A stalled single package must not cost a whole attempt either.
    assert.match(script, /Acquire::Retries/);
    // Backoff rather than an immediate re-ask of the same bad minute.
    assert.match(script, /sleep "\$delay"/);
});

test("a retry clears the lock the attempt it retries is still holding", () => {
    // The retry loop was not enough on its own. `timeout` signals the process
    // group it made, but apt-get runs as root under Playwright's sudo and an
    // unprivileged runner cannot signal a root process, so a timed-out attempt
    // leaves apt-get alive holding /var/lib/dpkg/lock-frontend. The next two
    // attempts then died in about a second each on "Could not get lock", and
    // one slow mirror was reported as three failures (2026-08-06,
    // review-parity-shadow).
    const script = read(SCRIPT_PATH);
    assert.match(script, /release_dpkg_lock/);
    // Waiting first: a package that finishes installing is one the next
    // attempt does not have to fetch again.
    assert.match(script, /pgrep -x apt-get/);
    assert.match(script, /PLAYWRIGHT_INSTALL_DPKG_LOCK_WAIT/);
    // Escalation, because waiting forever inside a bounded step is just the
    // step timeout with extra steps.
    assert.match(script, /pkill -KILL -x apt-get/);
    // But escalation on a *stall*, not on the clock. Until 2026-08-17 the wait
    // was 120 seconds of wall time, so an apt-get thirteen minutes into a
    // thirteen-minute download was killed for being slow -- and the attempt
    // that killed it then had to fetch what it had just thrown away. What is
    // measured is whether apt is still making progress.
    assert.match(script, /apt_progress/);
    assert.match(
        script,
        /du -sb \/var\/cache\/apt\/archives/,
        "the download phase's progress must be observed"
    );
    assert.match(
        script,
        /stat -c %Y \/var\/lib\/dpkg\/status/,
        "the unpack and configure phases move no bytes into the cache; without a second signal they read as a stall"
    );
    assert.match(script, /stalled=\$\(\(stalled \+ 5\)\)/);
    // A killed apt-get can leave a half-configured package that fails every
    // later install until it is repaired.
    assert.match(script, /dpkg --configure -a/);
    // Wired to the half that takes the lock, and only that half.
    assert.match(
        script,
        /retry "playwright install-deps" release_dpkg_lock/,
        "the apt half must recover the lock between attempts"
    );
    assert.match(
        script,
        /retry "playwright install" ""/,
        "the browser download holds no system lock and needs no recovery"
    );
});

test("an abandoned apt run that finished is confirmed, not reported as out of budget", () => {
    // Waiting for the abandoned run spends the apt half's budget, and that run
    // may spend it finishing the install. On 2026-10-23 (#2928) apt set up its
    // last package five seconds before the wrapper reported "out of budget".
    const script = read(SCRIPT_PATH);
    assert.match(script, /APT_FINISHED_ALONE=1/, "release_dpkg_lock must say when apt exited on its own");
    assert.match(script, /terminated=1/, "an apt run we killed is not one that finished");
    assert.match(
        script,
        /if \[ "\$budget" -lt 30 \]; then[\s\S]*?APT_FINISHED_ALONE" -eq 1[\s\S]*?timeout --signal=TERM --kill-after=10s "\$CONFIRM_WINDOW"[\s\S]*?ran out of the install budget/,
        "the out-of-budget branch must confirm a finished run before reporting"
    );
    // apt is the last half, so the confirming attempt runs past the deadline and
    // is paid from the step's slack, together with the kill-after grace.
    const confirm = Number(/^CONFIRM_WINDOW=(\d+)$/m.exec(script)[1]);
    assert.ok(confirm + 10 < STEP_SLACK_MINUTES * 60, "the confirming attempt must fit in the slack above the deadline");
});

test("the browser download runs first and apt gets what it leaves", () => {
    // 2026-10-23 (#2938): a 39 kB/s mirror needed 664s, apt was given 675s and
    // was killed setting up its last package, with 225s held back for a browser
    // download that is a no-op on a cache hit and a fast CDN fetch otherwise.
    const script = read(SCRIPT_PATH);
    const download = script.indexOf('retry "playwright install" ""');
    const apt = script.indexOf('retry "playwright install-deps" release_dpkg_lock');
    assert.ok(download > 0 && apt > download, "the browser download must run before apt");
    assert.match(
        script,
        /DEADLINE_AT=\$\(\(STARTED_AT \+ DOWNLOAD_RESERVE\)\)\s+retry "playwright install" ""/,
        "the download is capped so a stalled CDN cannot spend apt's budget"
    );
    assert.match(
        script,
        /DEADLINE_AT="\$ENDS_AT"\s+retry "playwright install-deps"/,
        "apt runs to the end of the whole budget"
    );
});

test("a stalled browser download is retried inside its share, not spent in one attempt", () => {
    // 2026-11-13 (#3860): the CDN stalled the headless shell at 40%. The one
    // attempt was windowed to the whole 225s share, used all of it, and the
    // half reported "out of budget after 1 attempt" -- a retry the loop
    // promised and never made.
    const script = read(SCRIPT_PATH);
    const attempt = Number(/PLAYWRIGHT_DOWNLOAD_ATTEMPT_TIMEOUT:-(\d+)/.exec(script)?.[1]);
    const share = Number(/^DOWNLOAD_RESERVE=\$\(\(DEADLINE \/ (\d+)\)\)$/m.exec(script)?.[1]);
    assert.ok(attempt > 0 && share > 0, "the download attempt and its share must both be read from the script");
    const firstBackoff = 30;
    for (const name of ["DEADLINE_LIGHT_DEFAULT", "DEADLINE_HEAVY_DEFAULT"]) {
        const reserve = Math.floor(scriptDefault(name) / share);
        assert.ok(
            2 * attempt + firstBackoff <= reserve,
            `${name}: two ${attempt}s download attempts and the backoff between them must fit the ${reserve}s share`
        );
    }
    assert.match(
        script,
        /RETRY_WINDOW="\$DOWNLOAD_ATTEMPT_TIMEOUT"[\s\S]*?retry "playwright install" ""/,
        "the download half must use its own attempt window"
    );
    assert.match(
        script,
        /RETRY_WINDOW="\$ATTEMPT_TIMEOUT"[\s\S]*?retry "playwright install-deps"/,
        "apt goes back to its own attempt window"
    );
    assert.match(script, /window="\$RETRY_WINDOW"/);
});

test("the wrapper is executable", () => {
    // A workflow `run:` of a non-executable path fails with "Permission
    // denied" on every job at once, which is a worse outage than the flake.
    // Git's index is authoritative because Windows does not expose the POSIX
    // executable bits that the Linux runner receives at checkout.
    const indexEntry = execFileSync("git", ["ls-files", "--stage", "--", SCRIPT_PATH], {
        encoding: "utf8",
    });
    assert.match(indexEntry, /^100755\s/, `${SCRIPT_PATH} is not executable in Git`);
});

test("the wrapper keeps the system dependencies rather than dropping them", () => {
    // Dropping `--with-deps` would make the flake disappear too, by removing
    // the fonts that render CJK text. This repository pins a typography
    // contract and screenshot baselines, so that failure would not be loud —
    // it would quietly change what the baselines mean.
    const script = read(SCRIPT_PATH);
    assert.match(script, /playwright install-deps/);
});

const bash = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe") : "bash";
const noWindowsBash = process.platform === "win32" && !existsSync(bash);
function withMirrorFixture(action) {
    const root = mkdtempSync(join(tmpdir(), "tomverse-ci-apt-mirror-"));
    const path = join(root, "mirrors.txt");
    const source = read(SCRIPT_PATH).replaceAll("\r", "").match(/prefer_ubuntu_archive\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source, "the mirror selector function is missing");
    try {
        action(path, (githubActions) => execFileSync(bash, ["-c", `sudo() { "$@"; }\n${source}\nprefer_ubuntu_archive "$1"`, "mirror-fixture", path.replaceAll("\\", "/")], {
            encoding: "utf8", windowsHide: true, env: { ...process.env, GITHUB_ACTIONS: githubActions },
        }));
    } finally {
        if (existsSync(path)) unlinkSync(path);
        rmdirSync(root);
    }
}

const ARCHIVE_FIRST = "https://archive.ubuntu.com/ubuntu/\tpriority:0\n";

// 2026-11-11 14:11-15:02 UTC: archive.ubuntu.com did not resolve on the hosted
// runners. The earlier selector had rewritten the Azure entry into
// archive.ubuntu.com, so apt had no mirror left to fail over to and every
// Playwright job ran out of its install budget. The archive is now added ahead
// of Azure and every existing entry is kept as it is.
test("hosted CI puts the Ubuntu archive first and keeps every existing mirror entry", { skip: noWindowsBash }, () => {
    withMirrorFixture((path, run) => {
        const tail = "  https://azure.archive.ubuntu.com/ubuntu\r\n\thttps://azure.archive.ubuntu.com/ubuntu priority:2\nhttps://security.ubuntu.com/ubuntu/\nhttps://archive.ubuntu.com/ubuntu\nhttps://custom.example.invalid/ubuntu/\nhttps://azure.archive.ubuntu.com.invalid/ubuntu/\nhttps://azure.archive.ubuntu.com/ubuntu-other\n";
        const head = "# http://azure.archive.ubuntu.com/ubuntu\nhttps://azure.archive.ubuntu.com.invalid/ubuntu/\n";
        const firstAzure = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n";
        writeFileSync(path, head + firstAzure + tail);
        assert.match(run("true"), /archive\.ubuntu\.com first .*Azure mirror stays as the fallback/);
        assert.equal(read(path), head + ARCHIVE_FIRST + firstAzure + tail, "one line inserted before the first Azure entry, nothing rewritten");
    });
});

// The hosted runner's own list (actions/runner-images configure-apt-sources.sh).
// apt orders mirror+file entries by priority, lowest first, and draws equal
// priorities at random -- so the added line must out-rank Azure's priority:1,
// and Azure must still be in the list for apt to fall back to.
test("on the runner's mirror list the archive comes first and Azure stays as the next mirror", { skip: noWindowsBash }, () => {
    withMirrorFixture((path, run) => {
        const runner = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
        writeFileSync(path, runner);
        run("true");
        const lines = read(path).split("\n").filter(Boolean);
        assert.deepEqual(lines.slice(0, 2), ["https://archive.ubuntu.com/ubuntu/\tpriority:0", "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1"]);
        const byPriority = lines.map((line) => ({ host: new URL(line.split("\t")[0]).host, priority: Number(/priority:(\d+)/.exec(line)?.[1]) }))
            .sort((a, b) => a.priority - b.priority).map(({ host }) => host);
        assert.deepEqual(byPriority, ["archive.ubuntu.com", "azure.archive.ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com"]);
        assert.equal(new Set(lines.map((line) => /priority:(\d+)/.exec(line)?.[1])).size, lines.length, "no two mirrors share a priority, so apt's order is fixed");
        run("true");
        assert.equal(read(path), ARCHIVE_FIRST + runner, "a second run in the same job adds nothing");
    });
});

// #3439 (2026-11-07): ubuntu-26.04 image 20261101.64.1 had no Ubuntu apt source,
// so install-deps could not find a single font package.
function withAptFixture(action) {
    const root = mkdtempSync(join(tmpdir(), "tomverse-ci-apt-sources-"));
    const aptDir = join(root, "apt");
    const keyring = join(root, "ubuntu-archive-keyring.gpg");
    mkdirSync(join(aptDir, "sources.list.d"), { recursive: true });
    const source = read(SCRIPT_PATH).replaceAll("\r", "").match(/ensure_ubuntu_archive\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source, "the Ubuntu source check is missing");
    const added = join(aptDir, "sources.list.d", "tomverse-ubuntu-archive.sources");
    const run = ({ githubActions = "true", arch = "amd64", codename = "resolute" } = {}) => execFileSync(bash,
        ["-c", `sudo() { "$@"; }\n${source}\nensure_ubuntu_archive "$1" "$2" "$3" "$4"`, "apt-fixture",
            aptDir.replaceAll("\\", "/"), keyring.replaceAll("\\", "/"), codename, arch],
        { encoding: "utf8", windowsHide: true, env: { ...process.env, GITHUB_ACTIONS: githubActions } });
    try {
        action({ aptDir, keyring, added, run });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("a hosted runner with no Ubuntu apt source gets the archive for its release", { skip: noWindowsBash }, () => {
    withAptFixture(({ aptDir, keyring, added, run }) => {
        writeFileSync(join(aptDir, "sources.list.d", "microsoft-prod.list"), "deb [arch=amd64] https://packages.microsoft.com/ubuntu/26.04/prod resolute main\n");
        run(); assert.equal(existsSync(added), false, "no keyring: apt is left as it is");
        writeFileSync(keyring, "key");
        run({ githubActions: "false" }); assert.equal(existsSync(added), false, "a local run is left alone");
        run({ arch: "arm64" }); assert.equal(existsSync(added), false, "archive.ubuntu.com has no arm64");
        run({ codename: "" }); assert.equal(existsSync(added), false);
        assert.match(run(), /no Ubuntu apt source; added archive\.ubuntu\.com for resolute/);
        const text = read(added);
        assert.match(text, /^URIs: https:\/\/archive\.ubuntu\.com\/ubuntu\nSuites: resolute resolute-updates resolute-backports$/m);
        assert.match(text, /^URIs: https:\/\/security\.ubuntu\.com\/ubuntu\nSuites: resolute-security$/m);
        assert.equal((text.match(/^Signed-By: .*ubuntu-archive-keyring\.gpg$/gm) ?? []).length, 2);
    });
});

test("a runner whose apt already names an Ubuntu source is left alone", { skip: noWindowsBash }, () => {
    for (const [file, text] of [
        ["ubuntu.sources", "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\n"],
        ["custom.list", "deb https://archive.ubuntu.com/ubuntu resolute main\n"],
    ]) {
        withAptFixture(({ aptDir, keyring, added, run }) => {
            writeFileSync(keyring, "key");
            writeFileSync(join(aptDir, "sources.list.d", file), text);
            run(); assert.equal(existsSync(added), false, file);
        });
    }
});

test("local runs and missing mirror lists do not change apt configuration", { skip: noWindowsBash }, () => {
    withMirrorFixture((path, run) => {
        run("true"); assert.equal(existsSync(path), false);
        const original = "http://azure.archive.ubuntu.com/ubuntu\n";
        writeFileSync(path, original); run("false");
        assert.equal(read(path), original);
    });
});
