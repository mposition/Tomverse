import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

test("the wrapper is executable", () => {
    // A workflow `run:` of a non-executable path fails with "Permission
    // denied" on every job at once, which is a worse outage than the flake.
    assert.ok(
        (statSync(SCRIPT_PATH).mode & 0o111) !== 0,
        `${SCRIPT_PATH} is not executable`
    );
});

test("the wrapper keeps the system dependencies rather than dropping them", () => {
    // Dropping `--with-deps` would make the flake disappear too, by removing
    // the fonts that render CJK text. This repository pins a typography
    // contract and screenshot baselines, so that failure would not be loud —
    // it would quietly change what the baselines mean.
    const script = read(SCRIPT_PATH);
    assert.match(script, /playwright install-deps/);
});
