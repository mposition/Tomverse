import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    CONTENT_HASH_WINDOW_MS,
    DOCUMENTED_UPLOAD_HOSTS,
    ENDPOINTS,
    REPLAY_WINDOW_MS,
    UNPUBLISH_PLATFORMS,
    buildPostRequest,
    checkHttpsHost,
    computeZernioSignature,
    createWebhookServer,
    errorSummary,
    journalPath,
    loadPlan,
    newWebhookCounters,
    processWebhookDelivery,
    readJsonl,
    recoveryWindow,
    redactId,
    redactText,
    resultsFile,
    runCli,
    scanForRequestKey,
    summarizeRecords,
    urlHostOnly,
    validateMaxPages,
    verifyZernioSignature,
} from "../scripts/marketing/zernio-s0-probe.mjs";

/**
 * The probe talks to a vendor with real social accounts behind it, so what is
 * asserted here is what it must never do: write without a plan, an allowlist
 * match and --execute; lose a request to a timeout; resend on a scan that did
 * not read everything; PUT to an undocumented host; mix two runs; let an
 * unauthenticated webhook touch the record; or print error prose, credentials
 * or comment text.
 *
 * Tests that write take their directory from ZERNIO_S0_TEST_BASE_DIR when it is
 * set, so a sandbox that forbids the OS temp directory can point them at a
 * writable one. Tests that do not write never touch the filesystem.
 */

const FAKE_KEY = "sk_" + "0123456789abcdef".repeat(4);
const PROFILE = "6a0000000000000000000001";
const X_ACCOUNT = "64e1f0a9e2b5af0012ab34de";
const LI_ACCOUNT = "64e1f0a9e2b5af0012ab34ef";
const BRAND_ACCOUNT = "64e1f0a9e2b5af0012abffff";
const POST_ID = "65f1c0a9e2b5af0012ab34cd";
const LABEL = "Tomverse S0 verification post - please ignore";

const basePlan = (overrides = {}) => ({
    label: LABEL,
    testProfileId: PROFILE,
    confirmTestAccountsOnly: true,
    allowlist: { accounts: [{ platform: "twitter", accountId: X_ACCOUNT }, { platform: "linkedin", accountId: LI_ACCOUNT }] },
    mode: "publishNow",
    targets: [{ platform: "twitter", accountId: X_ACCOUNT }],
    ...overrides,
});

const capture = () => {
    let text = "";
    return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
};

