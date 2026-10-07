// The S-M0 test-branch observations of the merge lane's protection
// (docs/policy/qa-release-agent.md version 7, section 8 items 7, 9, 10 and
// 11). The operator runs it locally, in three steps:
//
//   npm run qa-release:lane-observe -- setup --observation-app-id <id> --bypass 15368,29110
//   npm run qa-release:lane-observe -- observe --observation-app-id <id> --bypass 15368,29110 --observation-key <pem path>
//   npm run qa-release:lane-observe -- teardown
//
// Credentials: GH_TOKEN (the operator's own token, repository admin) for
// everything a person does, and the observation App's private key -- read
// from a local file, never from the environment of a service, and never
// printed (item 11) -- for everything the App does.
//
// It writes only to branches named qa-lane-test/* and to rulesets whose
// names end in "(test)": test branches copied from the real ones, the two
// test rulesets, pull requests between test branches, and the merges and
// ref moves being observed. `teardown` removes all of it. The real rulesets
// are a separate step (scripts/qa-release-lane-rulesets.mjs) that requires
// the record this writes.
//
// The output is the record and a verdict table: statuses and GitHub's error
// messages, never a token, a key or a header.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import {
  qaReleaseClassicProtection,
  qaReleaseClassicProtectionBody,
  qaReleaseRulesetRules,
} from "../lib/qaReleaseBranchProtectionCore.ts";
import { QA_RELEASE_OBSERVATIONS, QA_RELEASE_TEST_BRANCHES as T, judgeQaReleaseObservations } from "../lib/qaReleaseLaneObservationCore.ts";
import { qaReleaseLaneRulesets } from "../lib/qaReleaseLaneRulesetsCore.ts";
import { qaReleaseInstallationToken } from "../lib/qaReleaseMergeLaneGithub.ts";

const OWNER = "mposition";
const REPO = "Tomverse";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const RECORD_DIR = "docs/ops/qa-release-merge-lane-observations";
const SHA = /^[0-9a-f]{40}$/;

// ---- arguments -------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
if (!["setup", "observe", "teardown"].includes(command)) fail("usage: setup | observe | teardown (see the header of this file)");
const operatorToken = (process.env.GH_TOKEN || "").trim();
if (!operatorToken) fail("GH_TOKEN (the operator's token, repository admin) is required.");
const appId = option("observation-app-id");
const bypassAppIds = (option("bypass") ?? "")
  .split(",")
  .filter(Boolean)
  .map((value) => Number(value));
if (command !== "teardown") {
  if (!/^[1-9][0-9]{0,11}$/.test(appId ?? "")) fail("--observation-app-id <the observation App's numeric id> is required.");
  if (bypassAppIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) fail("--bypass takes comma-separated numeric App ids.");
}

// ---- HTTP ------------------------------------------------------------------

const call = async (token, method, path, body) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
};
/** A call that must succeed for the harness itself (not an observation). */
const must = async (token, method, path, body, ok = [200, 201, 204]) => {
  const answer = await call(token, method, path, body);
  if (!ok.includes(answer.status)) throw new Error(`${method} ${path} answered ${answer.status}: ${answer.json?.message ?? ""}`);
  return answer.json;
};
const operator = (method, path, body, ok) => must(operatorToken, method, path, body, ok);
const headSha = async (branch) => {
  const ref = await call(operatorToken, "GET", `/git/ref/heads/${branch}`);
  return ref.status === 200 ? ref.json.object.sha : null;
};

const readProtection = async (branch) => {
  const classic = await call(operatorToken, "GET", `/branches/${branch}/protection`);
  if (classic.status !== 200 && classic.status !== 404) throw new Error(`protection of ${branch} answered ${classic.status}`);
  return {
    branch,
    classic: qaReleaseClassicProtection(classic.status === 404 ? null : classic.json),
    rules: qaReleaseRulesetRules(await operator("GET", `/rules/branches/${branch}`)),
  };
};

const testRulesetIds = async () => {
  const all = await operator("GET", "/rulesets?per_page=100");
  return all.filter((ruleset) => typeof ruleset.name === "string" && ruleset.name.endsWith(" (test)")).map((ruleset) => ruleset.id);
};

