import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ISSUE_TRIAGE_MAX_ISSUES,
  ISSUE_TRIAGE_OBSERVATION_MAX_AGE_MS,
  issueNumberOfSubject,
  issueTriageOutputSchema,
  issueTriagePromptText,
  issuesFromObservationPayload,
  issuesToTriage,
  parseIssueTriageAnswer,
  runIssueTriage,
} from "../lib/productResearchScoutIssuesCore.ts";
import { buildObservationPayload } from "../lib/productResearchObservationCore.mjs";

const issueRow = (number, verdict, title) => ({ number, title, verdict, resolvedOn: [], missingFrom: [], signals: [] });

const payload = () => {
  const built = buildObservationPayload({
    classified: [
      issueRow(881, "landed_but_unverified", "Deep research settlement"),
      issueRow(1277, "open_work", "Ops remainder of #256"),
    ],
  });
  assert.ok(built.payload, JSON.stringify(built.failure));
  return built.payload;
};

test("issues come from a payload the observation core accepts, and nothing else", () => {
  const issues = issuesFromObservationPayload(payload());
  assert.deepEqual(issues.map((issue) => [issue.id, issue.verdict]), [["881", "landed_but_unverified"], ["1277", "open_work"]]);
  assert.equal(issuesFromObservationPayload({ issues: [] }), null);
  assert.equal(issuesFromObservationPayload(null), null);
});

test("a stored payload whose keys JSONB reordered is still read", () => {
  // Postgres JSONB does not keep key order; production's stored payload came
  // back with its count keys in another order and every triage was refused.
  const reorder = (value) => {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorder(value[key])]));
    }
    return value;
  };
  const issues = issuesFromObservationPayload(reorder(payload()));
  assert.deepEqual(issues?.map((issue) => issue.id), ["881", "1277"]);
});

test("the prompt names every issue with its verdict and fences the data", () => {
  const text = issueTriagePromptText(issuesFromObservationPayload(payload()), new Date("2026-11-10T21:30:00Z"));
  assert.match(text, /#881 \| verdict=landed_but_unverified/);
  assert.match(text, /#1277 \| verdict=open_work/);
  assert.match(text, /<issues>[\s\S]*<\/issues>/);
  assert.equal(issueTriageOutputSchema(2).properties.issues.maxItems, 2);
});

test("an issue already suggested is not asked about again, and one call is bounded", () => {
  const issues = issuesFromObservationPayload(payload());
  assert.deepEqual(issuesToTriage(issues, new Set(["881"])).map((issue) => issue.id), ["1277"]);
  const many = Array.from({ length: ISSUE_TRIAGE_MAX_ISSUES + 5 }, (_, index) => ({ ...issues[0], id: String(index + 1) }));
  assert.equal(issuesToTriage(many, new Set()).length, ISSUE_TRIAGE_MAX_ISSUES);
});

test("only answers naming a given issue are kept, once each, with the action in the title", () => {
  const given = issuesFromObservationPayload(payload());
  const kept = parseIssueTriageAnswer(
    {
      issues: [
        { issue: 881, action: "close", severity: "medium", evidence: "main에 Closes #881 commit", suggestion: "확인 후 닫기" },
        { issue: 881, action: "proceed", severity: "low", evidence: "중복", suggestion: "중복" },
        { issue: 9999, action: "close", severity: "low", evidence: "없는 이슈", suggestion: "닫기" },
        { issue: 1277, action: "delete", severity: "low", evidence: "모르는 행동", suggestion: "x" },
        { issue: 1277, action: "wait", severity: "low", evidence: "", suggestion: "x" },
        { issue: "#1277", action: "wait", severity: "low", evidence: "운영 잔여", suggestion: "운영자 확인 대기" },
      ],
    },
    given,
  );
  assert.deepEqual(kept.map((row) => [row.subject, row.title]), [
    ["issue.881", "#881 닫기 · Deep research settlement"],
    ["issue.1277", "#1277 대기 · Ops remainder of #256"],
  ]);
  assert.match(kept[0].suggestion, /https:\/\/github\.com\/mposition\/Tomverse\/issues\/881$/);
  assert.equal(kept[0].area, "other");
  assert.deepEqual(parseIssueTriageAnswer(null, given), []);
  assert.equal(issueNumberOfSubject("issue.881"), "881");
  assert.equal(issueNumberOfSubject("pricing.en"), null);
});

const deps = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      now: new Date("2026-11-11T18:00:00Z"),
      latestObservation: async () => ({ slot: new Date("2026-11-10T21:30:00Z"), payload: payload() }),
      alreadySuggested: async (since) => {
        calls.push(["alreadySuggested", since.toISOString()]);
        return new Set();
      },
      model: async () => ({
        modelId: "m",
        triageIssues: async (issues) => {
          calls.push(["triage", issues.map((issue) => issue.id)]);
          return {
            suggestions: [{ subject: "issue.881", title: "#881 닫기 · x", area: "other", severity: "low", evidence: "e", suggestion: "s" }],
            inputTokens: 10,
            outputTokens: 5,
          };
        },
      }),
      reserve: async (modelId) => {
        calls.push(["reserve", modelId]);
        return { id: "call-1" };
      },
      settle: async (id, result) => {
        calls.push(["settle", id, result.ok, result.kept]);
      },
      insert: async (modelId, suggestions) => {
        calls.push(["insert", modelId, suggestions.length]);
        return suggestions.length;
      },
      ...overrides,
    },
  };
};

