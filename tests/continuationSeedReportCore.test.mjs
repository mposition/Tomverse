import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MIN_EXCERPT_TOKENS,
  SEED_CANDIDATES,
  aggregateSeedSamples,
  evaluatePlan,
  evaluateSeedCandidates,
  excerptToTokens,
  factsRetained,
  planWithBoundaryExcerpt,
  representativeSeedFixtures,
  scriptClass,
} from "../scripts/report-continuation-seed-core.mjs";
import {
  CONTINUATION_SEED_TOKEN_BUDGET,
  planContinuationSeed,
} from "../lib/externalContinuationSeedCore.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

/**
 * CONT-01 measurement core. The report is evidence for a policy decision, so
 * what is pinned here is that it measures the shipped rule faithfully, that the
 * candidates differ only where they claim to, and that nothing it aggregates
 * can carry conversation content or identifiers.
 */

const message = (role, ordinal, content) => ({ role, ordinal, content, truncated: false });

test("the shipped rule is reproduced, not reimplemented", () => {
  const current = SEED_CANDIDATES.find((candidate) => candidate.id === "current");
  for (const fixture of representativeSeedFixtures()) {
    assert.deepEqual(
      current.plan(fixture.messages, fixture.messages.length),
      planContinuationSeed({ messages: fixture.messages, sourceMessageCount: fixture.messages.length }),
      fixture.id
    );
  }
});

test("the known Korean boundary: 2,000 Hangul syllables fit, 2,001 empty the shipped seed", () => {
  const fits = [message("assistant", 0, "가".repeat(2_000))];
  const over = [message("assistant", 0, "가".repeat(2_001))];
  assert.equal(evaluatePlan(planContinuationSeed({ messages: fits }), fits).empty, false);
  const emptied = evaluatePlan(planContinuationSeed({ messages: over }), over);
  assert.equal(emptied.empty, true);
  assert.equal(emptied.newest, "missing");
  // C carries a cut of it instead.
  const cut = planWithBoundaryExcerpt({ messages: over, keep: "tail" });
  assert.equal(cut.turns.length, 1);
  assert.equal(cut.turns[0].shortened, true);
  assert.ok(cut.estimatedTokens <= CONTINUATION_SEED_TOKEN_BUDGET);
});

test("C differs from the shipped rule only at the first turn that does not fit", () => {
  for (const fixture of representativeSeedFixtures()) {
    const shipped = planContinuationSeed({ messages: fixture.messages });
    for (const keep of ["head", "tail"]) {
      const candidate = planWithBoundaryExcerpt({ messages: fixture.messages, keep });
      const whole = candidate.excerpted ? candidate.turns.slice(1) : candidate.turns;
      assert.deepEqual(
        whole.map((turn) => [turn.ordinal, turn.text]),
        shipped.turns.map((turn) => [turn.ordinal, turn.text]),
        `${fixture.id} ${keep}`
      );
      assert.ok(candidate.estimatedTokens <= CONTINUATION_SEED_TOKEN_BUDGET);
    }
  }
});

test("an excerpt fits its budget and keeps the side it names", () => {
  const text = `시작 문장입니다. ${"중간 내용이 이어집니다. ".repeat(400)}마지막 문장입니다.`;
  const head = excerptToTokens(text, 500, "head");
  const tail = excerptToTokens(text, 500, "tail");
  assert.ok(estimateTextTokens(head) <= 500 && estimateTextTokens(tail) <= 500);
  assert.ok(head.startsWith("시작 문장입니다."));
  assert.ok(tail.endsWith("마지막 문장입니다."));
  // Code points, never half a surrogate pair.
  const emoji = "😀".repeat(3_000);
  assert.ok(excerptToTokens(emoji, 300, "head").isWellFormed());
  // A text that already fits comes back unchanged.
  assert.equal(excerptToTokens("짧은 문장", 500, "head"), "짧은 문장");
});

