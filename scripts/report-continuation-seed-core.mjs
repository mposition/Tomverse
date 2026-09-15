// CONT-01: how much of an imported conversation each seed policy would carry.
//
// Measurement only. Nothing here is imported by the product: the seed the app
// actually sends is still built by `planContinuationSeed()` in
// lib/externalContinuationSeedCore.ts, unchanged. This module reproduces that
// rule ("current") next to the candidates a policy decision has to choose
// between (docs/policy/external-conversation-continuation.md §4.1), so the
// choice is made on numbers rather than on the synthetic boundary cases alone:
//
//   current   the shipped rule: newest whole turns under 3,000 estimated tokens,
//             stopping at the first turn that does not fit
//   B6000     the same rule with a 6,000 budget
//   B8000     the same rule with an 8,000 budget
//   C-head    the shipped budget, but the first turn that does not fit is cut to
//             the remaining budget from its beginning, marked shortened, and
//             selection stops there
//   C-tail    as C-head, keeping the end of that turn instead
//
// None of B or C is approved. B raises the cost of every continued turn on every
// model; C changes what "a turn" means in the seed and needs a disclosure rule.
// This report exists to inform that decision, not to make it.
//
// Privacy: every function that returns something a report prints returns counts
// and distribution figures only. No message text, title, ordinal, snapshot id
// or user id leaves `evaluateSeedCandidates()`; `aggregateSeedSamples()`
// suppresses any group smaller than `minGroupSize`.

import {
  CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT,
  CONTINUATION_SEED_TOKEN_BUDGET,
  isContinuationSeedRole,
  planContinuationSeed,
} from "../lib/externalContinuationSeedCore.ts";
import { buildContinuationSeedPrompt } from "../lib/externalContinuationSeedPrompt.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

/** The newest-message scan the real loader uses (lib/externalContinuationService.ts). */
export const SEED_SOURCE_MESSAGE_SCAN_LIMIT = 200;

/**
 * The smallest number of snapshots a published figure may rest on. A group
 * smaller than this is suppressed; a share whose matching (or non-matching)
 * snapshots number between 1 and this minus one is published as a band, not a
 * percent.
 */
export const MIN_PUBLISHED_CELL = 5;

/**
 * Upper bounds of the count bands a report publishes instead of counts. Bands
 * are wide enough that subtracting one published figure from another yields a
 * range, never a suppressed group's size or a small exact count.
 */
const COUNT_BAND_EDGES = [1, 5, 10, 50, 100, 500, 1_000, 5_000];

/**
 * What the assistant-turn weight is and is not. It is printed with every
 * database result, because the figure is only as good as this proxy.
 */
export const ASSISTANT_TURN_WEIGHT_NOTE =
  "Assistant-turn weight is a proxy for seeded requests, not a count of them. It counts every " +
  "assistant message saved in a continued conversation: turns that carried no seed (seeding off, " +
  "source locked at the time, deep research) are included, a multi-model turn counts once per model, " +
  "requests that failed before a message was saved are missing, and no time window or seed-version " +
  "filter is applied.";

/** The text the planner actually judges and prices: the pre-cut to the message cap. */
const preCut = (content) => {
  const points = [...content];
  return points.length > CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT
    ? { text: points.slice(0, CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT).join(""), cut: true }
    : { text: content, cut: false };
};

// ---------------------------------------------------------------- script class

const HANGUL = /[가-힣]/gu;
const LATIN = /[A-Za-z]/g;

/**
 * Which script dominates a conversation's text. By character counts, never by
 * locale or provider: a Korean user can import an English conversation.
 *
 *   hangul  at least 80% of letters are Hangul syllables
 *   latin   at least 80% are ASCII letters
 *   mixed   both present, neither reaching 80%
 *   other   fewer than 20 such letters in total (too little to say)
 */
export function scriptClass(text) {
  const hangul = text.match(HANGUL)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  const letters = hangul + latin;
  if (letters < 20) return "other";
  if (hangul / letters >= 0.8) return "hangul";
  if (latin / letters >= 0.8) return "latin";
  return "mixed";
}

// ---------------------------------------------------------------- candidates

const codePoints = (text) => [...text];

/**
 * The longest head or tail of `text` whose estimate fits `maxTokens`, by binary
 * search over code points with the same estimator the planner prices with.
 */