test("a day's triage reserves from the cap, calls once, settles and stores", async () => {
  const { deps: d, calls } = deps();
  assert.deepEqual(await runIssueTriage(d), { judged: true, issues: 2, stored: 1 });
  assert.deepEqual(calls.map((call) => call[0]), ["alreadySuggested", "reserve", "triage", "settle", "insert"]);
  assert.equal(calls[0][1], "2026-10-28T18:00:00.000Z");
});

test("nothing is reserved or called without a recent readable observation, new issues and a model", async () => {
  const stale = new Date(Date.parse("2026-11-11T18:00:00Z") - ISSUE_TRIAGE_OBSERVATION_MAX_AGE_MS - 1);
  const cases = [
    [{ latestObservation: async () => null }, "no_observation"],
    [{ latestObservation: async () => ({ slot: stale, payload: payload() }) }, "no_recent_observation"],
    [{ latestObservation: async () => ({ slot: new Date("2026-11-10T21:30:00Z"), payload: { issues: "x" } }) }, "observation_unreadable"],
    [{ alreadySuggested: async () => new Set(["881", "1277"]) }, "nothing_to_triage"],
    [{ model: async () => null }, "model_off"],
  ];
  for (const [override, reason] of cases) {
    const { deps: d, calls } = deps(override);
    assert.deepEqual(await runIssueTriage(d), { judged: false, reason });
    assert.ok(!calls.some((call) => call[0] === "reserve" || call[0] === "triage"), reason);
  }
});

test("a refused reservation spends nothing; a failed call is settled failed and stores nothing", async () => {
  const refused = deps({ reserve: async () => ({ refused: "daily_cap_reached" }) });
  assert.deepEqual(await runIssueTriage(refused.deps), { judged: false, reason: "daily_cap_reached" });
  assert.ok(!refused.calls.some((call) => call[0] === "triage"));

  const failed = deps({
    model: async () => ({ modelId: "m", triageIssues: async () => ({ suggestions: null, inputTokens: null, outputTokens: null }) }),
  });
  assert.deepEqual(await runIssueTriage(failed.deps), { judged: false, reason: "model_failed" });
  assert.deepEqual(failed.calls.find((call) => call[0] === "settle"), ["settle", "call-1", false, null]);
  assert.ok(!failed.calls.some((call) => call[0] === "insert"));
});
