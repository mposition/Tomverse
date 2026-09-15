import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PUBLISHED_COUNT_ROUNDING,
  SEED_CANDIDATES,
  aggregateSeedSamples,
  databaseErrorNote,
  evaluatePlan,
  evaluateSeedCandidates,
  excerptToTokens,
  factsRetained,
  measureStoredConversations,
  planWithBoundaryExcerpt,
  representativeSeedFixtures,
  roundedCount,
  scriptClass,
} from "../scripts/report-continuation-seed-core.mjs";
import {
  CONTINUATION_SEED_TOKEN_BUDGET,
  planContinuationSeed,
} from "../lib/externalContinuationSeedCore.ts";
import { buildContinuationSeedPrompt } from "../lib/externalContinuationSeedPrompt.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

/**
 * CONT-01 measurement core. The report is evidence for a policy decision and is
 * run against production data, so what is pinned here is that it measures the
 * shipped rule faithfully, that the candidates differ only where they claim to,
 * and that nothing it returns or prints can carry conversation content,
 * identifiers, or a recoverable small-group size.
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

test("C cuts into any remaining budget, with no assumed minimum", () => {
  // The newest turn leaves only a sliver; C still carries what fits of the one
  // before, where a short decision sits at its end.
  const decision = "결정: 유지";
  const newest = "가".repeat(1_970);
  const earlier = `${"나".repeat(600)} ${decision}`;
  const messages = [message("assistant", 0, earlier), message("user", 1, newest)];
  const remaining = CONTINUATION_SEED_TOKEN_BUDGET - estimateTextTokens(newest);
  assert.ok(remaining > 0 && remaining < 150);
  const plan = planWithBoundaryExcerpt({ messages, keep: "tail" });
  assert.equal(plan.excerpted, true);
  assert.ok(plan.turns[0].text.endsWith(decision));
});

test("an excerpt fits its budget and keeps the side it names", () => {
  const text = `시작 문장입니다. ${"중간 내용이 이어집니다. ".repeat(400)}마지막 문장입니다.`;
  const head = excerptToTokens(text, 500, "head");
  const tail = excerptToTokens(text, 500, "tail");
  assert.ok(estimateTextTokens(head) <= 500 && estimateTextTokens(tail) <= 500);
  assert.ok(head.startsWith("시작 문장입니다."));
  assert.ok(tail.endsWith("마지막 문장입니다."));
  const emoji = "😀".repeat(3_000);
  assert.ok(excerptToTokens(emoji, 300, "head").isWellFormed());
  assert.equal(excerptToTokens("짧은 문장", 500, "head"), "짧은 문장");
});

test("script classes follow the characters, not a locale", () => {
  assert.equal(scriptClass("안녕하세요 오늘 회의 일정을 정리해 주세요 부탁드립니다"), "hangul");
  assert.equal(scriptClass("Please summarise the meeting schedule for today"), "latin");
  assert.equal(scriptClass("API 설계 review 일정 schedule 정리 please 부탁"), "mixed");
  assert.equal(scriptClass("123 !! ✅"), "other");
});

test("blank turns are reported apart from budget stops, judged on the pre-cut text", () => {
  const messages = [message("user", 0, "   "), message("assistant", 1, "짧은 답변입니다")];
  const result = evaluatePlan(planContinuationSeed({ messages }), messages);
  assert.equal(result.blankSkipped, 1);
  assert.equal(result.omittedByBudget, 0);

  // Whitespace for the whole pre-cut window: the planner skips it as blank.
  const padded = [message("assistant", 0, `${" ".repeat(4_000)}visible answer`)];
  const judged = evaluatePlan(planContinuationSeed({ messages: padded }), padded);
  assert.equal(judged.eligibleNonBlank, 0);
  assert.equal(judged.newest, "none_eligible");
  assert.equal(judged.omittedByBudget, 0);
  assert.equal(judged.blankSkipped, 1);
});

test("rendered tokens price the seed with the snapshot's own provider and import time", () => {
  const messages = [message("user", 0, "질문입니다"), message("assistant", 1, "답변입니다")];
  const plan = planContinuationSeed({ messages });
  const context = { provider: "claude", importedAt: "2026-08-01T00:00:00.000Z" };
  const prompt = buildContinuationSeedPrompt({ ...context, plan });
  const expected = estimateTextTokens(prompt.rulesText) + estimateTextTokens(prompt.transcriptText);
  assert.equal(evaluatePlan(plan, messages, context).renderedTokens, expected);
  assert.notEqual(evaluatePlan(plan, messages).renderedTokens, expected);
});

test("fixture facts are really in their conversations", () => {
  for (const fixture of representativeSeedFixtures()) {
    const text = fixture.messages.map((m) => m.content).join("\n");
    for (const fact of fixture.facts) {
      assert.ok(text.includes(fact.text), `${fixture.id}:${fact.id}`);
    }
    assert.ok(factsRetained({ turns: [] }, fixture.facts).every((fact) => fact.retained === false));
  }
});

/* -------------------------------------------------------------- aggregation */

