import assert from "node:assert/strict";
import test from "node:test";

import {
  AWAITING_DIGEST_THRESHOLD,
  REPORT_SECTION_LIMIT,
  buildDailyLifecycleReport,
  dailyReportSubject,
} from "../lib/modelLifecycleDailyReportCore.ts";
import { buildModelLifecycleDailyEmail } from "../lib/modelLifecycleDailyEmail.ts";

// The operator's daily model lifecycle mail. What must hold:
//
//  - a number in the subject means there is something to do, so a quiet day
//    says "healthy" rather than "0 awaiting review";
//  - a quiet day is short: the detail sections are not rendered at all;
//  - a truncated list says how many it hid, how many there are, and where to
//    see them (ML-04) -- the old report said "…and 3 more" and there was
//    nowhere to go;
//  - past the digest threshold the individual rows go and the counts stay,
//    because a 200-line email is not read;
//  - HTML and plain text render from the same structure, so a section cannot
//    exist in one and not the other;
//  - the HTML stays inside what Outlook's Word renderer supports.

const WORK_QUEUE = "https://tomverse.app/admin/models?tab=discovery";

const item = (overrides = {}) => ({
  id: "wi_1",
  provider: "OpenAI",
  publisher: "OpenAI",
  observedVia: [
    { provider: "openai", displayName: "OpenAI", apiModel: "gpt-5-7-preview" },
  ],
  apiModel: "gpt-5-7-preview",
  action: "add",
  status: "discovered",
  severity: "normal",
  ownerEmail: null,
  dueAt: null,
  firstSeenAt: "2026-08-22T00:00:00.000Z",
  ageDays: 0,
  newToday: true,
  blockers: [],
  pendingValidations: [],
  recommendation: null,
  ...overrides,
});

const input = (overrides = {}) => ({
  localDate: "22 Aug 2026",
  generatedLabel: "22 Aug 2026, 10:00 am AEST",
  workQueueUrl: WORK_QUEUE,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      status: "checked",
      errorCode: null,
      modelCount: 48,
      lastSuccessLabel: "22 Aug 2026",
      note: null,
    },
  ],
  workItems: [],
  lifecycleWarnings: [],
  missing: [],
  registry: { ran: true, disabled: [], restored: [], held: [] },
  ...overrides,
});

test("a quiet day says healthy and carries no count", () => {
  assert.equal(
    dailyReportSubject({
      localDate: "22 Aug 2026",
      actionCount: 0,
      providersFailed: 0,
      awaitingReview: 0,
    }),
    "[Tomverse] Model lifecycle · 22 Aug 2026 · healthy"
  );
});

test("the subject names the work, in order of what it costs to ignore", () => {
  assert.equal(
    dailyReportSubject({
      localDate: "22 Aug 2026",
      actionCount: 0,
      providersFailed: 0,
      awaitingReview: 4,
    }),
    "[Tomverse] Model lifecycle · 22 Aug 2026 · 4 awaiting review"
  );
  assert.equal(
    dailyReportSubject({
      localDate: "22 Aug 2026",
      actionCount: 2,
      providersFailed: 0,
      awaitingReview: 6,
    }),
    "[Tomverse] Model lifecycle · 22 Aug 2026 · ACTION 2 · 6 awaiting review"
  );
  assert.equal(
    dailyReportSubject({
      localDate: "22 Aug 2026",
      actionCount: 1,
      providersFailed: 3,
      awaitingReview: 0,
    }),
    "[Tomverse] Model lifecycle · 22 Aug 2026 · ACTION 1 · 3 providers failed"
  );
});

test("a single failed provider is singular", () => {
  assert.match(
    dailyReportSubject({
      localDate: "22 Aug 2026",
      actionCount: 0,
      providersFailed: 1,
      awaitingReview: 0,
    }),
    /1 provider failed$/
  );
});