export function excerptToTokens(text, maxTokens, keep) {
  const points = codePoints(text);
  if (estimateTextTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate =
      keep === "head" ? points.slice(0, mid).join("") : points.slice(points.length - mid).join("");
    if (estimateTextTokens(candidate) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return keep === "head"
    ? points.slice(0, low).join("")
    : points.slice(points.length - low).join("");
}

/**
 * Candidate C: the shipped window rule, except that the first turn that does
 * not fit is cut to whatever budget remains -- any positive amount -- instead of
 * ending selection there. Mirrors `planContinuationSeed()` step for step so any
 * difference in the report is the cut and nothing else. No minimum cut size is
 * assumed: choosing one would be part of the policy decision this informs.
 */
export function planWithBoundaryExcerpt({
  messages,
  sourceMessageCount,
  keep,
  tokenBudget = CONTINUATION_SEED_TOKEN_BUDGET,
}) {
  const ordered = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const eligible = ordered.filter((message) => isContinuationSeedRole(message.role));
  const selected = [];
  let spent = 0;
  let excerpted = false;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const message = eligible[index];
    const { text, cut: wasPreCut } = preCut(message.content);
    if (text.trim().length === 0) continue;
    const cost = estimateTextTokens(text);
    if (spent + cost <= tokenBudget) {
      spent += cost;
      selected.push({
        role: message.role,
        ordinal: message.ordinal,
        text,
        shortened: wasPreCut || message.truncated,
      });
      continue;
    }
    const remaining = tokenBudget - spent;
    if (remaining > 0) {
      const cut = excerptToTokens(text, remaining, keep);
      if (cut.trim().length > 0) {
        spent += estimateTextTokens(cut);
        selected.push({ role: message.role, ordinal: message.ordinal, text: cut, shortened: true });
        excerpted = true;
      }
    }
    break;
  }
  selected.reverse();
  return {
    seedVersion: `measurement-C-${keep}`,
    turns: selected,
    fromOrdinal: selected[0]?.ordinal ?? 0,
    toOrdinal: selected.at(-1)?.ordinal ?? 0,
    sourceMessageCount: sourceMessageCount ?? ordered.length,
    truncatedCount: selected.filter((turn) => turn.shortened).length,
    omittedByBudgetCount: eligible.length - selected.length,
    excludedByRoleCount: ordered.length - eligible.length,
    estimatedTokens: spent,
    excerpted,
  };
}

export const SEED_CANDIDATES = [
  {
    id: "current",
    plan: (messages, sourceMessageCount) => planContinuationSeed({ messages, sourceMessageCount }),
  },
  {
    id: "B6000",
    plan: (messages, sourceMessageCount) =>
      planContinuationSeed({ messages, sourceMessageCount, tokenBudget: 6_000 }),
  },
  {
    id: "B8000",
    plan: (messages, sourceMessageCount) =>
      planContinuationSeed({ messages, sourceMessageCount, tokenBudget: 8_000 }),
  },
  {
    id: "C-head",
    plan: (messages, sourceMessageCount) =>
      planWithBoundaryExcerpt({ messages, sourceMessageCount, keep: "head" }),
  },
  {
    id: "C-tail",
    plan: (messages, sourceMessageCount) =>
      planWithBoundaryExcerpt({ messages, sourceMessageCount, keep: "tail" }),
  },
];

// ---------------------------------------------------------------- evaluation

/**
 * The content-free measurements of one plan.
 *
 * `newest` is about the newest eligible non-blank message, the one the user
 * most likely wants continued: carried whole, carried shortened, or not at all.
 * `renderedTokens` prices the whole seed input the model receives -- rules,
 * header and fence included -- rendered with the snapshot's own provider and
 * import time, as the loader renders it, because that and not the body budget
 * is what each turn costs.
 *
 * "Blank" is judged on the pre-cut text, as the planner judges it: a message
 * whose first 4,000 code points are whitespace is skipped by the rule, not
 * left out by the budget.
 */
export function evaluatePlan(plan, messages, { provider = "chatgpt", importedAt = null } = {}) {
  const isBlank = (message) => preCut(message.content).text.trim().length === 0;
  const eligible = messages.filter((message) => isContinuationSeedRole(message.role));
  const eligibleNonBlank = eligible
    .filter((message) => !isBlank(message))
    .sort((a, b) => a.ordinal - b.ordinal);
  const newest = eligibleNonBlank.at(-1);
  const newestTurn = newest ? plan.turns.find((turn) => turn.ordinal === newest.ordinal) : undefined;
  const prompt = buildContinuationSeedPrompt({ provider, importedAt, plan });
  const renderedTokens =
    (prompt.rulesText ? estimateTextTokens(prompt.rulesText) : 0) +
    (prompt.transcriptText ? estimateTextTokens(prompt.transcriptText) : 0);
  const blankEligible = eligible.filter(isBlank).length;
  return {
    empty: plan.turns.length === 0,
    eligibleNonBlank: eligibleNonBlank.length,
    includedMessages: plan.turns.length,
    shortenedMessages: plan.truncatedCount,
    bodyTokens: plan.estimatedTokens,
    renderedTokens,
    newest: !newest ? "none_eligible" : !newestTurn ? "missing" : newestTurn.shortened ? "shortened" : "whole",
    // Budget stops only: blanks are skipped by the rule, not by the budget, so
    // the shipped `omittedByBudgetCount` (which counts them) is split here.
    omittedByBudget: Math.max(0, plan.omittedByBudgetCount - blankEligible),
    blankSkipped: blankEligible,
  };
}

/** Which planted facts survived into the seed. For fixtures with ground truth. */
export function factsRetained(plan, facts) {
  const carried = plan.turns.map((turn) => turn.text).join("\n");
  return facts.map((fact) => ({ id: fact.id, kind: fact.kind, retained: carried.includes(fact.text) }));
}

/**
 * Every candidate over one conversation's loaded messages. The returned object
 * holds no text and no identifiers.
 *
 * The script class is decided on the same newest-200 scan the seed is built
 * from, which is what the seed can carry; an older part of a long conversation
 * in another language does not change what reaches the model.
 */
export function evaluateSeedCandidates(messages, sourceMessageCount, context = {}) {
  const eligibleText = messages
    .filter((message) => isContinuationSeedRole(message.role))
    .map((message) => message.content)
    .join("\n");
  const results = {};
  for (const candidate of SEED_CANDIDATES) {
    results[candidate.id] = evaluatePlan(
      candidate.plan(messages, sourceMessageCount),
      messages,
      context
    );
  }
  return { script: scriptClass(eligibleText), results };
}

// ---------------------------------------------------------------- aggregation

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
};

