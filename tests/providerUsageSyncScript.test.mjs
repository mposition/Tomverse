import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "run-provider-usage-sync.mjs"
);
const SECRET = "s".repeat(32);

const openAiFailure = {
  provider: "openai",
  status: "failed",
  message: "OpenAI Costs API returned 429 after 3 attempts.",
  diagnostic: {
    traceId: "trace-1",
    httpStatus: 429,
    errorCode: "rate_limit_exceeded",
    failureStage: "provider_http",
    detail: "provider detail stays on the web service",
  },
};
const synced = { provider: "anthropic", status: "synced", diagnostic: null };

// The script must be spawned asynchronously: the fake route lives in this process.
const run = async (args, respond) => {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({
      search: url.search,
      path: url.pathname,
      method: req.method,
      authorization: req.headers.authorization,
    });
    const { status = 200, body } = respond(url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address();
    const finished = await promisify(execFile)(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          PROVIDER_USAGE_SYNC_URL: `http://127.0.0.1:${port}`,
          PROVIDER_USAGE_SYNC_SECRET: SECRET,
        },
      }
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      ({ code, stdout, stderr }) => ({ code, stdout, stderr })
    );
    return { ...finished, requests };
  } finally {
    await new Promise((done) => server.close(done));
  }
};

const failureLines = (stderr) =>
  stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Provider usage sync failure: "))
    .map((line) => JSON.parse(line.slice("Provider usage sync failure: ".length)));

test("the daily run names a failed provider on one line and still exits 0", async () => {
  const { code, stdout, stderr, requests } = await run([], () => ({
    body: {
      date: "2026-11-03",
      results: [openAiFailure, synced],
      notification: { delivered: true, failed: 1, skipped: 0 },
    },
  }));

  assert.equal(code, 0);
  assert.deepEqual(requests, [
    {
      search: "?notify=slack",
      path: "/api/internal/provider-usage/sync",
      method: "POST",
      authorization: `Bearer ${SECRET}`,
    },
  ]);
  assert.deepEqual(failureLines(stderr), [
    {
      date: "2026-11-03",
      provider: "openai",
      httpStatus: 429,
      errorCode: "rate_limit_exceeded",
      failureStage: "provider_http",
      traceId: "trace-1",
    },
  ]);
  assert.ok(!stderr.includes("provider detail"));
  assert.match(stdout, /Daily provider usage sync completed/);
});

test("a clean daily run logs no failure line", async () => {
  const { code, stderr } = await run([], () => ({
    body: { date: "2026-11-03", results: [synced] },
  }));
  assert.equal(code, 0);
  assert.deepEqual(failureLines(stderr), []);
});

test("backfill syncs every day in order, across a month, without Slack", async () => {
  const { code, stdout, requests } = await run(
    ["--from", "2026-10-30", "--to", "2026-11-02"],
    (url) => ({
      body: { date: url.searchParams.get("date"), results: [synced] },
    })
  );
  assert.equal(code, 0);
  assert.deepEqual(
    requests.map((request) => request.search),
    [
      "?date=2026-10-30",
      "?date=2026-10-31",
      "?date=2026-11-01",
      "?date=2026-11-02",
    ]
  );
  assert.match(
    stdout,
    /Provider usage backfill: {"date":"2026-11-02","synced":1,"failed":0}/
  );
});

test("backfill finishes the range but exits 1 when any day did not sync", async () => {
  const { code, stderr, requests } = await run(
    ["--from", "2026-11-01", "--to", "2026-11-03"],
    (url) => {
      const date = url.searchParams.get("date");
      if (date === "2026-11-01") return { status: 500, body: { error: "x" } };
      if (date === "2026-11-02") {
        return { body: { date, results: [openAiFailure] } };
      }
      return { body: { date, results: [synced] } };
    }
  );
  assert.equal(code, 1);
  assert.equal(requests.length, 3);
  assert.match(stderr, /Provider usage backfill failed: .*2026-11-01/);
  assert.equal(failureLines(stderr)[0].date, "2026-11-02");
});

test("backfill rejects a response for a different day than it asked for", async () => {
  const { code, stderr } = await run(
    ["--from", "2026-11-01", "--to", "2026-11-01"],
    () => ({ body: { date: "2026-11-03", results: [synced] } })
  );
  assert.equal(code, 1);
  assert.match(stderr, /Provider usage backfill failed/);
});

test("invalid backfill ranges call nothing", async () => {
  for (const args of [
    ["--from", "2026-11-01"],
    ["--to", "2026-11-01"],
    ["--from", "2026-11-02", "--to", "2026-11-01"],
    ["--from", "2026-02-30", "--to", "2026-03-01"],
    ["--from", "2026-01-01", "--to", "2026-02-01"],
    ["--date", "2026-11-01"],
  ]) {
    const { code, stderr, requests } = await run(args, () => ({ body: {} }));
    assert.equal(code, 1, args.join(" "));
    assert.equal(requests.length, 0, args.join(" "));
    assert.match(stderr, /Use --from YYYY-MM-DD --to YYYY-MM-DD/);
  }
});