test("the test prefix survives in front of the fixed filter prefix", () => {
  assert.ok(
    dailyReportSubject({
      localDate: "22 Aug 2026",
      actionCount: 0,
      providersFailed: 0,
      awaitingReview: 0,
      test: true,
    }).startsWith("[TEST] [Tomverse] Model lifecycle")
  );
});

test("severity, not volume, decides what is shouted about", () => {
  const report = buildDailyLifecycleReport(
    input({
      workItems: [
        item({ id: "a", severity: "critical", action: "retire" }),
        item({ id: "b", severity: "high" }),
        item({ id: "c", severity: "normal" }),
      ],
    })
  );
  assert.equal(report.actionCount, 2);
  assert.deepEqual(
    report.actionRequired.rows.map((row) => row.id),
    ["a", "b"]
  );
  // The normal-severity one is still owed a decision.
  assert.equal(report.summary.awaitingReview, 3);
});

test("a quiet day renders none of the detail sections", () => {
  const report = buildDailyLifecycleReport(input());
  assert.equal(report.allClear, true);
  const { html, text } = buildModelLifecycleDailyEmail(input());
  assert.match(html, /All clear/);
  assert.doesNotMatch(html, /ACTION REQUIRED/);
  assert.doesNotMatch(html, /AWAITING DECISION/i);
  assert.match(text, /ALL CLEAR/);
  // The provider table stays: "checked 11 of 12" is the evidence that the
  // quiet day was actually observed rather than merely not reported.
  assert.match(text, /PROVIDER COVERAGE/);
});

test("an open item is enough to make the day not quiet", () => {
  const report = buildDailyLifecycleReport(input({ workItems: [item()] }));
  assert.equal(report.allClear, false);
});

test("a failed provider is enough on its own", () => {
  const report = buildDailyLifecycleReport(
    input({
      providers: [
        {
          provider: "minimax",
          displayName: "MiniMax",
          status: "failed",
          errorCode: "HTTP_401",
          modelCount: null,
          lastSuccessLabel: "19 Aug 2026",
          note: null,
        },
      ],
    })
  );
  assert.equal(report.allClear, false);
  assert.equal(report.summary.providersFailed, 1);
  assert.equal(report.summary.providersChecked, 0);
});

test("a truncated section states the total and where the rest are", () => {
  const overflowing = Array.from({ length: REPORT_SECTION_LIMIT + 6 }, (_, index) =>
    item({ id: `wi_${index}`, severity: "high", newToday: false, ageDays: index })
  );
  const report = buildDailyLifecycleReport(input({ workItems: overflowing }));
  assert.equal(report.actionRequired.rows.length, REPORT_SECTION_LIMIT);
  assert.equal(report.actionRequired.total, REPORT_SECTION_LIMIT + 6);
  assert.equal(report.actionRequired.hidden, 6);

  const { html, text } = buildModelLifecycleDailyEmail(input({ workItems: overflowing }));
  assert.match(html, /6 more/);
  assert.match(html, new RegExp(`${REPORT_SECTION_LIMIT + 6} in total`));
  assert.ok(html.includes(WORK_QUEUE));
  assert.match(text, new RegExp(`6 more of ${REPORT_SECTION_LIMIT + 6}`));
  assert.ok(text.includes(WORK_QUEUE));
});

test("past the digest threshold the rows go and the counts stay", () => {
  const many = Array.from({ length: AWAITING_DIGEST_THRESHOLD + 1 }, (_, index) =>
    item({
      id: `wi_${index}`,
      provider: index % 2 === 0 ? "OpenAI" : "Groq",
      newToday: false,
      ageDays: index,
    })
  );
  const report = buildDailyLifecycleReport(input({ workItems: many }));
  assert.ok(report.pendingDigest);
  assert.equal(report.pending.rows.length, 0);
  assert.equal(report.newToday.rows.length, 0);
  assert.equal(
    report.pendingDigest.reduce((sum, row) => sum + row.count, 0),
    AWAITING_DIGEST_THRESHOLD + 1
  );
  // Ordered by how much of the backlog each provider is.
  assert.equal(report.pendingDigest[0].displayName, "OpenAI");

  const { text } = buildModelLifecycleDailyEmail(input({ workItems: many }));
  assert.match(text, /AWAITING DECISION \(51\)/);
  assert.doesNotMatch(text, /wi_0/);
});

