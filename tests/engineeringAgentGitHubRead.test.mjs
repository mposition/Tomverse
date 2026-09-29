import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV,
  EngineeringAgentGitHubReadError,
  readEngineeringAgentBacklogAt,
  readEngineeringAgentCheckRunsAt,
  readEngineeringAgentDependabotFailures,
  readEngineeringAgentDevelopChecks,
} from "../lib/engineeringAgentGitHubRead.ts";

// The app's read-only GitHub view for registration (docs/policy/engineering-
// agent.md §2.2, §8): one fixed repository, a pinned commit that must be on
// the source's branch, whole answers only, and errors that carry a code only.

const env = { [ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV]: "read-only-token" };
const PIN = "a".repeat(40);
const NEXT = '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=3>; rel="last"';

/** Routes answer a body, or `{ body, link }` to also send a Link header. */
const fakeFetch = (routes) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const path = String(url).replace("https://api.github.com/repos/mposition/Tomverse", "");
    const handler = routes[path.split("?")[0]];
    if (!handler) return new Response("{}", { status: 404 });
    const answer = handler(path);
    const withLink = answer !== null && typeof answer === "object" && "link" in answer;
    return new Response(JSON.stringify(withLink ? answer.body : answer), {
      status: 200,
      headers: withLink ? { link: answer.link } : {},
    });
  };
  return { fetchImpl, seen };
};

const runs = (list) => ({ total_count: list.length, check_runs: list });

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

test("a backlog that holds a NUL is not text, and the whole source is refused", async () => {
  const branch = encodeURIComponent("codex/product-idea-backlog-2026-09-15");
  const content = Buffer.from("| ID | 상태·분류 | 다음 완료 단위 |\n|---|---|---|\n| ENG-1 | P2\u0000 | 다음 |\n", "utf8").toString("base64");
  const { fetchImpl } = fakeFetch({
    [`/compare/${PIN}...${branch}`]: () => ({ status: "identical" }),
    "/contents/.github/audits/tomverse-product-idea-backlog.md": () => ({ type: "file", encoding: "base64", content }),
  });
  await assert.rejects(readEngineeringAgentBacklogAt(PIN, { env, fetchImpl }), /not_text/);
});

test("an S2 pin is develop's CI only when it is develop's head or behind it", async () => {
  const checks = runs([{ id: 1, name: "unit", conclusion: "failure" }]);
  for (const status of ["identical", "ahead"]) {
    const { fetchImpl } = fakeFetch({
      [`/compare/${PIN}...develop`]: () => ({ status }),
      [`/commits/${PIN}/check-runs`]: () => checks,
    });
    assert.deepEqual(await readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), checks.check_runs);
  }
  for (const status of ["behind", "diverged"]) {
    const { fetchImpl, seen } = fakeFetch({
      [`/compare/${PIN}...develop`]: () => ({ status }),
      [`/commits/${PIN}/check-runs`]: () => checks,
    });
    await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), /invalid_input/);
    assert.equal(seen.some((call) => call.url.includes("/check-runs")), false, "a commit off develop is never read");
  }
});

test("a pin, a token and an answer are all checked before anything is trusted", async () => {
  await assert.rejects(readEngineeringAgentBacklogAt("main", { env, fetchImpl: fetch }), /invalid_input/);
  await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env: {}, fetchImpl: fetch }), /not_configured/);
  const { fetchImpl } = fakeFetch({
    [`/compare/${PIN}...develop`]: () => ({ status: "identical" }),
    [`/commits/${PIN}/check-runs`]: () => runs([{ name: "x" }]),
  });
  await assert.rejects(readEngineeringAgentCheckRunsAt(PIN, { env, fetchImpl }), (error) => {
    assert.ok(error instanceof EngineeringAgentGitHubReadError);
    assert.equal(error.message, "invalid_response", "the error carries a code, never upstream text");
    return true;
  });
});

test("a page that is not the whole list is refused, not read as the whole", async () => {
  const head = "d".repeat(40);
  const one = [{ id: 1, name: "unit", conclusion: "success" }];
  const cases = [
    { total_count: 101, check_runs: one },
    { body: runs(one), link: NEXT },
  ];
  for (const answer of cases) {
    const { fetchImpl } = fakeFetch({
      "/commits/develop": () => ({ sha: head }),
      [`/commits/${head}/check-runs`]: () => answer,
    });
    await assert.rejects(readEngineeringAgentDevelopChecks({ env, fetchImpl }), /invalid_response/);
  }
  const { fetchImpl } = fakeFetch({
    "/pulls": () => ({ body: [{ number: 7, user: { login: "someone" }, head: { sha: head } }], link: NEXT }),
  });
  await assert.rejects(
    readEngineeringAgentDependabotFailures({ env, fetchImpl }),
    /invalid_response/,
    "dependabot's pull requests may be on the next page: the author is never filtered from a cut list",
  );
});

test("only dependabot's open pull requests are read, and only their failing checks count", async () => {
  const head = "b".repeat(40);
  const other = "c".repeat(40);
  const { fetchImpl } = fakeFetch({
    "/pulls": () => [
      { number: 7, user: { login: "dependabot[bot]" }, head: { sha: head } },
      { number: 8, user: { login: "someone" }, head: { sha: other } },
    ],
    [`/commits/${head}/check-runs`]: () =>
      runs([
        { id: 1, name: "unit", conclusion: "failure" },
        { id: 2, name: "lint", conclusion: "success" },
        { id: 3, name: "e2e", conclusion: "timed_out" },
      ]),
  });
  assert.deepEqual(await readEngineeringAgentDependabotFailures({ env, fetchImpl }), [
    { prNumber: 7, headSha: head, failingChecks: ["unit", "e2e"] },
  ]);
});
