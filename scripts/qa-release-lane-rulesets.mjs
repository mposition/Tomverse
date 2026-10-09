// Applies the merge lane's two real rulesets (docs/policy/qa-release-agent.md
// version 7, section 8 items 7 and 9) -- only on the strength of an
// observation record from scripts/qa-release-lane-observe.mjs that still
// holds: it passed, it names the same bypass list, and develop's and main's
// protection now is the one it recorded (item 10).
//
//   npm run qa-release:lane-rulesets -- --record <record.json> --observation-app-id <id> --bypass 29110
//   npm run qa-release:lane-rulesets -- --record <record.json> --observation-app-id <id> --bypass 29110 --apply
//
// Without --apply it prints the two request bodies and whether the record
// holds, and changes nothing. With --apply it creates both rulesets, then
// reads develop's and main's rules back and prints them. GH_TOKEN is the
// operator's own token (repository admin). Nothing secret is printed.
//
// Undo: delete the two rulesets named "qa-release-lane: ..." in the
// repository's Settings -> Rules -> Rulesets, or with
// `gh api -X DELETE repos/mposition/Tomverse/rulesets/<id>`.

import { readFileSync } from "node:fs";


import { qaReleaseClassicProtection, qaReleaseRulesetRules } from "../lib/qaReleaseBranchProtectionCore.ts";
import { qaReleaseRecordStillHolds } from "../lib/qaReleaseLaneObservationCore.ts";
import {
  QA_RELEASE_DEVELOP_RULESET_NAME,
  QA_RELEASE_UPDATE_RULESET_NAME,
  qaReleaseLaneRulesets,
  qaReleaseReadWorkflow,
  qaReleaseWorkflowBranchWriters,
} from "../lib/qaReleaseLaneRulesetsCore.ts";

const API = "https://api.github.com/repos/mposition/Tomverse";
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const token = (process.env.GH_TOKEN || "").trim();
if (!token) fail("GH_TOKEN (the operator's token, repository admin) is required.");
const recordPath = option("record");
if (!recordPath) fail("--record <observation record JSON> is required.");
const appId = Number(option("observation-app-id"));
const bypassAppIds = (option("bypass") ?? "").split(",").filter(Boolean).map(Number);
const apply = args.includes("--apply");

const call = async (method, path, body) => {
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
  return { status: response.status, json: text ? JSON.parse(text) : null };
};
const readProtection = async (branch) => {
  const classic = await call("GET", `/branches/${branch}/protection`);
  const rules = await call("GET", `/rules/branches/${branch}`);
  if ((classic.status !== 200 && classic.status !== 404) || rules.status !== 200) throw new Error(`could not read ${branch}'s protection`);
  return { branch, classic: qaReleaseClassicProtection(classic.status === 404 ? null : classic.json), rules: qaReleaseRulesetRules(rules.json) };
};

/** Every workflow file on a branch, as text: the push check reads what that branch would run. */
const readWorkflows = async (ref) => {
  const list = await call("GET", `/contents/.github/workflows?ref=${ref}`);
  if (list.status !== 200 || !Array.isArray(list.json)) throw new Error(`could not list ${ref}'s workflows`);
  const files = [];
  for (const entry of list.json.filter((item) => item.type === "file" && /\.ya?ml$/.test(item.name))) {
    const response = await fetch(`${API}/contents/${entry.path}?ref=${ref}`, {
      headers: { accept: "application/vnd.github.raw+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) throw new Error(`could not read ${entry.path} on ${ref}`);
    const text = await response.text();
    files.push(qaReleaseReadWorkflow(entry.path, text));
  }
  return files;
};

try {
  // Applied, the update ruleset refuses a workflow-token (or App, or deploy
  // key) update to any branch but develop. Refuse first while a workflow on
  // develop or main holds such a credential and is not a reviewed file
  // (visual-baseline-record until its token drops to contents: read).
  const permission = await call("GET", "/actions/permissions/workflow");
  const defaultPermission = permission.json?.default_workflow_permissions;
  if (permission.status !== 200 || (defaultPermission !== "read" && defaultPermission !== "write")) {
    fail("Could not read the repository's default workflow token permission. Nothing was changed.");
  }
  const writers = [];
  for (const ref of ["develop", "main"]) {
    for (const finding of qaReleaseWorkflowBranchWriters(await readWorkflows(ref), defaultPermission)) writers.push(`${ref}: ${finding}`);
  }
  if (writers.length > 0) {
    fail(
      `These workflows could update a branch with a credential the rulesets will refuse, and are not reviewed files ` +
        `(lib/qaReleaseLaneRulesetsCore.ts QA_RELEASE_REVIEWED_WRITER_WORKFLOWS). Nothing was changed: ${writers.join(", ")}`,
    );
  }

  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (record.observationAppId !== appId) fail("--observation-app-id differs from the record's observation App.");
  const bodies = qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds, laneAppId: appId });
  const now = { develop: await readProtection("develop"), main: await readProtection("main"), bypassAppIds };
  const check = qaReleaseRecordStillHolds(record, now);
  const existing = (await call("GET", "/rulesets?per_page=100")).json ?? [];
  const already = existing.filter((ruleset) => [QA_RELEASE_UPDATE_RULESET_NAME, QA_RELEASE_DEVELOP_RULESET_NAME].includes(ruleset.name));
  console.log(JSON.stringify({ recordHolds: check.holds, reasons: check.reasons, alreadyApplied: already.map((r) => r.name), bodies }, null, 2));
  if (!check.holds) fail("The record does not hold; observe again (policy section 8 item 10). Nothing was changed.");
  if (already.length > 0) fail("A lane ruleset already exists. Nothing was changed.");
  if (!apply) {
    console.log("Dry run: nothing was changed. Add --apply to create both rulesets.");
    process.exit(0);
  }
  for (const body of [bodies.update, bodies.develop]) {
    const created = await call("POST", "/rulesets", body);
    if (created.status !== 201) {
      const details = (Array.isArray(created.json?.errors) ? created.json.errors.slice(0, 5) : []).map((e) => (typeof e === "string" ? e : [e?.resource, e?.field, e?.code, e?.message].filter((v) => typeof v === "string").join(" ")));
      fail(`creating "${body.name}" answered ${created.status}: ${[created.json?.message ?? "", ...details].filter(Boolean).join(" | ").slice(0, 600)}`);
    }
    console.log(`created ruleset ${created.json.id}: ${body.name}`);
  }
  const after = { develop: await readProtection("develop"), main: await readProtection("main") };
  console.log(JSON.stringify({ rulesNow: { develop: after.develop.rules, main: after.main.rules } }, null, 2));
} catch (error) {
  console.error(`stopped: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 2;
}