/** A fresh, empty base directory for one test, removed afterwards. */
const tempBase = (t) => {
    const root = process.env.ZERNIO_S0_TEST_BASE_DIR;
    if (root) mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root ?? tmpdir(), "zernio-s0-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/** A run directory path that does not exist yet. */
const tempRun = (t) => join(tempBase(t), "run");

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const accountsResponse = (accounts = [{ _id: X_ACCOUNT, platform: "twitter", profileId: PROFILE, isActive: true }, { _id: LI_ACCOUNT, platform: "linkedin", profileId: PROFILE, isActive: true }]) => json(200, { accounts });

/** A fetch stub that routes by method + host-less path and records every call. */
const router = (routes) => {
    const calls = [];
    const impl = async (url, init = {}) => {
        const parsed = new URL(url);
        const key = `${init.method ?? "GET"} ${parsed.hostname === "zernio.com" ? parsed.pathname : parsed.hostname + parsed.pathname}`;
        calls.push({ key, url: String(url), init });
        const handler = routes[key];
        if (!handler) throw new Error(`unexpected call ${key}`);
        return handler({ url: parsed, init, calls });
    };
    return { impl, calls };
};

const s0Post = (overrides = {}) => ({
    _id: POST_ID,
    content: `[${LABEL}] twitter abcd1234 2026-09-16T00:00:00.000Z`,
    status: "published",
    metadata: { s0RequestKey: "11111111-2222-3333-4444-555555555555" },
    platforms: [{ platform: "twitter", accountId: { _id: X_ACCOUNT, platform: "twitter", username: "@brand_handle" }, status: "published", platformPostId: "185", platformPostUrl: "https://twitter.com/secret_handle/status/185" }],
    ...overrides,
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * Runs the CLI with injected fetch, clock and file reads. `run` becomes
 * `--run <dir>`; without it, `base` is the injected base directory, and without
 * either nothing may be written.
 */
const cli = (argv, { plan = basePlan(), fetchImpl, run, base, now, env } = {}) => {
    const stdout = capture();
    const stderr = capture();
    return runCli([...argv, ...(run ? ["--run", run] : [])], {
        env: env ?? { ZERNIO_API_KEY: FAKE_KEY },
        fetchImpl: fetchImpl ?? (async () => { throw new Error("fetch must not be called"); }),
        readFile: (path, encoding) => (path === "plan.json" ? JSON.stringify(plan) : path === "sample.jpg" ? JPEG : readFileSync(path, encoding)),
        baseDir: base ?? join("Z:\\", "zernio-s0-must-not-be-written"),
        now,
        stdout,
        stderr,
    }).then((code) => ({ code, stdout: stdout.text, stderr: stderr.text }));
};

// --- redaction ---------------------------------------------------------------

test("redactId keeps only the last four characters", () => {
    assert.equal(redactId(X_ACCOUNT), "…34de");
    assert.equal(redactId(""), "(none)");
    assert.equal(redactId("abc"), "…***");
});

test("redactText removes the live key, key-shaped strings and bearer tokens", () => {
    const text = `key=${FAKE_KEY} header=Bearer abc.def-ghi other=zrk_${"a".repeat(20)} secret=whsec-value-123`;
    const out = redactText(text, [FAKE_KEY, "whsec-value-123"]);
    for (const leaked of [FAKE_KEY, "abc.def-ghi", "zrk_aaaa", "whsec-value-123"]) assert.ok(!out.includes(leaked), leaked);
    assert.ok(!redactText(`sk_${"f".repeat(64)}`).includes("ffff"));
});

test("urlHostOnly drops the path that carries a profile handle", () => {
    assert.equal(urlHostOnly("https://twitter.com/acmecorp/status/1"), "twitter.com");
    assert.equal(urlHostOnly(undefined), null);
});

test("errorSummary keeps tokens only and drops error prose entirely", () => {
    const summary = errorSummary(403, {
        error: 'Account 6a0f (facebook "Brand Page @brand_handle") is disconnected',
        type: "invalid_request_error",
        code: "ACCOUNT_DISCONNECTED",
        param: "platforms[0].accountId",
        platform: "a sentence with spaces is not a token",
        details: { existingPostId: POST_ID },
    });
    assert.deepEqual(summary, { httpStatus: 403, type: "invalid_request_error", code: "ACCOUNT_DISCONNECTED", param: "platforms[0].accountId", existingPostId: POST_ID });
});

test("error prose from the API reaches neither stdout nor the results file", async (t) => {
    const run = tempRun(t);
    const fetch = router({ [`GET /api/v1/posts/${POST_ID}`]: () => json(404, { error: "Post by @brand_handle not found", type: "not_found", code: "post_not_found" }) });
    const result = await cli(["status", POST_ID], { fetchImpl: fetch.impl, run });
    assert.equal(result.code, 0);
    const written = readFileSync(resultsFile(run), "utf8");
    for (const text of [result.stdout, written]) {
        assert.ok(!text.includes("brand_handle"));
        assert.ok(text.includes("post_not_found"));
        assert.ok(!text.includes(FAKE_KEY));
    }
});

// --- plan, allowlist and --execute --------------------------------------------

test("loadPlan refuses a plan without a test profile, an allowlist, or with a target outside it", () => {
    const read = (plan) => () => JSON.stringify(plan);
    assert.throws(() => loadPlan("p", read(basePlan({ testProfileId: undefined }))), /testProfileId/);
    assert.throws(() => loadPlan("p", read(basePlan({ allowlist: { accounts: [] } }))), /allowlist/);
    assert.throws(() => loadPlan("p", read(basePlan({ targets: [{ platform: "twitter", accountId: BRAND_ACCOUNT }] }))), /not in plan.allowlist/);
    assert.throws(() => loadPlan(undefined), /--plan/);
});

test("post without --execute describes the plan, sends nothing and writes nothing", async () => {
    const result = await cli(["post", "--plan", "plan.json"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /dry-run/);
    assert.doesNotMatch(result.stdout, /run directory/);
    assert.ok(!result.stdout.includes(FAKE_KEY));
    assert.ok(!result.stdout.includes(X_ACCOUNT));
});

test("dry runs of post, upload and delete need no API key", async () => {
    for (const argv of [["post", "--plan", "plan.json"], ["upload", "sample.jpg", "--plan", "plan.json"], ["delete", POST_ID, "--plan", "plan.json"]]) {
        const result = await cli(argv, { env: {} });
        assert.equal(result.code, 0, `${argv[0]}: ${result.stderr}`);
        assert.match(result.stdout, /dry-run/);
    }
});

test("post --execute refuses a plan that does not confirm test accounts", async () => {
    const result = await cli(["post", "--plan", "plan.json", "--execute"], { plan: basePlan({ confirmTestAccountsOnly: false }) });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /confirmTestAccountsOnly/);
});

test("delete is refused without a plan, even with --execute, and sends nothing", async () => {
    const fetch = router({});
    const result = await cli(["delete", POST_ID, "--execute"], { fetchImpl: fetch.impl, plan: undefined });
    assert.equal(result.code, 2);
    assert.equal(fetch.calls.length, 0);
});

test("delete and unpublish without --execute send nothing", async () => {
    for (const argv of [["delete", POST_ID, "--plan", "plan.json"], ["delete", POST_ID, "--plan", "plan.json", "--platform", "linkedin"]]) {
        const result = await cli(argv);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /dry-run/);
    }
});

test("delete --execute refuses when the API places an allowlisted account on another profile", async () => {
    const fetch = router({ "GET /api/v1/accounts": () => accountsResponse([{ _id: X_ACCOUNT, platform: "twitter", profileId: "brand-profile", isActive: true }, { _id: LI_ACCOUNT, platform: "linkedin", profileId: PROFILE, isActive: true }]) });
    const result = await cli(["delete", POST_ID, "--plan", "plan.json", "--platform", "twitter", "--execute"], { fetchImpl: fetch.impl });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /another profile/);
    assert.deepEqual(fetch.calls.map((call) => call.key), ["GET /api/v1/accounts"]);
});

test("delete --execute refuses a post that is not a recognisable S0 test post", async () => {
    const cases = [
        s0Post({ metadata: {} }),
        s0Post({ content: "Our big launch!" }),
        s0Post({ platforms: [{ platform: "twitter", accountId: BRAND_ACCOUNT, status: "published" }] }),
    ];
    for (const post of cases) {
        const fetch = router({ "GET /api/v1/accounts": () => accountsResponse(), [`GET /api/v1/posts/${POST_ID}`]: () => json(200, { post }) });
        const result = await cli(["delete", POST_ID, "--plan", "plan.json", "--platform", "twitter", "--execute"], { fetchImpl: fetch.impl });
        assert.equal(result.code, 2);
        assert.match(result.stderr, /not a recognisable S0 test post/);
        assert.ok(fetch.calls.every((call) => call.init.method !== "DELETE" && !call.key.endsWith("/unpublish")));
    }
});

test("delete --execute unpublishes a verified S0 post exactly once", async (t) => {
    const fetch = router({
        "GET /api/v1/accounts": () => accountsResponse(),
        [`GET /api/v1/posts/${POST_ID}`]: () => json(200, { post: s0Post() }),
        [`POST /api/v1/posts/${POST_ID}/unpublish`]: () => json(200, { success: true, message: "Post deleted from twitter successfully" }),
    });
    const result = await cli(["delete", POST_ID, "--plan", "plan.json", "--platform", "twitter", "--execute"], { fetchImpl: fetch.impl, run: tempRun(t) });
    assert.equal(result.code, 0);
    assert.equal(fetch.calls.filter((call) => call.key.endsWith("/unpublish")).length, 1);
    assert.ok(!result.stdout.includes("brand_handle") && !result.stdout.includes("secret_handle"));
});

test("unpublish on a platform the docs mark unsupported is refused before any call", async () => {
    assert.equal(UNPUBLISH_PLATFORMS.has("instagram"), false);
    assert.equal(UNPUBLISH_PLATFORMS.has("tiktok"), false);
    for (const platform of ["instagram", "tiktok"]) {
        const result = await cli(["delete", POST_ID, "--plan", "plan.json", "--platform", platform, "--execute"]);
        assert.equal(result.code, 2);
        assert.match(result.stderr, /not supported/);
    }
});

test("an endpoint the docs did not confirm is refused, not guessed", async () => {
    assert.equal(ENDPOINTS.platformVisibility.confirmed, false);
    const result = await cli(["visibility", POST_ID, "--execute"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not confirmed/);
});

// --- upload -------------------------------------------------------------------

const presignRoutes = ({ uploadUrl, publicUrl = "https://media.zernio.com/temp/1_sample.jpg", putStatus = 200 }) => ({
    "GET /api/v1/accounts": () => accountsResponse(),
    "POST /api/v1/media/presign": () => json(200, { uploadUrl, publicUrl, key: "temp/1_sample.jpg", expiresIn: 3600 }),
    [`PUT ${new URL(uploadUrl).hostname}${new URL(uploadUrl).pathname}`]: () => new Response("", { status: putStatus }),
});

test("no presigned upload host is documented, so none is trusted by default", () => {
    assert.deepEqual(DOCUMENTED_UPLOAD_HOSTS, []);
    assert.equal(checkHttpsHost("http://uploads.example.com/x", ["uploads.example.com"]).reason, "not_https");
    assert.equal(checkHttpsHost("https://evil.example.com/x", ["uploads.example.com"]).reason, "host_not_allowlisted");
    assert.equal(checkHttpsHost("https://user:pw@uploads.example.com/x", ["uploads.example.com"]).reason, "credentials_in_url");
    assert.equal(checkHttpsHost("https://uploads.example.com/x", ["uploads.example.com"]).ok, true);
});

test("upload --execute needs a confirmed plan and verifies the allowlist first", async () => {
    const refused = await cli(["upload", "sample.jpg", "--plan", "plan.json", "--execute"], { plan: basePlan({ confirmTestAccountsOnly: false }) });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /confirmTestAccountsOnly/);

    const fetch = router({ "GET /api/v1/accounts": () => accountsResponse([]) });
    const mismatch = await cli(["upload", "sample.jpg", "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl });
    assert.equal(mismatch.code, 2);
    assert.deepEqual(fetch.calls.map((call) => call.key), ["GET /api/v1/accounts"]);
});

test("upload refuses an http or foreign presigned URL without PUTting or printing it", async (t) => {
    for (const [uploadUrl, allow, reason] of [
        ["http://uploads.example.com/put?sig=SECRET", "uploads.example.com", /not_https/],
        ["https://evil.example.net/put?sig=SECRET", undefined, /host_not_allowlisted/],
        ["https://evil.example.net/put?sig=SECRET", "uploads.example.com", /host_not_allowlisted/],
    ]) {
        const run = tempRun(t);
        const fetch = router(presignRoutes({ uploadUrl }));
        const result = await cli(["upload", "sample.jpg", "--plan", "plan.json", "--execute", ...(allow ? ["--allow-upload-host", allow] : [])], { fetchImpl: fetch.impl, run });
        assert.equal(result.code, 2);
        assert.match(result.stderr, reason);
        assert.equal(fetch.calls.filter((call) => call.init.method === "PUT").length, 0);
        const recorded = readFileSync(resultsFile(run), "utf8");
        for (const text of [result.stdout, result.stderr, recorded]) assert.ok(!text.includes("SECRET"));
        assert.equal(readJsonl(resultsFile(run)).at(-1).usable, false);
    }
});

test("a non-2xx PUT is a failure and the publicUrl is never recorded as usable", async (t) => {
    const run = tempRun(t);
    const fetch = router(presignRoutes({ uploadUrl: "https://uploads.example.com/put?sig=SECRET", putStatus: 403 }));
    const result = await cli(["upload", "sample.jpg", "--plan", "plan.json", "--execute", "--allow-upload-host", "uploads.example.com"], { fetchImpl: fetch.impl, run });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /HTTP 403/);
    const last = readJsonl(resultsFile(run)).at(-1);
    assert.equal(last.usable, false);
    assert.equal(last.publicUrl, undefined);
    assert.ok(!readFileSync(resultsFile(run), "utf8").includes("media.zernio.com/temp"));
});

// --- journal, run directories and recovery -----------------------------------

test("a create is journalled before dispatch and becomes outcome_unknown on timeout", async (t) => {
    const run = tempRun(t);
    let seenAtDispatch = null;
    const fetch = router({
        "GET /api/v1/accounts": () => accountsResponse(),
        "POST /api/v1/posts": ({ init }) => {
            const last = readJsonl(journalPath(run)).at(-1);
            seenAtDispatch = { state: last?.state, requestKey: last?.requestKey, bodyStored: existsSync(join(run, "requests", `${last?.requestKey}.json`)), header: init.headers["x-request-id"] };
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
    });
    const result = await cli(["post", "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, run });
    assert.equal(result.code, 0);
    assert.equal(seenAtDispatch.state, "dispatching");
    assert.equal(seenAtDispatch.bodyStored, true);
    assert.equal(seenAtDispatch.header, seenAtDispatch.requestKey);
    const lines = readJsonl(journalPath(run));
    assert.deepEqual(lines.map((line) => line.state), ["dispatching", "outcome_unknown"]);
    assert.equal(lines[1].transportError, "TimeoutError");
    assert.match(lines[0].bodySha256, /^[0-9a-f]{64}$/);
    assert.equal(fetch.calls.filter((call) => call.key === "POST /api/v1/posts").length, 1);
    assert.match(result.stdout, /resume/);
    if (process.platform !== "win32") {
        assert.equal(statSync(run).mode & 0o777, 0o700);
        assert.equal(statSync(journalPath(run)).mode & 0o777, 0o600);
    }
});

const timedOutPost = async ({ base, run }) => {
    const fetch = router({ "GET /api/v1/accounts": () => accountsResponse(), "POST /api/v1/posts": () => { throw new DOMException("timeout", "TimeoutError"); } });
    const result = await cli(["post", "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, base, run });
    const dir = run ?? result.stdout.match(/run directory: (.+)/)[1].trim();
    const first = readJsonl(journalPath(dir))[0];
    return { dir, requestKey: first.requestKey, dispatchedAt: Date.parse(first.at) };
};

test("two runs under one base directory get separate directories and do not mix", async (t) => {
    const base = tempBase(t);
    const a = await timedOutPost({ base });
    const b = await timedOutPost({ base });
    assert.notEqual(a.dir, b.dir);
    assert.deepEqual(readdirSync(join(base, "runs")).length, 2);
    assert.deepEqual([...new Set(readJsonl(journalPath(a.dir)).map((line) => line.requestKey))], [a.requestKey]);

    const summary = await cli(["summarize"], { run: a.dir });
    assert.equal(summary.code, 0);
    // Each run left one unresolved outcome; a mixed summary would count two.
    assert.match(summary.stdout, /| twitter | 미기록 | 미기록 | 미기록 | 1 | | |/);
    const combined = await cli(["summarize", "--run", b.dir], { run: a.dir });
    assert.match(combined.stdout, /| twitter | 미기록 | 미기록 | 미기록 | 2 | | |/);

    const refused = await cli(["summarize"], { base });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--run/);
});

test("resume needs the run directory of the post", async () => {
    const result = await cli(["resume", "k", "--plan", "plan.json"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--run/);
});

test("recoveryWindow follows the documented windows with a safety margin", () => {
    assert.equal(recoveryWindow(0), "replay_same_request_id");
    assert.equal(recoveryWindow(REPLAY_WINDOW_MS), "replay_same_request_id");
    assert.equal(recoveryWindow(REPLAY_WINDOW_MS + 1), "content_hash_409");
    assert.ok(REPLAY_WINDOW_MS < 5 * 60_000);
    assert.equal(recoveryWindow(CONTENT_HASH_WINDOW_MS + 1), "list_scan_lookup");
    assert.ok(CONTENT_HASH_WINDOW_MS < 24 * 3600_000);
    assert.equal(recoveryWindow(-1), "clock_skew");
});

test("resume inside W1 resends the stored body with the same x-request-id", async (t) => {
    const { dir, requestKey, dispatchedAt } = await timedOutPost({ run: tempRun(t) });
    const stored = readFileSync(join(dir, "requests", `${requestKey}.json`), "utf8");
    const fetch = router({
        "GET /api/v1/accounts": () => accountsResponse(),
        "POST /api/v1/posts": ({ init }) => {
            assert.equal(init.headers["x-request-id"], requestKey);
            assert.equal(init.body, stored);
            return json(200, { existingPost: { _id: POST_ID, status: "published", platforms: [] } });
        },
    });
    const result = await cli(["resume", requestKey, "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, run: dir, now: dispatchedAt + 60_000 });
    assert.equal(result.code, 0);
    assert.equal(fetch.calls.filter((call) => call.key === "POST /api/v1/posts").length, 1);
    assert.equal(readJsonl(journalPath(dir)).at(-1).state, "responded");
});

const listRoute = (pages) => ({ url }) => {
    const page = Number(url.searchParams.get("page"));
    return json(200, pages(page));
};

test("resume inside W2 refuses to resend on a truncated scan and keeps outcome_unknown", async (t) => {
    const { dir, requestKey, dispatchedAt } = await timedOutPost({ run: tempRun(t) });
    const fetch = router({ "GET /api/v1/accounts": () => accountsResponse(), "GET /api/v1/posts": listRoute(() => ({ posts: [{ _id: "x", metadata: { s0RequestKey: "someone-else" } }], pagination: { pages: 50 } })) });
    const result = await cli(["resume", requestKey, "--plan", "plan.json", "--execute", "--max-pages", "2"], { fetchImpl: fetch.impl, run: dir, now: dispatchedAt + 10 * 60_000 });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /truncated/);
    assert.equal(fetch.calls.filter((call) => call.key === "POST /api/v1/posts").length, 0);
    assert.equal(readJsonl(journalPath(dir)).at(-1).state, "outcome_unknown");
    const last = readJsonl(resultsFile(dir)).at(-1);
    assert.equal(last.action, "refused_scan_not_conclusive");
    assert.equal(last.platform, "twitter");
});

test("resume inside W2 resends with a fresh id only after a complete scan with no match", async (t) => {
    const { dir, requestKey, dispatchedAt } = await timedOutPost({ run: tempRun(t) });
    let sentId = null;
    const fetch = router({
        "GET /api/v1/accounts": () => accountsResponse(),
        "GET /api/v1/posts": listRoute((page) => ({ posts: [{ _id: `p${page}`, metadata: {} }], pagination: { pages: 2 } })),
        "POST /api/v1/posts": ({ init }) => {
            sentId = init.headers["x-request-id"];
            return json(409, { error: "This exact content is already scheduled", details: { existingPostId: POST_ID } });
        },
    });
    const result = await cli(["resume", requestKey, "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, run: dir, now: dispatchedAt + 10 * 60_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fetch.calls.filter((call) => call.key === "GET /api/v1/posts").length, 2);
    assert.ok(sentId && sentId !== requestKey);
    const last = readJsonl(resultsFile(dir)).at(-1);
    assert.equal(last.action, "resent_under_content_hash");
    assert.equal(last.error.existingPostId, POST_ID);
    assert.ok(!readFileSync(resultsFile(dir), "utf8").includes("exact content"));
});

test("resume in W3 only scans: a complete scan with no match is refused, not resent", async (t) => {
    const { dir, requestKey, dispatchedAt } = await timedOutPost({ run: tempRun(t) });
    const fetch = router({ "GET /api/v1/accounts": () => accountsResponse(), "GET /api/v1/posts": listRoute(() => ({ posts: [], pagination: { pages: 0 } })) });
    const result = await cli(["resume", requestKey, "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, run: dir, now: dispatchedAt + CONTENT_HASH_WINDOW_MS + 60_000 });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /new post/);
    assert.equal(fetch.calls.filter((call) => call.key === "POST /api/v1/posts").length, 0);
    assert.equal(readJsonl(resultsFile(dir)).at(-1).action, "refused_outside_dedup_windows");
});

test("--max-pages must be an integer of at least 1", async () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
        const result = await cli(["lookup", "k", `--max-pages=${bad}`]);
        assert.equal(result.code, 2, bad);
        assert.match(result.stderr, /--max-pages/);
    }
    assert.throws(() => validateMaxPages(0), /--max-pages/);
    assert.equal(validateMaxPages("3"), 3);
});

test("scanForRequestKey is complete only when every stated page was read", async () => {
    const key = "k-1";
    const ctx = (respond) => ({ apiKey: FAKE_KEY, fetchImpl: async (url) => json(200, respond(Number(new URL(url).searchParams.get("page")))) });

    const complete = await scanForRequestKey(ctx((page) => ({ posts: page === 2 ? [{ _id: "a", metadata: { s0RequestKey: key } }] : [{ _id: "z", metadata: {} }], pagination: { pages: 2 } })), { requestKey: key, maxPages: 5 });
    assert.deepEqual([complete.scanStatus, complete.matchCount, complete.pagesRead], ["complete", 1, 2]);

    const empty = await scanForRequestKey(ctx(() => ({ posts: [], pagination: { pages: 0 } })), { requestKey: key, maxPages: 5 });
    assert.deepEqual([empty.scanStatus, empty.matchCount], ["complete", 0]);

    const truncated = await scanForRequestKey(ctx(() => ({ posts: [{ _id: "z", metadata: {} }], pagination: { pages: 30 } })), { requestKey: key, maxPages: 3 });
    assert.deepEqual([truncated.scanStatus, truncated.pagesRead, truncated.totalPages], ["truncated", 3, 30]);

    const emptyBeforeLast = await scanForRequestKey(ctx((page) => ({ posts: page === 1 ? [{ _id: "z", metadata: {} }] : [], pagination: { pages: 5 } })), { requestKey: key, maxPages: 10 });
    assert.equal(emptyBeforeLast.scanStatus, "truncated");
    assert.equal(emptyBeforeLast.matchCount, 0);

    const malformed = await scanForRequestKey(ctx(() => ({ posts: [] })), { requestKey: key, maxPages: 3 });
    assert.equal(malformed.scanStatus, "error");

    const ambiguous = await scanForRequestKey(ctx(() => ({ posts: [{ _id: "a", metadata: { s0RequestKey: key } }, { _id: "b", metadata: { s0RequestKey: key } }], pagination: { pages: 1 } })), { requestKey: key, maxPages: 5 });
    assert.equal(ambiguous.scanStatus, "ambiguous");

    await assert.rejects(scanForRequestKey(ctx(() => ({ posts: [], pagination: { pages: 1 } })), { requestKey: key, maxPages: 0 }), /--max-pages/);
});

test("buildPostRequest labels the post and carries the request key in metadata", () => {
    const { body } = buildPostRequest({ plan: { label: LABEL, mode: "schedule", scheduleOffsetMinutes: 30 }, target: { platform: "linkedin", accountId: LI_ACCOUNT }, requestKey: "11111111-2222-3333-4444-555555555555", runId: "run", now: new Date("2026-09-16T00:00:00Z") });
    assert.ok(body.content.startsWith(`[${LABEL}]`));
    assert.equal(body.metadata.s0RequestKey, "11111111-2222-3333-4444-555555555555");
    assert.equal(body.scheduledFor, "2026-09-16T00:30:00.000Z");
    assert.equal(body.publishNow, undefined);
});

// --- webhook ------------------------------------------------------------------

const SECRET = "test-webhook-secret";

test("signature verification matches the documented HMAC-SHA256 hex of the raw body", () => {
    const rawBody = Buffer.from('{"id":"evt-1","event":"post.published","timestamp":"2026-09-16T00:00:00Z"}');
    // Fixture computed independently of the module under test.
    const fixture = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    assert.equal(computeZernioSignature(rawBody, SECRET), fixture);
    assert.deepEqual(verifyZernioSignature({ rawBody, signatureHeader: fixture, secret: SECRET }), { ok: true, reason: "valid" });
    const tampered = Buffer.from(rawBody.toString().replace("published", "failed"));
    assert.equal(verifyZernioSignature({ rawBody: tampered, signatureHeader: fixture, secret: SECRET }).ok, false);
    assert.equal(verifyZernioSignature({ rawBody, signatureHeader: "", secret: SECRET }).reason, "missing_signature");
    assert.equal(verifyZernioSignature({ rawBody, signatureHeader: fixture, secret: "" }).reason, "no_secret_configured");
    assert.equal(verifyZernioSignature({ rawBody, signatureHeader: fixture.slice(1), secret: SECRET }).reason, "length_mismatch");
    assert.equal(verifyZernioSignature({ rawBody, signatureHeader: fixture.toUpperCase(), secret: SECRET }).ok, false);
});

const deliveryFor = (payload, secret = SECRET) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return { rawBody, headers: { "x-zernio-signature": computeZernioSignature(rawBody, secret), "x-zernio-event": payload.event, "x-zernio-event-id": payload.id } };
};

test("a forged delivery is not parsed, not deduplicated and not recorded", () => {
    const counters = newWebhookCounters();
    const seen = new Set();
    const forged = deliveryFor({ id: "evt-42", event: "post.published", post: { id: "p1", content: "forged" } }, "wrong-secret");
    assert.deepEqual(processWebhookDelivery({ ...forged, secret: SECRET, seenEventIds: seen, counters }), { status: 401, meta: null });
    assert.equal(seen.size, 0);
    assert.equal(counters.invalidSignature, 1);
    const genuine = processWebhookDelivery({ ...deliveryFor({ id: "evt-42", event: "post.published", timestamp: new Date().toISOString() }), secret: SECRET, seenEventIds: seen, counters });
    assert.equal(genuine.status, 200);
    assert.equal(genuine.meta.duplicateDelivery, false);
});

test("webhook metadata keeps no content, handles or comment text and flags redelivery", () => {
    const payload = {
        id: "evt-43",
        event: "post.published",
        timestamp: new Date().toISOString(),
        post: { id: "p1", content: "private caption text", status: "published", platforms: [{ platform: "twitter", status: "published", platformPostId: "185", publishedUrl: "https://twitter.com/secret_handle/status/185" }], metadata: { s0RequestKey: "k1" } },
    };
    const seen = new Set();
    const counters = newWebhookCounters();
    const first = processWebhookDelivery({ ...deliveryFor(payload), secret: SECRET, seenEventIds: seen, counters });
    const second = processWebhookDelivery({ ...deliveryFor(payload), secret: SECRET, seenEventIds: seen, counters });
    assert.equal(first.meta.signature, "valid");
    assert.equal(first.meta.duplicateDelivery, false);
    assert.equal(second.meta.duplicateDelivery, true);
    assert.equal(first.meta.timestampTolerance, "undocumented");
    const serialized = JSON.stringify(first.meta);
    assert.ok(!serialized.includes("private caption text"));
    assert.ok(!serialized.includes("secret_handle"));
});

const send = (port, { headers, chunks }) =>
    new Promise((resolveSend) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers }, (res) => {
            res.resume();
            res.on("end", () => resolveSend(res.statusCode));
        });
        req.on("error", () => {});
        for (const chunk of chunks) req.write(chunk);
        req.end();
    });

test("the listener answers 413 to an oversized body, declared or streamed, and records nothing", async (t) => {
    const accepted = [];
    const { server, counters } = createWebhookServer({ secret: SECRET, maxBytes: 1024, onAccepted: (meta) => accepted.push(meta) });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    t.after(() => server.close());
    const { port } = server.address();

    const big = Buffer.alloc(4096, "a");
    assert.equal(await send(port, { headers: { "content-length": String(big.length) }, chunks: [big] }), 413);
    assert.equal(await send(port, { headers: { "transfer-encoding": "chunked" }, chunks: [big.subarray(0, 800), big.subarray(800)] }), 413);
    assert.equal(counters.oversized, 2);
    assert.equal(accepted.length, 0);

    const ok = deliveryFor({ id: "evt-9", event: "webhook.test", timestamp: new Date().toISOString() });
    assert.equal(await send(port, { headers: { ...ok.headers, "content-length": String(ok.rawBody.length) }, chunks: [ok.rawBody] }), 200);
    assert.equal(accepted.length, 1);
});

// --- summary ------------------------------------------------------------------

test("summarize names a channel on every row, leaves verdicts empty and counts unresolved outcomes", () => {
    const markdown = summarizeRecords({
        results: [
            { at: "2026-09-16T00:00:01Z", kind: "post-attempt", platform: "twitter", requestKey: "aaaaaaaa-1", attempt: 2, xRequestId: "same", state: "responded", httpStatus: 200, bodyHasExistingPost: true, rateLimit: { "x-ratelimit-limit": "60" } },
            { at: "2026-09-16T00:00:02Z", kind: "lookup", platform: "twitter", requestKey: "abcdef12-0000", scanStatus: "truncated", matchCount: 0, pagesRead: 20, totalPages: 31 },
            { at: "2026-09-16T00:00:03Z", kind: "status", postId: POST_ID, httpStatus: 200, post: { status: "published", platforms: [{ platform: "linkedin", status: "published", hasPlatformPostId: true }] } },
        ],
        webhooks: [{ eventHeader: "post.published", platformStatuses: [{ platform: "twitter" }], duplicateDelivery: false, lagSeconds: 3 }],
        journal: [{ requestKey: "r1", platform: "tiktok", state: "dispatching" }, { requestKey: "r1", platform: "tiktok", state: "outcome_unknown" }],
    });
    const rows = markdown.split("\n").filter((line) => /^\| C\d/.test(line));
    assert.ok(rows.length >= 4);
    for (const row of rows) {
        const cells = row.split("|").map((cell) => cell.trim());
        assert.notEqual(cells[2], "-", row);
        assert.equal(cells[4], "", row);
    }
    assert.match(markdown, /\| C7 \| twitter \| .*scan=truncated/);
    assert.match(markdown, /\| C8 \| linkedin \|/);
    assert.match(markdown, /\| tiktok \| 미기록 \| 미기록 \| 미기록 \| 1 \| \| \|/);
});

test("summarize reports the latest resolved outcome per request key, including resume", () => {
    const key = "bbbbbbbb-0000-0000-0000-000000000000";
    const markdown = summarizeRecords({
        results: [
            { at: "2026-09-16T00:00:01Z", kind: "post-attempt", platform: "twitter", requestKey: key, attempt: 2, xRequestId: "same", state: "outcome_unknown", transportError: "TimeoutError" },
            { at: "2026-09-16T00:01:00Z", kind: "resume", platform: "twitter", requestKey: key, window: "replay_same_request_id", action: "replayed", state: "responded", httpStatus: 200, bodyHasExistingPost: true },
            { at: "2026-09-16T00:10:00Z", kind: "resume", platform: "linkedin", requestKey: "cccccccc-1", window: "content_hash_409", action: "resent_under_content_hash", state: "responded", httpStatus: 409, error: { httpStatus: 409, existingPostId: POST_ID } },
        ],
        webhooks: [],
        journal: [
            { requestKey: key, platform: "twitter", state: "dispatching" },
            { requestKey: key, platform: "twitter", state: "outcome_unknown" },
            { requestKey: key, platform: "twitter", state: "responded", httpStatus: 200, postId: POST_ID },
        ],
    });
    assert.match(markdown, /\| twitter \| bbbbbbbb HTTP 200\+existingPost \(resume\) \| 미기록 \| 미기록 \| 0 \| \| \|/);
    assert.match(markdown, /\| linkedin \| 미기록 \| cccccccc HTTP 409\+existingPostId \(resume\) \| 미기록 \| 0 \| \| \|/);
});

// --- round 3 regressions -------------------------------------------------------

test("a redirected presigned PUT is not followed and leaves no usable publicUrl", async (t) => {
    const run = tempRun(t);
    let putInit = null;
    const fetch = router({
        ...presignRoutes({ uploadUrl: "https://uploads.example.com/put?sig=SECRET" }),
        "PUT uploads.example.com/put": ({ init }) => {
            putInit = init;
            return new Response("", { status: 302, headers: { location: "https://collector.evil.example/steal" } });
        },
    });
    const result = await cli(["upload", "sample.jpg", "--plan", "plan.json", "--execute", "--allow-upload-host", "uploads.example.com"], { fetchImpl: fetch.impl, run });
    assert.notEqual(result.code, 0);
    assert.equal(putInit.redirect, "manual");
    assert.ok(fetch.calls.every((call) => !call.url.includes("collector.evil.example")));
    const last = readJsonl(resultsFile(run)).at(-1);
    assert.equal(last.usable, false);
    assert.equal(last.refused, "put_redirect_not_followed");
    assert.equal(last.publicUrl, undefined);
});

test("a request journalled as dispatching with no terminal line counts as unresolved", () => {
    const markdown = summarizeRecords({
        results: [],
        webhooks: [],
        journal: [
            { requestKey: "crashed", platform: "threads", state: "dispatching" },
            { requestKey: "done", platform: "threads", state: "dispatching" },
            { requestKey: "done", platform: "threads", state: "responded", httpStatus: 201 },
        ],
    });
    assert.match(markdown, /\| threads \| 미기록 \| 미기록 \| 미기록 \| 1 \| \| \|/);
});

test("a 5xx, 408 or 429 on create is outcome_unknown, stops the target and points at resume", async (t) => {
    for (const [status, state] of [[503, "outcome_unknown"], [502, "outcome_unknown"], [408, "outcome_unknown"], [429, "outcome_unknown"]]) {
        const run = tempRun(t);
        const fetch = router({
            "GET /api/v1/accounts": () => accountsResponse(),
            "POST /api/v1/posts": () => json(status, { error: "Upstream @brand_handle failed", type: "api_error", code: "temporarily_unavailable" }),
        });
        const result = await cli(["post", "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, run });
        assert.equal(result.code, 0);
        assert.equal(fetch.calls.filter((call) => call.key === "POST /api/v1/posts").length, 1, String(status));
        const journalLines = readJsonl(journalPath(run));
        assert.deepEqual(journalLines.map((line) => line.state), ["dispatching", state], String(status));
        assert.equal(readJsonl(resultsFile(run)).at(-1).state, state);
        assert.ok(!readFileSync(journalPath(run), "utf8").includes("brand_handle"));
        if (state === "outcome_unknown") assert.match(result.stdout, /resume/);
    }
});

test("a resume that itself gets 5xx, 408 or 429 stays outcome_unknown and prints the resume guidance again", async (t) => {
    for (const status of [503, 408, 429]) {
        const { dir, requestKey, dispatchedAt } = await timedOutPost({ run: tempRun(t) });
        const fetch = router({ "GET /api/v1/accounts": () => accountsResponse(), "POST /api/v1/posts": () => json(status, { type: "api_error", code: "temporarily_unavailable" }) });
        const result = await cli(["resume", requestKey, "--plan", "plan.json", "--execute"], { fetchImpl: fetch.impl, run: dir, now: dispatchedAt + 60_000 });
        assert.equal(result.code, 0, String(status));
        assert.equal(readJsonl(journalPath(dir)).at(-1).state, "outcome_unknown");
        assert.equal(readJsonl(resultsFile(dir)).at(-1).state, "outcome_unknown");
        assert.ok(result.stdout.includes(`resume ${requestKey}`), String(status));
    }
});
