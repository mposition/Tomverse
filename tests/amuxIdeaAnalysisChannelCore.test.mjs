import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_IDEA_ANALYSIS_PROVIDERS,
  AMUX_SUBSCRIPTION_AUTH_PROFILES,
  AMUX_V4_ANALYSIS_PROVIDERS,
  amuxSubscriptionAuthProfile,
  isAmuxIdeaAnalysisProvider,
  isAmuxV4AnalysisProvider,
} from "../lib/amux/ideaAnalysisChannelCore.ts";

// AMUX intake v19 subscription channels (owner decision 2026-10-20). The code
// lists and the database's effective constraints and claim guard must agree.
const root = new URL("../prisma/migrations/", import.meta.url);
const migrations = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  .map((name) => ({ name,
    sql: readFileSync(new URL(`${name}/migration.sql`, root), "utf8").replace(/\r\n/g, "\n") }));

/** The newest migration that (re)defines one CHECK, and that definition. */
const effectiveCheck = (constraint) => {
  for (const { name, sql } of [...migrations].reverse()) {
    // Inline in CREATE TABLE or ALTER TABLE ... ADD; a DROP has no CHECK after it.
    const found = [...sql.matchAll(new RegExp(`CONSTRAINT "${constraint}"[ \\t\\n]+CHECK`, "g"))].at(-1);
    if (!found) continue;
    const at = found.index;
    const end = sql.indexOf(";", at);
    return { name, definition: sql.slice(at, end) };
  }
  throw new Error(`no definition for ${constraint}`);
};

const providerList = (definition, column) => {
  const match = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(definition);
  assert.ok(match, `${column} list`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]);
};

test("four CLI channels for v19, two vendors for the v4 path", () => {
  assert.deepEqual(AMUX_IDEA_ANALYSIS_PROVIDERS, ["openai", "anthropic", "github-copilot", "cursor"]);
  assert.deepEqual(AMUX_V4_ANALYSIS_PROVIDERS, ["openai", "anthropic"]);
  for (const provider of AMUX_IDEA_ANALYSIS_PROVIDERS) assert.equal(isAmuxIdeaAnalysisProvider(provider), true);
  for (const value of ["xai", "Anthropic", "", null, undefined, "github_copilot"]) {
    assert.equal(isAmuxIdeaAnalysisProvider(value), false);
    assert.equal(amuxSubscriptionAuthProfile(value), null);
  }
  assert.equal(isAmuxV4AnalysisProvider("cursor"), false);
  assert.deepEqual({ ...AMUX_SUBSCRIPTION_AUTH_PROFILES }, {
    openai: "codex-chatgpt", anthropic: "claude-max-oauth",
    "github-copilot": "copilot-github", cursor: "cursor-login",
  });
  assert.equal(amuxSubscriptionAuthProfile("toString"), null);
});

test("every v19 provider CHECK in force admits exactly the code's channels", () => {
  for (const [constraint, column] of [
    ["AmuxIdeaFrontierModelApproval_provider_check", "provider"],
    ["AmuxIdeaAnalysisPriceVersion_provider_check", "provider"],
    ["AmuxIdeaOperatingScopeSetting_value_check", "modelProvider"],
    ["AmuxIdeaSessionAnalysisReservation_provider_check", "modelProvider"],
    ["AmuxIdeaSessionAnalysisBudgetClaim_values_check", "provider"],
  ]) {
    const { definition } = effectiveCheck(constraint);
    assert.deepEqual(providerList(definition, column), [...AMUX_IDEA_ANALYSIS_PROVIDERS], constraint);
  }
  const claim = effectiveCheck("AmuxIdeaSessionAnalysisBudgetClaim_values_check").definition;
  assert.doesNotMatch(claim, /"provider" = 'anthropic'/,
    "a subscription claim is no longer limited to the anthropic channel");
  // The v4 hold ledger keeps its two vendors.
  assert.deepEqual(providerList(effectiveCheck("AmuxIdeaAnalysisBudgetHold_provider_check").definition,
    "provider"), [...AMUX_V4_ANALYSIS_PROVIDERS]);
});

test("the claim mode guard in force binds each channel to the code's profile", () => {
  const latest = [...migrations].reverse().find(({ sql }) =>
    /CREATE (?:OR REPLACE )?FUNCTION "amux_v21_session_claim_mode_guard"/.test(sql));
  assert.ok(latest);
  const body = latest.sql.slice(latest.sql.indexOf('FUNCTION "amux_v21_session_claim_mode_guard"'));
  const block = /CASE NEW\."provider"([\s\S]*?)END, false\)/.exec(body);
  assert.ok(block, "profile map");
  const map = Object.fromEntries([...block[1].matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)]
    .map((match) => [match[1], match[2]]));
  assert.deepEqual(map, { ...AMUX_SUBSCRIPTION_AUTH_PROFILES });
  assert.match(body, /NOT COALESCE\(audit_row\."metadata"->>'maxAuthProfile' =/);
  assert.doesNotMatch(body.slice(0, body.indexOf("$$;")), /NEW\."provider" <> 'anthropic'/);
});