const secret = "SECRET-TITLE-아무도-보면-안-됨";
const sample = (content, requests, script) => ({
  ...evaluateSeedCandidates(content, content.length),
  ...(script ? { script } : {}),
  requests,
});

test("shares are weighted per snapshot and per request, and one heavy source is not hidden", () => {
  const empty = [message("user", 0, `${secret} 질문`), message("assistant", 1, "가".repeat(2_100))];
  const fine = [message("user", 0, "질문입니다 오늘 회의 정리 부탁드립니다"), message("assistant", 1, "짧은 답변입니다 정리했습니다")];
  const samples = [sample(empty, 100), ...Array.from({ length: 4 }, () => sample(fine, 1))];
  const report = aggregateSeedSamples(samples);
  assert.equal(report.hangul.byCandidate.current.emptySeed.snapshotPercent, 20);
  assert.equal(report.hangul.byCandidate.current.emptySeed.requestPercent, 96);
  assert.equal(report.hangul.byCandidate["C-tail"].emptySeed.requestPercent, 0);
  assert.equal(typeof report.hangul.byCandidate.B6000.renderedTokensPerRequest, "number");
});

test("aggregation carries no content or identifiers, and a suppressed group cannot be subtracted out", () => {
  const korean = [message("user", 0, `${secret} 질문`), message("assistant", 1, "가".repeat(2_100))];
  const english = [message("user", 0, `${secret} english question here please`)];
  const samples = [
    ...Array.from({ length: 6 }, () => sample(korean, 2)),
    ...Array.from({ length: 2 }, () => sample(english, 1)),
  ];
  const report = aggregateSeedSamples(samples);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|아무도|질문|english question/);
  assert.equal(report.latin.suppressed, true);
  assert.equal(report.latin.snapshotsRounded, undefined);
  // Published counts are rounded, never an exact 6 next to an exact total of 8.
  assert.equal(report.hangul.snapshotsRounded % PUBLISHED_COUNT_ROUNDING, 0);
  assert.equal(roundedCount(6), 5);
  assert.equal(roundedCount(8), 10);
  assert.doesNotMatch(JSON.stringify(report), /"snapshots":|"continuations":/);
});

/* ------------------------------------------------------------ stored data */

const fakeDatabase = ({ snapshots, messages, weights, deleted = 0 }) => {
  const calls = { pages: 0, messageIds: [], weightIds: [] };
  return {
    calls,
    client: {
      fetchSnapshotPage: async (cursor, take) => {
        calls.pages += 1;
        const start = cursor ? snapshots.findIndex((s) => s.id === cursor) + 1 : 0;
        return snapshots.slice(start, start + take);
      },
      fetchNewestMessages: async (ids) => {
        calls.messageIds.push(...ids);
        return new Map(ids.map((id) => [id, messages[id] ?? []]));
      },
      fetchRequestWeights: async (ids) => {
        calls.weightIds.push(...ids);
        return new Map(ids.map((id) => [id, weights[id] ?? 0]));
      },
      countDeletedSourceContinuations: async () => deleted,
    },
  };
};