// ---- setup -----------------------------------------------------------------

async function setup() {
  const testNames = Object.values(T);
  for (const name of testNames) {
    if (await headSha(name)) fail(`${name} already exists; run teardown first.`);
  }
  if ((await testRulesetIds()).length > 0) fail("test rulesets already exist; run teardown first.");

  const develop = await readProtection("develop");
  const main = await readProtection("main");
  const mainHead = await headSha("main");
  const developHead = await headSha("develop");
  const developCommit = await operator("GET", `/commits/${developHead}`);
  const developParent = developCommit.parents?.[0]?.sha;
  if (!SHA.test(mainHead ?? "") || !SHA.test(developHead ?? "") || !SHA.test(developParent ?? "")) fail("could not read the branch heads.");

  // Item 9 needs a commit whose required checks passed: develop's head, one
  // fast-forward ahead of the develop mirror.
  const required = develop.classic.present ? develop.classic.requiredChecks ?? [] : [];
  const runs = await operator("GET", `/commits/${developHead}/check-runs?per_page=100`);
  const green = new Set(runs.check_runs.filter((run) => run.conclusion === "success").map((run) => run.name));
  const missing = required.filter((name) => !green.has(name));
  if (missing.length > 0) fail(`develop's head has not passed every required check yet (${missing.join(", ")}); try again later.`);

  const create = (name, sha) => operator("POST", "/git/refs", { ref: `refs/heads/${name}`, sha });
  await create(T.mainMirror, mainHead);
  await create(T.otherBase, mainHead);
  await create(T.developMirror, developParent);
  await create(T.head, developHead);
  await create(T.headReviewed, developHead);

  // Item 10: the mirrors copy the real branches' classic protection.
  for (const [branch, source] of [[T.mainMirror, main], [T.developMirror, develop]]) {
    const body = qaReleaseClassicProtectionBody(source.classic);
    if (body) await operator("PUT", `/branches/${encodeURIComponent(branch)}/protection`, body);
  }
  const { update, develop: developRuleset } = qaReleaseLaneRulesets({
    scope: { kind: "test", updateBranches: [T.mainMirror, T.otherBase], developBranch: T.developMirror },
    bypassAppIds,
    laneAppId: Number(appId),
  });
  await operator("POST", "/rulesets", update);
  await operator("POST", "/rulesets", developRuleset);
  console.log(JSON.stringify({ setup: "done", mainHead, developHead, developMirrorAt: developParent, testBranches: testNames }, null, 2));
}

// ---- observe ---------------------------------------------------------------