/** A count as a band ("0", "1-4", "5-9", ... "5000+"), never the count itself. */
export function countBand(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  for (let index = 1; index < COUNT_BAND_EDGES.length; index += 1) {
    if (value < COUNT_BAND_EDGES[index]) return `${COUNT_BAND_EDGES[index - 1]}-${COUNT_BAND_EDGES[index] - 1}`;
  }
  return `${COUNT_BAND_EDGES.at(-1)}+`;
}

const percent = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 100));

/**
 * Per script class and candidate: shares and quantiles, in two units.
 *
 *   snapshot share        each imported conversation counts once, however often
 *                         it was continued -- how common a shape of source is
 *   assistant-turn share  each sample weighted by the assistant turns its
 *                         continued conversations have had, a proxy for how many
 *                         model requests carried this seed; see
 *                         ASSISTANT_TURN_WEIGHT_NOTE for what the proxy gets wrong
 *
 * Disclosure: groups smaller than `minGroupSize` snapshots are suppressed with
 * no figures. No count is published, only a band (`countBand`), so no total
 * sits next to a group's exact size. A share resting on fewer than
 * MIN_PUBLISHED_CELL snapshots on either side -- matching or not -- is published
 * as a band with no percent, so a percent can never be solved back to 1-4
 * snapshots.
 */