test("new today and pending are the same queue, split by when it arrived", () => {
  const report = buildDailyLifecycleReport(
    input({
      workItems: [
        item({ id: "new", newToday: true }),
        item({ id: "old", newToday: false, ageDays: 12 }),
      ],
    })
  );
  assert.deepEqual(report.newToday.rows.map((row) => row.id), ["new"]);
  assert.deepEqual(report.pending.rows.map((row) => row.id), ["old"]);
  assert.equal(report.summary.newToday, 1);
  assert.equal(report.summary.awaitingReview, 2);
});

test("decided but unshipped is its own section, not part of the backlog", () => {
  const report = buildDailyLifecycleReport(
    input({
      workItems: [
        item({ id: "shipping", status: "validation_pending", pendingValidations: ["pricing"] }),
      ],
    })
  );
  assert.equal(report.summary.awaitingReview, 0);
  assert.equal(report.summary.approvedNotShipped, 1);
  const { text } = buildModelLifecycleDailyEmail(
    input({
      workItems: [
        item({ id: "shipping", status: "validation_pending", pendingValidations: ["pricing"] }),
      ],
    })
  );
  assert.match(text, /APPROVED - AWAITING IMPLEMENTATION/);
  assert.match(text, /pending: pricing/);
});

test("every section the HTML renders, the plain text renders too", () => {
  const payload = input({
    workItems: [
      item({ id: "a", severity: "critical", action: "retire", blockers: ["replacement not chosen"] }),
      item({ id: "b", newToday: false, ageDays: 9 }),
      item({ id: "c", status: "rollout_pending" }),
    ],
    lifecycleWarnings: [
      { displayName: "Mistral", apiModel: "codestral-latest", lifecycle: "deprecated" },
    ],
    missing: [{ displayName: "Groq", apiModel: "llama-3-3-70b", consecutiveMissing: 3 }],
    registry: {
      ran: true,
      disabled: [
        {
          provider: "groq",
          displayName: "Groq",
          apiModel: "llama-3-3-70b",
          detail: "disabled after ×3 missing scans",
        },
      ],
      restored: [],
      held: [],
    },
    changes: { discovered: 3, decided: 1, transitions: 2, completed: 0 },
  });
  const { html, text } = buildModelLifecycleDailyEmail(payload);
  for (const heading of [
    "Action required",
    "New today",
    "Pending",
    "Approved",
    "Lifecycle risks",
    "Missing from successful provider catalogues",
    "Registry auto-updates",
    "Changes since yesterday",
    "Provider coverage",
  ]) {
    assert.ok(
      html.toLowerCase().includes(heading.toLowerCase()),
      `the HTML is missing "${heading}"`
    );
    assert.ok(
      text.toLowerCase().includes(heading.toLowerCase()),
      `the plain text is missing "${heading}"`
    );
  }
  // The blocker is the reason the item is stuck, so it is in both.
  assert.ok(html.includes("replacement not chosen"));
  assert.ok(text.includes("replacement not chosen"));
});

test("severity survives without colour", () => {
  const { html, text } = buildModelLifecycleDailyEmail(
    input({ workItems: [item({ severity: "critical", action: "retire" })] })
  );
  assert.ok(html.includes("CRITICAL"));
  assert.ok(text.includes("[CRITICAL]"));
});

