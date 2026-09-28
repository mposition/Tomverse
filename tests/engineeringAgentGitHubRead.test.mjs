import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV,
  EngineeringAgentGitHubReadError,
  readEngineeringAgentBacklogAt,
  readEngineeringAgentCheckRunsAt,
  readEngineeringAgentDependabotFailures,
} from "../lib/engineeringAgentGitHubRead.ts";

// The app's read-only GitHub view for registration (docs/policy/engineering-
// agent.md §2.2, §8): one fixed repository, a pinned commit that must be on
// the backlog branch, bounded answers, and errors that carry a code only.

const env = { [ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV]: "read-only-token" };
const PIN = "a".repeat(40);

const fakeFetch = (routes) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const path = String(url).replace("https://api.github.com/repos/mposition/Tomverse", "");
    const handler = routes[path.split("?")[0]];
    if (!handler) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(handler(path)), { status: 200 });
  };
  return { fetchImpl, seen };
};

test("the backlog is read at the pin only when the pin is on the backlog branch", async () => {
  const text = "| ID | 상태·분류 | 다음 완료 단위 |\n|---|---|---|\n| ENG-1 | P2 진행 | 다음 |\n";
  const content = Buffer.from(text, "utf8").toString("base64");
  const branch = encodeURIComponent("codex/product-idea-backlog-2026-09-15");
  const file = { type: "file", encoding: "base64", content };
  for (const status of ["identical", "ahead"]) {
    const { fetchImpl, seen } = fakeFetch({
      [`/compare/${PIN}...${branch}`]: () => ({ status }),
      "/contents/.github/audits/tomverse-product-idea-backlog.md": () => file,
    });
    assert.equal(await readEngineeringAgentBacklogAt(PIN, { env, fetchImpl }), text);
    assert.ok(seen.every((call) => call.init.method === "GET"), "only reads");
    assert.ok(seen.every((call) => call.init.headers.Authorization === "Bearer read-only-token"));
    assert.ok(seen.some((call) => call.url.includes(`ref=${PIN}`)), "the file is read at the pin");
  }
  for (const status of ["behind", "diverged"]) {
    const { fetchImpl } = fakeFetch({
      [`/compare/${PIN}...${branch}`]: () => ({ status }),
      "/contents/.github/audits/tomverse-product-idea-backlog.md": () => file,
    });
    await assert.rejects(readEngineeringAgentBacklogAt(PIN, { env, fetchImpl }), /invalid_input/);
  }
});

test("a pin, a token and an answer are all checked before anything is trusted", async () => {
  await assert.rejects(readEngineeringAgentBacklogAt("main", { env, fetchImpl: fetch }), /invalid_input/);
  await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env: {}, fetchImpl: fetch }), /not_configured/);
  const { fetchImpl } = fakeFetch({ [`/commits/${PIN}/check-runs`]: () => ({ check_runs: [{ name: "x" }] }) });
  await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), (error) => {
    assert.ok(error instanceof EngineeringAgentGitHubReadError);
    assert.equal(error.message, "invalid_response", "the error carries a code, never upstream text");
    return true;
  });
});

test("only dependabot's open pull requests are read, and only their failing checks count", async () => {
  const head = "b".repeat(40);
  const other = "c".repeat(40);
  const { fetchImpl } = fakeFetch({
    "/pulls": () => [
      { number: 7, user: { login: "dependabot[bot]" }, head: { sha: head } },
      { number: 8, user: { login: "someone" }, head: { sha: other } },
    ],
    [`/commits/${head}/check-runs`]: () => ({
      check_runs: [
        { id: 1, name: "unit", conclusion: "failure" },
        { id: 2, name: "lint", conclusion: "success" },
        { id: 3, name: "e2e", conclusion: "timed_out" },
      ],
    }),
  });
  assert.deepEqual(await readEngineeringAgentDependabotFailures({ env, fetchImpl }), [
    { prNumber: 7, headSha: head, failingChecks: ["unit", "e2e"] },
  ]);
});