export function aggregateSeedSamples(samples, { minGroupSize = MIN_PUBLISHED_CELL } = {}) {
  const groups = new Map();
  for (const sample of samples) {
    const list = groups.get(sample.script) ?? [];
    list.push(sample);
    groups.set(sample.script, list);
  }
  const report = {};
  for (const [script, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < minGroupSize) {
      report[script] = { suppressed: true, reason: `fewer than ${minGroupSize} snapshots` };
      continue;
    }
    const weightOf = (sample) => Math.max(0, sample.assistantTurns ?? 0);
    const totalTurns = list.reduce((total, sample) => total + weightOf(sample), 0);
    const byCandidate = {};
    for (const candidate of SEED_CANDIDATES) {
      const rows = list.map((sample) => ({ row: sample.results[candidate.id], weight: weightOf(sample) }));
      const shares = (predicate) => {
        const matching = rows.filter(({ row }) => predicate(row));
        const rest = rows.length - matching.length;
        if ((matching.length > 0 && matching.length < MIN_PUBLISHED_CELL) || (rest > 0 && rest < MIN_PUBLISHED_CELL)) {
          return {
            snapshotPercent: null,
            assistantTurnPercent: null,
            band: matching.length < MIN_PUBLISHED_CELL ? `fewer than ${MIN_PUBLISHED_CELL} snapshots` : `all but fewer than ${MIN_PUBLISHED_CELL} snapshots`,
          };
        }
        return {
          snapshotPercent: percent(matching.length, rows.length),
          assistantTurnPercent: percent(
            matching.reduce((total, { weight }) => total + weight, 0),
            totalTurns
          ),
        };
      };
      byCandidate[candidate.id] = {
        emptySeed: shares((row) => row.empty && row.eligibleNonBlank > 0),
        newestMissing: shares((row) => row.newest === "missing"),
        newestShortened: shares((row) => row.newest === "shortened"),
        stoppedByBudget: shares((row) => row.omittedByBudget > 0),
        includedMessagesP10: quantile(rows.map(({ row }) => row.includedMessages), 0.1),
        includedMessagesP50: quantile(rows.map(({ row }) => row.includedMessages), 0.5),
        renderedTokensP50: quantile(rows.map(({ row }) => row.renderedTokens), 0.5),
        renderedTokensP90: quantile(rows.map(({ row }) => row.renderedTokens), 0.9),
        // Assistant-turn-weighted mean of what this candidate would add per
        // turn -- the cost figure, with the proxy's biases.
        renderedTokensPerAssistantTurn:
          totalTurns === 0
            ? null
            : Math.round(
                rows.reduce((total, { row, weight }) => total + row.renderedTokens * weight, 0) /
                  totalTurns
              ),
      };
    }
    report[script] = {
      snapshotsBand: countBand(list.length),
      assistantTurnsBand: countBand(totalTurns),
      byCandidate,
    };
  }
  return report;
}

// ---------------------------------------------------------------- stored data

/**
 * The database measurement, with the database behind injected functions so it
 * can be executed in a test without one.
 *
 *   fetchSnapshotPage(cursor, take)  -> [{ id, provider, importedAt, messageCount, locked }]
 *                                       finalized snapshots with at least one continuation
 *   fetchNewestMessages(ids)         -> Map(id -> messages), newest SEED_SOURCE_MESSAGE_SCAN_LIMIT
 *   fetchAssistantTurnCounts(ids)    -> Map(id -> assistant turns across its continuations)
 *   countDeletedSourceContinuations() -> number
 *
 * Identifiers exist only inside this function, to join the three reads; none
 * is placed in the returned object. Locked snapshots are counted and skipped
 * unless `includeLocked` -- see the runner for why that is an explicit choice.
 */
export async function measureStoredConversations(
  { fetchSnapshotPage, fetchNewestMessages, fetchAssistantTurnCounts, countDeletedSourceContinuations },
  { includeLocked = false, maxSnapshots = Number.POSITIVE_INFINITY, pageSize = 50, onProgress } = {}
) {
  const samples = [];
  let lockedSkipped = 0;
  let lockedMeasured = 0;
  let noEligibleText = 0;
  let seen = 0;
  let cursor;
  while (seen < maxSnapshots) {
    const page = await fetchSnapshotPage(cursor, Math.min(pageSize, maxSnapshots - seen));
    if (page.length === 0) break;
    cursor = page.at(-1).id;
    seen += page.length;
    const readable = page.filter((snapshot) => includeLocked || !snapshot.locked);
    lockedSkipped += page.length - readable.length;
    const ids = readable.map((snapshot) => snapshot.id);
    const [messagesById, turnsById] =
      ids.length === 0 ? [new Map(), new Map()] : await Promise.all([fetchNewestMessages(ids), fetchAssistantTurnCounts(ids)]);
    for (const snapshot of readable) {
      const messages = messagesById.get(snapshot.id) ?? [];
      const evaluated = evaluateSeedCandidates(messages, snapshot.messageCount, {
        provider: snapshot.provider,
        importedAt: snapshot.importedAt,
      });
      if (evaluated.results.current.eligibleNonBlank === 0) {
        noEligibleText += 1;
        continue;
      }
      if (snapshot.locked) lockedMeasured += 1;
      samples.push({
        script: evaluated.script,
        results: evaluated.results,
        assistantTurns: turnsById.get(snapshot.id) ?? 0,
      });
    }
    onProgress?.(seen);
    if (page.length < pageSize) break;
  }
  // Reaching the limit is not stopping at it: only a row left unread is.
  const stoppedAtLimit = seen >= maxSnapshots && cursor !== undefined && (await fetchSnapshotPage(cursor, 1)).length > 0;
  return {
    scopeBands: {
      snapshotsScanned: countBand(seen),
      measured: countBand(samples.length),
      lockedNotRead: countBand(lockedSkipped),
      lockedMeasured: countBand(lockedMeasured),
      noEligibleText: countBand(noEligibleText),
      continuationsOfDeletedSources: countBand(await countDeletedSourceContinuations()),
    },
    stoppedAtLimit,
    assistantTurnWeight: ASSISTANT_TURN_WEIGHT_NOTE,
    byScript: aggregateSeedSamples(samples),
  };
}

