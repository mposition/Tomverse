// The S-M0 test-branch observations of the merge lane's protection
// (docs/policy/qa-release-agent.md version 7, section 8 items 7, 9, 10 and
// 11). The operator runs it locally (docs/ops/qa-release-merge-lane-s-m1.md):
//
//   npm run qa-release:lane-observe -- setup --observation-app-id <id> --bypass 29110
//   npm run qa-release:lane-observe -- automation-status --bypass 29110
//   npm run qa-release:lane-observe -- observe --observation-app-id <id> --bypass 29110 --observation-key <pem path>
//   npm run qa-release:lane-observe -- teardown
//
// Credentials: GH_TOKEN (the operator's own token, repository admin) for
// everything a person does, and the observation App's private key -- read
// from a local file, never from a service's environment, and never printed
// (item 11) -- for everything the App does.
//
// It writes only to branches named qa-lane-test/* and to the two rulesets
// named exactly in QA_RELEASE_TEST_RULESET_NAMES. The test update ruleset
// also covers the bypass automation's own branches (dependabot/**,
// visual-baseline/**) so their updates under it can be observed; the
// automation is on its bypass list. `teardown` removes all of it. The real
// rulesets are a separate step (scripts/qa-release-lane-rulesets.mjs) that
// requires the record this writes.
//
// The output is the record and a verdict table: statuses and GitHub's error
// messages, never a token, a key or a header.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import {
  qaReleaseCanonicalJson,
  qaReleaseClassicDifferences,
  qaReleaseClassicProtection,
  qaReleaseClassicProtectionBody,
  qaReleaseRulesetRules,
} from "../lib/qaReleaseBranchProtectionCore.ts";
import {
  QA_RELEASE_OBSERVATIONS,
  QA_RELEASE_TEST_BRANCHES as T,
  judgeQaReleaseObservations,
  qaReleaseAutomationMissing,
  qaReleaseAutomationUpdates,
} from "../lib/qaReleaseLaneObservationCore.ts";
import { QA_RELEASE_TEST_RULESET_NAMES, qaReleaseComparableRules, qaReleaseLaneRulesets } from "../lib/qaReleaseLaneRulesetsCore.ts";
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
if (!["setup", "automation-status", "observe", "teardown"].includes(command)) {
  fail("usage: setup | automation-status | observe | teardown (see the header of this file)");
}
const operatorToken = (process.env.GH_TOKEN || "").trim();
if (!operatorToken) fail("GH_TOKEN (the operator's token, repository admin) is required.");
const appId = option("observation-app-id");
const bypassAppIds = [...new Set((option("bypass") ?? "").split(",").filter(Boolean).map(Number))].sort((a, b) => a - b);
if (command !== "teardown" && bypassAppIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) fail("--bypass takes comma-separated numeric App ids.");
if ((command === "setup" || command === "observe") && !/^[1-9][0-9]{0,11}$/.test(appId ?? "")) {
  fail("--observation-app-id <the observation App's numeric id> is required.");
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
/**
 * GitHub's own explanation of a refusal: its message and, for a 422, the
 * `errors` list naming what it rejected. Strings only, cut short; never a
 * header or a token.
 */
const explain = (json) => {
  const parts = [typeof json?.message === "string" ? json.message : ""];
  for (const error of Array.isArray(json?.errors) ? json.errors.slice(0, 5) : []) {
    parts.push(typeof error === "string" ? error : [error?.resource, error?.field, error?.code, error?.message].filter((v) => typeof v === "string").join(" "));
  }
  return parts.filter(Boolean).join(" | ").slice(0, 600);
};

/** A call that must succeed for the harness itself (not an observation). */
const must = async (token, method, path, body, ok = [200, 201, 204]) => {
  const answer = await call(token, method, path, body);
  if (!ok.includes(answer.status)) throw new Error(`${method} ${path} answered ${answer.status}: ${explain(answer.json)}`);
  return answer.json;
};
const operator = (method, path, body, ok) => must(operatorToken, method, path, body, ok);
const headSha = async (branch) => {
  const ref = await call(operatorToken, "GET", `/git/ref/heads/${branch}`);
  return ref.status === 200 ? ref.json.object.sha : null;
};

const readClassic = async (branch) => {
  const classic = await call(operatorToken, "GET", `/branches/${encodeURIComponent(branch)}/protection`);
  if (classic.status !== 200 && classic.status !== 404) throw new Error(`protection of ${branch} answered ${classic.status}`);
  return qaReleaseClassicProtection(classic.status === 404 ? null : classic.json);
};
const readProtection = async (branch) => ({
  branch,
  classic: await readClassic(branch),
  rules: qaReleaseRulesetRules(await operator("GET", `/rules/branches/${branch}`)),
});

/**
 * Item 10 asks for the real branches' whole protection on the test branches.
 * This harness copies classic protection exactly; it does not copy an
 * existing ruleset, so with any ruleset on develop or main it refuses rather
 * than observe a protection that is not the real one.
 */
const requireNoRealRulesets = (protection) => {
  for (const branch of ["develop", "main"]) {
    if (protection[branch].rules.length > 0) {
      fail(`${branch} already has ruleset rules; this harness cannot copy them to a test branch, so it does not observe (policy section 8 item 10).`);
    }
  }
};

/** The test rulesets the builder makes for this bypass list. */
const testRulesetBodies = () =>
  qaReleaseLaneRulesets({
    scope: { kind: "test", updateBranches: [T.mainMirror, T.otherBase], developBranch: T.developMirror },
    bypassAppIds,
    laneAppId: Number(appId ?? 1),
  });

const listTestRulesets = async () => {
  const all = await operator("GET", "/rulesets?per_page=100");
  return all.filter((ruleset) => QA_RELEASE_TEST_RULESET_NAMES.includes(ruleset.name));
};

/** The mirrors must still carry the real branches' classic protection, and the test rulesets must be the builder's. */
const verifyTestProtection = async (protection) => {
  const problems = [];
  for (const [mirror, real] of [[T.mainMirror, protection.main], [T.developMirror, protection.develop]]) {
    const differences = qaReleaseClassicDifferences(real.classic, await readClassic(mirror));
    if (differences.length > 0) problems.push(`${mirror}: ${differences.join(", ")}`);
  }
  const expected = testRulesetBodies();
  const existing = await listTestRulesets();
  for (const body of [expected.update, expected.develop]) {
    const found = existing.filter((ruleset) => ruleset.name === body.name);
    if (found.length !== 1) {
      problems.push(`ruleset "${body.name}": ${found.length} found`);
      continue;
    }
    const detail = await operator("GET", `/rulesets/${found[0].id}`);
    // Compared as values: key order and the order of rules, refs and bypass
    // entries carry no meaning, so they are normalised first.
    const sortedRefs = (refName) => ({ include: [...(refName?.include ?? [])].sort(), exclude: [...(refName?.exclude ?? [])].sort() });
    const rulesOf = (rules) => qaReleaseComparableRules(rules);
    const bypassOf = (actors) => [...(actors ?? [])].map((a) => [a.actor_id, a.actor_type, a.bypass_mode]).sort((a, b) => String(a).localeCompare(String(b)));
    const same =
      qaReleaseCanonicalJson(sortedRefs(detail.conditions?.ref_name)) === qaReleaseCanonicalJson(sortedRefs(body.conditions.ref_name)) &&
      qaReleaseCanonicalJson(rulesOf(detail.rules)) === qaReleaseCanonicalJson(rulesOf(body.rules)) &&
      qaReleaseCanonicalJson(bypassOf(detail.bypass_actors)) === qaReleaseCanonicalJson(bypassOf(body.bypass_actors)) &&
      detail.enforcement === "active";
    if (!same) problems.push(`ruleset "${body.name}" differs from the one this bypass list makes`);
  }
  return problems;
};

/**
 * Since when the test update ruleset has been in its current form: its last
 * change, not its creation. A ruleset disabled or narrowed and then restored
 * would pass the current-state check, and an update made while it was off
 * must not count as an update under it.
 */
const testRulesetsSince = async () => {
  const update = (await listTestRulesets()).find((ruleset) => ruleset.name === QA_RELEASE_TEST_RULESET_NAMES[0]);
  if (!update) fail("the test rulesets are missing; run setup first.");
  const detail = await operator("GET", `/rulesets/${update.id}`);
  const times = [detail.created_at, detail.updated_at].filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (times.length === 0) throw new Error("ruleset times unreadable");
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
};

/**
 * The `rel="next"` URL of a Link header, only when it stays on this
 * repository's activity endpoint. GitHub writes the cursor link with the
 * numeric repository id (`/repositories/<id>/activity?...&after=...`).
 */
const nextLink = (link, repositoryId) => {
  const match = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
  if (!match) return null;
  const allowed = [`${API}/activity?`, `https://api.github.com/repositories/${repositoryId}/activity?`];
  return allowed.some((prefix) => match[1].startsWith(prefix)) ? match[1] : null;
};

/** Repository activity since the test ruleset's current form, newest first, following GitHub's cursor up to ten pages. */
const automationEvidence = async () => {
  const since = await testRulesetsSince();
  const repositoryId = (await operator("GET", "")).id;
  if (!Number.isSafeInteger(repositoryId)) throw new Error("repository id unreadable");
  const activity = [];
  let url = `${API}/activity?direction=desc&per_page=100`;
  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetch(url, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${operatorToken}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) throw new Error(`activity answered ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    activity.push(...batch);
    const oldest = batch[batch.length - 1]?.timestamp;
    if (typeof oldest === "string" && Date.parse(oldest) < Date.parse(since)) break;
    url = nextLink(response.headers.get("link"), repositoryId);
  }
  const updates = qaReleaseAutomationUpdates(activity, bypassAppIds, since);
  return { since, updates, missingAppIds: qaReleaseAutomationMissing(updates, bypassAppIds) };
};

// ---- setup -----------------------------------------------------------------

async function setup() {
  for (const name of Object.values(T)) {
    if (await headSha(name)) fail(`${name} already exists; run teardown first.`);
  }
  if ((await listTestRulesets()).length > 0) fail("test rulesets already exist; run teardown first.");

  const protection = { develop: await readProtection("develop"), main: await readProtection("main") };
  requireNoRealRulesets(protection);
  let bodies;
  try {
    bodies = { main: qaReleaseClassicProtectionBody(protection.main.classic), develop: qaReleaseClassicProtectionBody(protection.develop.classic) };
  } catch {
    fail("develop's or main's classic protection holds a setting this harness cannot copy exactly; nothing was changed (policy section 8 item 10).");
  }

  const mainHead = await headSha("main");
  if (!SHA.test(mainHead ?? "")) fail("could not read main's head.");

  // Each mirror needs a head whose required checks passed, one fast-forward
  // ahead of the mirror: then a pull request from it merges cleanly and
  // meets the classic checks, and only the rules can refuse it. Not the real
  // branch's own head: required checks run on pull requests, not on the
  // merge commit the branch is pushed to. So the head of a recently merged
  // pull request into that branch, each required check passed from the App
  // it names, with the mirror at that commit's parent. A develop commit
  // against main conflicts once the two diverge (2026-10-08).
  const passed = async (sha, required) => {
    for (const check of required) {
      const runs = await operator("GET", `/commits/${sha}/check-runs?check_name=${encodeURIComponent(check.context)}&per_page=100`);
      const ok = runs.check_runs.some((run) => run.conclusion === "success" && (check.appId === null || run.app?.id === check.appId));
      if (!ok) return false;
    }
    return true;
  };
  const greenHead = async (branch) => {
    const required = protection[branch].classic.present ? protection[branch].classic.requiredChecks ?? [] : [];
    const merged = await operator("GET", `/pulls?state=closed&base=${branch}&sort=updated&direction=desc&per_page=30`);
    for (const pull of merged) {
      if (!pull.merged_at || !SHA.test(pull.head?.sha ?? "")) continue;
      if (!(await passed(pull.head.sha, required))) continue;
      const parent = (await operator("GET", `/commits/${pull.head.sha}`)).parents?.[0]?.sha;
      if (SHA.test(parent ?? "")) return { sha: pull.head.sha, parent, pullRequest: pull.number };
    }
    fail(`no recently merged ${branch} pull request has a head commit with every required check passed; nothing was changed.`);
  };
  const green = await greenHead("develop");
  const mainGreen = await greenHead("main");
  const developHead = green.sha;
  const developParent = green.parent;

  const create = (name, sha) => operator("POST", "/git/refs", { ref: `refs/heads/${name}`, sha });
  await create(T.mainMirror, mainGreen.parent);
  await create(T.otherBase, mainGreen.parent);
  await create(T.developMirror, developParent);
  await create(T.head, developHead);
  await create(T.headReviewed, developHead);
  await create(T.mainHead, mainGreen.sha);
  await create(T.mainHeadReviewed, mainGreen.sha);

  // Item 10: the mirrors copy the real branches' classic protection.
  if (bodies.main) await operator("PUT", `/branches/${encodeURIComponent(T.mainMirror)}/protection`, bodies.main);
  if (bodies.develop) await operator("PUT", `/branches/${encodeURIComponent(T.developMirror)}/protection`, bodies.develop);
  const { update, develop } = testRulesetBodies();
  await operator("POST", "/rulesets", update);
  await operator("POST", "/rulesets", develop);

  // Read back: a copy that GitHub stored differently is not a copy.
  const problems = await verifyTestProtection(protection);
  if (problems.length > 0) fail(`the test protection is not an exact copy (${problems.join("; ")}); run teardown.`);
  console.log(
    JSON.stringify(
      {
        setup: "done",
        mainHead,
        greenCommit: developHead,
        greenCommitPullRequest: green.pullRequest,
        developMirrorAt: developParent,
        mainGreenCommit: mainGreen.sha,
        mainGreenCommitPullRequest: mainGreen.pullRequest,
        mainMirrorAt: mainGreen.parent,
      },
      null,
      2,
    ),
  );
  console.log("Next: make each bypass App update one of its branches (docs/ops/qa-release-merge-lane-s-m1.md 2-2), then automation-status.");
}

// ---- automation-status (read-only) -----------------------------------------

async function automationStatus() {
  const evidence = await automationEvidence();
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = evidence.missingAppIds.length === 0 ? 0 : 1;
}

// ---- observe ---------------------------------------------------------------

async function observe() {
  const keyPath = option("observation-key");
  if (!keyPath) fail("--observation-key <path to the observation App's private key file> is required.");

  // Item 10: the real branches' protection, read right before the
  // observations, and the test branches must still carry exactly that.
  const protection = { develop: await readProtection("develop"), main: await readProtection("main") };
  requireNoRealRulesets(protection);
  const problems = await verifyTestProtection(protection);
  if (problems.length > 0) fail(`the test protection no longer matches the real one (${problems.join("; ")}); run teardown and setup again.`);
  const automation = await automationEvidence();
  if (automation.missingAppIds.length > 0) {
    fail(`no branch update yet under the test ruleset by bypass App(s) ${automation.missingAppIds.join(", ")}; see automation-status (policy section 8 item 7).`);
  }

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
  const developHead = await headSha(T.head);
  if (!developHead || !(await headSha(T.mainHead)) || !(await headSha(T.mainHeadReviewed))) fail("the test branches are missing; run teardown and setup again.");

  const results = [];
  const note = (id, answer) =>
    results.push({ id, status: answer?.status ?? null, message: typeof answer?.json?.message === "string" ? answer.json.message.slice(0, 200) : null });
  const openPull = async (token, head, base, title) => {
    const answer = await call(token, "POST", "/pulls", { head, base, title, body: "QA-release merge lane S-M0 observation (docs/policy/qa-release-agent.md section 8). Closed by teardown." });
    if (answer.status !== 201) throw new Error(`opening ${head} -> ${base} answered ${answer.status}: ${explain(answer.json)}`);
    return answer.json;
  };
  const merge = (token, pull) => call(token, "PUT", `/pulls/${pull.number}/merge`, { sha: pull.head.sha, merge_method: "merge" });
  /** A new commit object on top of a branch head (creating an object moves no ref). */
  const commitOnTop = async (token, branch) => {
    const parent = await headSha(branch);
    const commit = await must(token, "GET", `/git/commits/${parent}`);
    const created = await must(token, "POST", "/git/commits", { message: "QA-release merge lane S-M0 observation", tree: commit.tree.sha, parents: [parent] });
    return created.sha;
  };
  const moveRef = (token, branch, sha) => call(token, "PATCH", `/git/refs/heads/${branch}`, { sha, force: false });

  // 8.7: the main mirror and another base.
  const unreviewed = await openPull(operatorToken, T.mainHead, T.mainMirror, "qa-lane-test: unreviewed");
  note("app_merge_unreviewed_main", await merge(appToken, unreviewed));

  const reviewed = await openPull(appToken, T.mainHeadReviewed, T.mainMirror, "qa-lane-test: reviewed");
  await operator("POST", `/pulls/${reviewed.number}/reviews`, { event: "APPROVE", body: "QA-release merge lane S-M0 observation." });
  note("app_merge_reviewed_main", await merge(appToken, reviewed));

  note("app_push_main", await moveRef(appToken, T.mainMirror, await commitOnTop(appToken, T.mainMirror)));

  const otherBase = await openPull(appToken, T.mainHead, T.otherBase, "qa-lane-test: other base");
  note("app_merge_other_base", await merge(appToken, otherBase));

  note("operator_merge_main", await merge(operatorToken, unreviewed));

  // 8.9: the develop mirror. The refused push first, then the merge that moves it.
  note("app_push_green_develop", await moveRef(appToken, T.developMirror, developHead));
  const developPull = await openPull(appToken, T.head, T.developMirror, "qa-lane-test: develop");
  note("app_merge_develop", await merge(appToken, developPull));
  note("operator_push_develop", await moveRef(operatorToken, T.developMirror, await commitOnTop(operatorToken, T.developMirror)));

  const verdict = judgeQaReleaseObservations(results);
  const record = {
    recordVersion: 2,
    observedAt: new Date().toISOString(),
    repository: `${OWNER}/${REPO}`,
    observationAppId: Number(appId),
    bypassAppIds,
    protection,
    results,
    verdict,
    automation,
  };
  mkdirSync(RECORD_DIR, { recursive: true });
  const file = `${RECORD_DIR}/${record.observedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  for (const spec of QA_RELEASE_OBSERVATIONS) {
    const v = verdict.verdicts.find((entry) => entry.id === spec.id);
    const r = results.find((entry) => entry.id === spec.id);
    console.log(`${v.ok ? "ok  " : "FAIL"}  ${spec.id.padEnd(24)} expected ${spec.expect.padEnd(9)} observed ${v.observed.padEnd(9)} ${r?.status ?? "-"}  ${r?.message ?? ""}`);
  }
  for (const update of automation.updates) console.log(`ok    automation ${update.appId} ${update.activityType} ${update.ref} at ${update.at}`);
  console.log(`\n${verdict.passed ? "All as expected." : "NOT as expected: do not apply the real rulesets (policy section 8 item 7)."}`);
  console.log(`Record: ${file}`);
  process.exitCode = verdict.passed ? 0 : 1;
}

// ---- teardown --------------------------------------------------------------

async function teardown() {
  const open = await operator("GET", "/pulls?state=open&per_page=100");
  for (const pull of open.filter((entry) => entry.head?.ref?.startsWith("qa-lane-test/") || entry.base?.ref?.startsWith("qa-lane-test/"))) {
    await operator("PATCH", `/pulls/${pull.number}`, { state: "closed" });
  }
  // Only the two exact names, and only while every branch they cover is a
  // test branch or a bypass automation branch -- never a ruleset that guards
  // a real branch, whatever it is called.
  const allowed = (ref) => ref.startsWith("refs/heads/qa-lane-test/") || ref === "refs/heads/dependabot/**" || ref === "refs/heads/visual-baseline/**";
  for (const ruleset of await listTestRulesets()) {
    const detail = await operator("GET", `/rulesets/${ruleset.id}`);
    const include = detail.conditions?.ref_name?.include ?? [];
    if (include.length === 0 || !include.every(allowed) || (detail.conditions?.ref_name?.exclude ?? []).length > 0) {
      console.error(`left ruleset ${ruleset.id} ("${ruleset.name}") in place: it covers more than the test branches.`);
      process.exitCode = 1;
      continue;
    }
    await operator("DELETE", `/rulesets/${ruleset.id}`, undefined, [204]);
  }
  for (const name of Object.values(T)) {
    await call(operatorToken, "DELETE", `/branches/${encodeURIComponent(name)}/protection`);
    if (await headSha(name)) await operator("DELETE", `/git/refs/heads/${name}`, undefined, [204]);
  }
  console.log(JSON.stringify({ teardown: process.exitCode ? "partial" : "done" }));
}

try {
  await { setup, "automation-status": automationStatus, observe, teardown }[command]();
} catch (error) {
  console.error(`stopped: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 2;
}