test("the HTML stays inside what Outlook renders", () => {
  const { html } = buildModelLifecycleDailyEmail(
    input({ workItems: [item({ severity: "high" })] })
  );
  // Fixed-width nested table, not max-width alone.
  assert.match(html, /<table[^>]*width="640"/);
  // No layout the Word renderer drops.
  assert.doesNotMatch(html, /display:\s*flex/);
  assert.doesNotMatch(html, /display:\s*grid/);
  // The severity bar is a cell with a bgcolor, not a border-left.
  assert.match(html, /<td width="4" bgcolor=/);
  assert.doesNotMatch(html, /border-left/);
  // Long model ids break rather than widening the table.
  assert.match(html, /word-break:break-all/);
  // No webfont, ever.
  assert.doesNotMatch(html, /fonts\.googleapis\.com|@font-face/);
});

test("interpolated values are escaped", () => {
  const { html } = buildModelLifecycleDailyEmail(
    input({
      workItems: [
        item({
          severity: "high",
          apiModel: "<script>alert(1)</script>",
          blockers: ['"quoted" & <angled>'],
        }),
      ],
    })
  );
  assert.doesNotMatch(html, /<script>/i);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
});

test("the same payload renders the same bytes twice", () => {
  // The lane re-renders from the stored snapshot on every retry. If this were
  // ever false, the provider would stop recognising the retry as a duplicate.
  const payload = input({ workItems: [item({ severity: "high" })] });
  const first = buildModelLifecycleDailyEmail(payload);
  const second = buildModelLifecycleDailyEmail(payload);
  assert.deepEqual(first, second);
});

// ML-13: who made a model and which catalogue carried it are two different
// facts, and the report must not print one as the other.

const glm = (observedVia) =>
  item({
    // Filed by the Qwen scan, but Zhipu made it. The old report rendered
    // "Qwen ZHIPU/GLM-5.3", which reads as a claim about authorship.
    provider: "Qwen",
    publisher: "Zhipu",
    apiModel: "ZHIPU/GLM-5.3",
    observedVia,
    severity: "critical",
    status: "communication_pending",
  });

test("a work item names the publisher, not the catalogue it was filed from", () => {
  const { html, text } = buildModelLifecycleDailyEmail(
    input({
      workItems: [
        glm([{ provider: "qwen", displayName: "Qwen", apiModel: "ZHIPU/GLM-5.3" }]),
      ],
    })
  );
  for (const rendered of [html, text]) {
    assert.match(rendered, /Zhipu/);
    // The identifier still appears -- it is what an operator searches for.
    assert.match(rendered, /GLM-5\.3/);
  }
});

test("a second catalogue is named as a sighting, beside the publisher", () => {
  const { html, text } = buildModelLifecycleDailyEmail(
    input({
      workItems: [
        glm([
          { provider: "qwen", displayName: "Qwen", apiModel: "ZHIPU/GLM-5.3" },
          {
            provider: "perplexity",
            displayName: "Perplexity",
            apiModel: "perplexity/glm-5.3",
          },
        ]),
      ],
    })
  );
  for (const rendered of [html, text]) {
    assert.match(rendered, /Zhipu/);
    assert.match(rendered, /seen in/);
    assert.match(rendered, /Perplexity/);
  }
});

test("a single sighting from the filing scan adds no noise", () => {
  // The ordinary case. Repeating "seen in OpenAI" under an item already filed
  // by OpenAI would bury the rows where the sighting list says something.
  const { text } = buildModelLifecycleDailyEmail(
    input({
      workItems: [item({ severity: "critical", status: "communication_pending" })],
    })
  );
  assert.doesNotMatch(text, /seen in/);
});

test("an unrecognised model is reported as unknown, not as a provider", () => {
  const { text } = buildModelLifecycleDailyEmail(
    input({
      workItems: [
        item({
          provider: "Groq",
          publisher: "unknown owner",
          apiModel: "aurora-9",
          observedVia: [
            { provider: "groq", displayName: "Groq", apiModel: "aurora-9" },
          ],
          severity: "critical",
          status: "communication_pending",
        }),
      ],
    })
  );
  assert.match(text, /unknown owner/);
  assert.doesNotMatch(text, /Groq \| aurora-9/);
});