/**
 * What a failed database read may say: a fixed sentence and, when the error
 * carries one, Prisma's error code. Never the error's message -- a connection
 * error names the host, and a query error can quote the statement.
 */
export function databaseErrorNote(error) {
  const code = typeof error?.code === "string" && /^P\d{4}$/.test(error.code) ? ` (${error.code})` : "";
  return `The database could not be read${code}; nothing was measured.`;
}

// ---------------------------------------------------------------- fixtures

/**
 * Representative, non-sensitive conversations with planted facts, so the
 * comparison is about content that matters -- a conclusion, a negation, a
 * condition, a code line, a table row -- rather than about repeated filler.
 * Deterministic: the same arrays every run.
 */
export function representativeSeedFixtures() {
  const koParagraph = (topic, index) =>
    `${topic}에 대해 ${index + 1}번째로 정리하면, 일정과 예산을 함께 보면서 우선순위를 다시 맞추는 것이 좋습니다. ` +
    `현재 담당자는 초안을 이번 주 안에 공유하기로 했고, 검토 의견은 다음 회의 전까지 모으기로 했습니다. `;
  const enParagraph = (topic, index) =>
    `On ${topic}, point ${index + 1}: we should revisit priorities together with the schedule and the budget. ` +
    `The owner agreed to share a draft this week, and review comments will be collected before the next meeting. `;
  const repeat = (make, topic, count) => Array.from({ length: count }, (_, i) => make(topic, i)).join("");
  const convo = (pairs) =>
    pairs.flatMap(([question, answer], i) => [
      { role: "user", ordinal: i * 2, content: question, truncated: false },
      { role: "assistant", ordinal: i * 2 + 1, content: answer, truncated: false },
    ]);

  const fixtures = [];

  {
    const conclusion = "결론: 3분기 출시는 보류하고 4분기 초에 베타를 연다.";
    const negation = "외부 파트너에게는 아직 일정을 알리지 않는다.";
    fixtures.push({
      id: "ko-long-final-answer",
      description: "짧은 질문 뒤 예산을 넘는 한글 답변, 결론과 부정어가 답변 끝에 있음",
      messages: convo([
        ["출시 일정 어떻게 정리할까요?", `${repeat(koParagraph, "출시 일정", 24)}${negation} ${conclusion}`],
      ]),
      facts: [
        { id: "conclusion", kind: "conclusion", text: conclusion },
        { id: "negation", kind: "negation", text: negation },
      ],
    });
  }
  {
    const decision = "최종 결정: 결제 모듈은 기존 공급사를 유지한다.";
    const condition = "단, 수수료가 3%를 넘으면 재입찰한다.";
    const pairs = Array.from({ length: 10 }, (_, i) => [
      `${i + 1}번째 질문: 결제 모듈 검토 항목을 더 알려 주세요.`,
      i === 8
        ? `${repeat(koParagraph, "결제 모듈", 5)}${condition}`
        : i === 9
          ? `${repeat(koParagraph, "결제 모듈", 5)}${decision}`
          : repeat(koParagraph, "결제 모듈", 5),
    ]);
    fixtures.push({
      id: "ko-10-exchanges",
      description: "한글 질문·답변 10교환, 마지막 답변에 결정, 그 직전 답변에 조건",
      messages: convo(pairs),
      facts: [
        { id: "decision", kind: "conclusion", text: decision },
        { id: "condition", kind: "condition", text: condition },
      ],
    });
  }
  {
    const decision = "Final decision: keep the current payment provider.";
    const condition = "However, re-tender if fees exceed 3%.";
    const pairs = Array.from({ length: 10 }, (_, i) => [
      `Question ${i + 1}: what else should we review in the payment module?`,
      i === 8
        ? `${repeat(enParagraph, "the payment module", 4)}${condition}`
        : i === 9
          ? `${repeat(enParagraph, "the payment module", 4)}${decision}`
          : repeat(enParagraph, "the payment module", 4),
    ]);
    fixtures.push({
      id: "en-10-exchanges",
      description: "English 10 exchanges, decision in the last answer, condition in the one before",
      messages: convo(pairs),
      facts: [
        { id: "decision", kind: "conclusion", text: decision },
        { id: "condition", kind: "condition", text: condition },
      ],
    });
  }
  {
    const codeLine = "const retryLimit = 3; // 재시도는 세 번까지";
    const tableRow = "| 인증 | 토큰 만료 30분 | 필수 |";
    const answer =
      `${repeat(koParagraph, "API 설계", 16)}\n\n` +
      "```ts\n" +
      "export async function fetchOrders(client: ApiClient) {\n" +
      `  ${codeLine}\n` +
      "  return client.get('/orders');\n" +
      "}\n```\n\n" +
      "| 항목 | 기준 | 비고 |\n| --- | --- | --- |\n" +
      `${tableRow}\n` +
      `${repeat(koParagraph, "API 설계", 14)}`;
    fixtures.push({
      id: "mixed-code-table",
      description: "예산을 넘는 한글 답변 중간에 TypeScript 코드와 표가 있음",
      messages: convo([["주문 API 재시도랑 인증 기준 정리해 줘", answer]]),
      facts: [
        { id: "code", kind: "code", text: codeLine },
        { id: "table", kind: "table", text: tableRow },
      ],
    });
  }
  {
    const fact = "마감은 10월 7일로 확정했습니다.";
    const followUp = "그럼 마감 전에 해야 할 일만 다시 짧게 알려 주세요.";
    fixtures.push({
      id: "ko-short-followup",
      description: "한글 긴 답변(사실 포함) 뒤 짧은 후속 질문",
      messages: [
        { role: "user", ordinal: 0, content: "프로젝트 일정 전체를 알려 주세요.", truncated: false },
        { role: "assistant", ordinal: 1, content: `${fact} ${repeat(koParagraph, "프로젝트 일정", 22)}`, truncated: false },
        { role: "user", ordinal: 2, content: followUp, truncated: false },
      ],
      facts: [
        { id: "followup", kind: "question", text: followUp },
        { id: "deadline", kind: "fact", text: fact },
      ],
    });
  }
  {
    const opening = "Summary first: the migration is safe to run on Sunday night.";
    fixtures.push({
      id: "en-long-single",
      description: "One English answer longer than the 4,000-character message cap, conclusion first",
      messages: convo([["Is the database migration safe to run?", `${opening} ${repeat(enParagraph, "the migration", 20)}`]]),
      facts: [{ id: "opening", kind: "conclusion", text: opening }],
    });
  }
  {
    const negation = "이번 달에는 새 기능을 배포하지 않습니다 🚫";
    const pairs = Array.from({ length: 6 }, (_, i) => [
      `할 일 ${i + 1} 정리 부탁해요 ✅`,
      i === 5
        ? `- 점검 ✅\n- 문서 📄\n${repeat(koParagraph, "운영 점검", 9)}${negation}`
        : `- 점검 ✅\n- 문서 📄\n${repeat(koParagraph, "운영 점검", 9)}`,
    ]);
    fixtures.push({
      id: "ko-emoji-list",
      description: "이모지와 목록이 섞인 한글 6교환, 마지막 답변 끝에 부정어",
      messages: convo(pairs),
      facts: [{ id: "negation", kind: "negation", text: negation }],
    });
  }
  {
    const condition = "단, 고객 데이터가 포함된 경우에는 외부 LLM에 보내지 않는다.";
    const answer =
      `We reviewed the vendor options. ${repeat(enParagraph, "vendor selection", 10)}` +
      `정리하면 ${repeat(koParagraph, "벤더 선정", 14)}${condition}`;
    fixtures.push({
      id: "mixed-condition-end",
      description: "영어·한국어 혼용 답변, 끝부분에 조건",
      messages: convo([["Which vendor should we pick? 조건도 알려 주세요.", answer]]),
      facts: [{ id: "condition", kind: "condition", text: condition }],
    });
  }
  return fixtures;
}