const storedFixture = () => {
  const snapshots = Array.from({ length: 12 }, (_, i) => ({
    id: `snapshot-secret-id-${i}`,
    provider: "chatgpt",
    importedAt: new Date("2026-08-01T00:00:00.000Z"),
    messageCount: 2,
    locked: i >= 10,
  }));
  const messages = Object.fromEntries(
    snapshots.map((s, i) => [
      s.id,
      [message("user", 0, `${secret} 질문 ${i}`), message("assistant", 1, "가".repeat(i % 2 === 0 ? 2_100 : 100))],
    ])
  );
  const weights = Object.fromEntries(snapshots.map((s) => [s.id, 3]));
  return { snapshots, messages, weights, deleted: 4 };
};

test("the stored measurement pages through, skips locked sources by default, and returns nothing identifying", async () => {
  const fixture = storedFixture();
  const { client, calls } = fakeDatabase(fixture);
  const result = await measureStoredConversations(client, { pageSize: 5 });
  assert.equal(calls.pages, 3, "12 snapshots in pages of 5: 5, 5, 2");
  assert.ok(calls.messageIds.every((id) => !id.endsWith("-10") && !id.endsWith("-11")), "locked sources are not read");
  assert.equal(result.scopeRounded.lockedNotRead, roundedCount(2));
  assert.equal(result.scopeRounded.measured, roundedCount(10));
  assert.equal(result.scopeRounded.continuationsOfDeletedSources, roundedCount(4));
  assert.equal(result.stoppedAtLimit, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /snapshot-secret-id|SECRET|아무도|질문/);
});

test("locked sources are measured only when asked, and a limit stops the scan", async () => {
  const fixture = storedFixture();
  const withLocked = fakeDatabase(fixture);
  const included = await measureStoredConversations(withLocked.client, { pageSize: 5, includeLocked: true });
  assert.ok(withLocked.calls.messageIds.includes("snapshot-secret-id-11"));
  assert.equal(included.scopeRounded.lockedNotRead, 0);

  const limited = fakeDatabase(fixture);
  const partial = await measureStoredConversations(limited.client, { pageSize: 5, maxSnapshots: 7 });
  assert.equal(partial.stoppedAtLimit, true);
  assert.equal(limited.calls.messageIds.length, 7);
});

test("a database error is reported as a fixed sentence and a Prisma code, never its message", () => {
  const error = Object.assign(new Error("Can't reach database server at prod-db.internal:5432 SELECT content"), {
    code: "P1001",
  });
  const note = databaseErrorNote(error);
  assert.equal(note, "The database could not be read (P1001); nothing was measured.");
  assert.equal(databaseErrorNote(new Error("postgres://user:pass@host/db")), "The database could not be read; nothing was measured.");
});

test("the runner is read-only, silences Prisma logging before loading it, and prints no error message", () => {
  const runner = readFileSync("scripts/report-continuation-seed.mjs", "utf8");
  assert.match(runner, /argv\.includes\("--database"\)/);
  const silence = runner.indexOf('process.env.PRISMA_CLIENT_LOG = ""');
  const load = runner.indexOf('await import("../lib/prisma.ts")');
  assert.ok(silence > 0 && silence < load, "logging is off before the client is created");
  assert.doesNotMatch(runner, /\.(create|update|upsert|delete)(Many)?\(|\$executeRaw/);
  assert.match(runner, /note: databaseErrorNote\(error\)/);
  assert.doesNotMatch(runner, /error\?\.message|error\.message|String\(error/);
  // Newest 200 per snapshot, as the loader scans.
  assert.match(runner, /ORDER BY "ordinal" DESC/);
  assert.match(runner, /WHERE "rank" <= \$\{SEED_SOURCE_MESSAGE_SCAN_LIMIT\}/);
  assert.match(
    readFileSync("package.json", "utf8"),
    /"report:continuation-seed": "node --import tsx scripts\/report-continuation-seed\.mjs"/
  );
});