test("C does not add a cut smaller than the minimum useful excerpt", () => {
  const nearlyFull = "가".repeat(1_950); // leaves under MIN_EXCERPT_TOKENS of the budget
  const messages = [message("user", 0, "나".repeat(500)), message("assistant", 1, nearlyFull)];
  const plan = planWithBoundaryExcerpt({ messages, keep: "tail" });
  const remaining = CONTINUATION_SEED_TOKEN_BUDGET - estimateTextTokens(nearlyFull);
  assert.ok(remaining < MIN_EXCERPT_TOKENS);
  assert.equal(plan.excerpted, false);
  assert.deepEqual(plan.turns.map((turn) => turn.ordinal), [1]);
});

test("script classes follow the characters, not a locale", () => {
  assert.equal(scriptClass("안녕하세요 오늘 회의 일정을 정리해 주세요 부탁드립니다"), "hangul");
  assert.equal(scriptClass("Please summarise the meeting schedule for today"), "latin");
  assert.equal(scriptClass("API 설계 review 일정 schedule 정리 please 부탁"), "mixed");
  assert.equal(scriptClass("123 !! ✅"), "other");
});

test("blank turns are reported apart from budget stops", () => {
  const messages = [message("user", 0, "   "), message("assistant", 1, "짧은 답변입니다")];
  const result = evaluatePlan(planContinuationSeed({ messages }), messages);
  assert.equal(result.blankSkipped, 1);
  assert.equal(result.omittedByBudget, 0);
});

test("fixture facts are really in their conversations", () => {
  for (const fixture of representativeSeedFixtures()) {
    const text = fixture.messages.map((m) => m.content).join("\n");
    for (const fact of fixture.facts) {
      assert.ok(text.includes(fact.text), `${fixture.id}:${fact.id}`);
    }
    // And the retention check can say no.
    const empty = { turns: [] };
    assert.ok(factsRetained(empty, fixture.facts).every((fact) => fact.retained === false));
  }
});

test("aggregation carries no content or identifiers and suppresses small groups", () => {
  const secret = "SECRET-TITLE-아무도-보면-안-됨";
  const samples = Array.from({ length: 6 }, (_, i) => ({
    ...evaluateSeedCandidates(
      [message("user", 0, `${secret} 질문 ${i}`), message("assistant", 1, "가".repeat(2_100))],
      2
    ),
    weight: 2,
  }));
  samples.push({
    ...evaluateSeedCandidates([message("user", 0, `${secret} english question here please`)], 1),
    weight: 1,
  });
  const report = aggregateSeedSamples(samples);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /SECRET|아무도|질문|english question/);
  assert.equal(report.hangul.snapshots, 6);
  assert.equal(report.hangul.continuations, 12);
  assert.equal(report.hangul.byCandidate.current.emptySeed, 6);
  assert.equal(report.hangul.byCandidate["C-tail"].emptySeed, 0);
  assert.equal(report.latin.suppressed, true);
  assert.equal(report.latin.snapshots, undefined);
  // The per-sample evaluation is itself content-free.
  assert.doesNotMatch(JSON.stringify(samples), /SECRET|아무도/);
});

test("the database mode reads only what the loader reads and prints no identifiers", () => {
  const runner = readFileSync("scripts/report-continuation-seed.mjs", "utf8");
  assert.match(runner, /process\.argv\.includes\("--database"\)/);
  assert.match(runner, /take: SEED_SOURCE_MESSAGE_SCAN_LIMIT/);
  assert.match(runner, /orderBy: \{ ordinal: "desc" \}/);
  // Locked sources are counted, not read.
  const lockedBranch = runner.indexOf("snapshot.password !== null");
  const messageRead = runner.indexOf("prisma.externalMessage.findMany");
  assert.ok(lockedBranch > 0 && lockedBranch < messageRead);
  // No write of any kind.
  assert.doesNotMatch(runner, /\.(create|update|upsert|delete)(Many)?\(|\$executeRaw/);
  // The sample pushed out of the loop is the evaluation plus a weight, nothing else.
  assert.match(runner, /samples\.push\(\{ \.\.\.evaluated, weight: snapshot\._count\.continuationBridges \}\)/);
  assert.match(
    readFileSync("package.json", "utf8"),
    /"report:continuation-seed": "node --import tsx scripts\/report-continuation-seed\.mjs"/
  );
});