async function observe() {
  const keyPath = option("observation-key");
  if (!keyPath) fail("--observation-key <path to the observation App's private key file> is required.");
  const key = readFileSync(keyPath, "utf8");
  const appToken = await qaReleaseInstallationToken(
    async (request) => {
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(30_000) });
      return { status: response.status, text: await response.text() };
    },
    appId,
    key,
    Date.now,
  )();

  // Item 10: the real branches' protection, read right before the observations.
  const protection = { develop: await readProtection("develop"), main: await readProtection("main") };
  const developHead = await headSha(T.head);
  if (!developHead) fail("the test branches are missing; run setup first.");

  const results = [];
  const note = (id, answer) =>
    results.push({ id, status: answer?.status ?? null, message: typeof answer?.json?.message === "string" ? answer.json.message.slice(0, 200) : null });
  const openPull = async (token, head, base, title) => {
    const answer = await call(token, "POST", "/pulls", { head, base, title, body: "QA-release merge lane S-M0 observation (docs/policy/qa-release-agent.md section 8). Closed by teardown." });
    if (answer.status !== 201) throw new Error(`opening ${head} -> ${base} answered ${answer.status}: ${answer.json?.message ?? ""}`);
    return answer.json;
  };
  const merge = (token, pull) => call(token, "PUT", `/pulls/${pull.number}/merge`, { sha: pull.head.sha, merge_method: "merge" });
  /** A new commit object on top of a branch head (creating an object moves no ref). */
  const commitOnTop = async (token, branch) => {
    const parent = await headSha(branch);
    const commit = await must(token, "GET", `/git/commits/${parent}`);
    const created = await must(token, "POST", "/git/commits", {
      message: "QA-release merge lane S-M0 observation",
      tree: commit.tree.sha,
      parents: [parent],
    });
    return created.sha;
  };
  const moveRef = (token, branch, sha) => call(token, "PATCH", `/git/refs/heads/${branch}`, { sha, force: false });

  // 8.7: the main mirror and another base.
  const unreviewed = await openPull(operatorToken, T.head, T.mainMirror, "qa-lane-test: unreviewed");
  note("app_merge_unreviewed_main", await merge(appToken, unreviewed));

  const reviewed = await openPull(appToken, T.headReviewed, T.mainMirror, "qa-lane-test: reviewed");
  await operator("POST", `/pulls/${reviewed.number}/reviews`, { event: "APPROVE", body: "QA-release merge lane S-M0 observation." });
  note("app_merge_reviewed_main", await merge(appToken, reviewed));

  note("app_push_main", await moveRef(appToken, T.mainMirror, await commitOnTop(appToken, T.mainMirror)));

  const otherBase = await openPull(appToken, T.head, T.otherBase, "qa-lane-test: other base");
  note("app_merge_other_base", await merge(appToken, otherBase));

  note("operator_merge_main", await merge(operatorToken, unreviewed));

  // 8.9: the develop mirror. The refused push first, then the merge that moves it.
  note("app_push_green_develop", await moveRef(appToken, T.developMirror, developHead));
  const developPull = await openPull(appToken, T.head, T.developMirror, "qa-lane-test: develop");
  note("app_merge_develop", await merge(appToken, developPull));
  note("operator_push_develop", await moveRef(operatorToken, T.developMirror, await commitOnTop(operatorToken, T.developMirror)));

  const verdict = judgeQaReleaseObservations(results);
  const record = {
    recordVersion: 1,
    observedAt: new Date().toISOString(),
    repository: `${OWNER}/${REPO}`,
    observationAppId: Number(appId),
    bypassAppIds: [...new Set(bypassAppIds)].sort((a, b) => a - b),
    protection,
    results,
    verdict,
    automationUpdatesObserved: "not_observed",
  };
  mkdirSync(RECORD_DIR, { recursive: true });
  const file = `${RECORD_DIR}/${record.observedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  for (const spec of QA_RELEASE_OBSERVATIONS) {
    const v = verdict.verdicts.find((entry) => entry.id === spec.id);
    const r = results.find((entry) => entry.id === spec.id);
    console.log(`${v.ok ? "ok  " : "FAIL"}  ${spec.id.padEnd(24)} expected ${spec.expect.padEnd(9)} observed ${v.observed.padEnd(9)} ${r?.status ?? "-"}  ${r?.message ?? ""}`);
  }
  console.log(`\n${verdict.passed ? "All eight as expected." : "NOT as expected: do not apply the real rulesets (policy section 8 item 7)."}`);
  console.log(`Record: ${file}`);
  process.exitCode = verdict.passed ? 0 : 1;
}

// ---- teardown --------------------------------------------------------------

async function teardown() {
  const open = await operator("GET", "/pulls?state=open&per_page=100");
  for (const pull of open.filter((entry) => entry.head?.ref?.startsWith("qa-lane-test/") || entry.base?.ref?.startsWith("qa-lane-test/"))) {
    await operator("PATCH", `/pulls/${pull.number}`, { state: "closed" });
  }
  for (const id of await testRulesetIds()) await operator("DELETE", `/rulesets/${id}`, undefined, [204]);
  for (const name of Object.values(T)) {
    await call(operatorToken, "DELETE", `/branches/${encodeURIComponent(name)}/protection`);
    if (await headSha(name)) await operator("DELETE", `/git/refs/heads/${name}`, undefined, [204]);
  }
  console.log(JSON.stringify({ teardown: "done" }));
}

try {
  await { setup, observe, teardown }[command]();
} catch (error) {
  console.error(`stopped: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 2;
}
