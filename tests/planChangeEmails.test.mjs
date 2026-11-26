import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildBillingWelcomeEmail, buildPlanChangeEmail } from "../lib/billingEmails.ts";
import { EMAIL_COPY_LANGUAGES } from "../lib/language.ts";
import {
  PLAN_CHANGE_DOWNGRADE_SCHEDULED_TEMPLATE,
  PLAN_CHANGE_UPGRADED_TEMPLATE,
  emailTemplateDefinition,
  templateDefinitionProblems,
} from "../lib/emailTemplateDefinitions.ts";

// Contract: docs/policy/plan-change.md section 9.

const PHASES = ["upgraded", "downgrade_scheduled"];
const EFFECTIVE_AT = "2026-12-20T00:00:00.000Z";

const render = (phase, language, overrides = {}) =>
  buildPlanChangeEmail(phase, {
    fromPlan: phase === "upgraded" ? "Pro" : "Max",
    toPlan: phase === "upgraded" ? "Max" : "Pro",
    billingInterval: "monthly",
    effectiveAt: EFFECTIVE_AT,
    language,
    ...overrides,
  });

test("both confirmations render in every email language with distinct subjects", () => {
  for (const phase of PHASES) {
    const subjects = new Set();
    for (const language of EMAIL_COPY_LANGUAGES) {
      const email = render(phase, language);
      assert.ok(email.subject.length > 0, `${phase} ${language}`);
      assert.ok(email.text.length > 0, `${phase} ${language}`);
      assert.ok(email.html.includes("<h1"), `${phase} ${language}`);
      subjects.add(email.subject);
    }
    assert.equal(subjects.size, EMAIL_COPY_LANGUAGES.length, `${phase} subjects repeat`);
  }
});

test("the two phases are two different messages that name the new plan", () => {
  const upgraded = render("upgraded", "en");
  const scheduled = render("downgrade_scheduled", "en");
  assert.notEqual(upgraded.subject, scheduled.subject);
  assert.match(upgraded.subject, /Max/);
  assert.match(scheduled.subject, /Pro/);
  // Both list the move from one plan to the other.
  assert.match(upgraded.text, /Previous plan: Pro/);
  assert.match(upgraded.text, /New plan: Max/);
  assert.match(scheduled.text, /Previous plan: Max/);
  assert.match(scheduled.text, /New plan: Pro/);
});

test("the scheduled downgrade quotes the date it takes effect and says it can be cancelled", () => {
  const ko = render("downgrade_scheduled", "ko");
  const date = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(EFFECTIVE_AT));
  assert.ok(ko.text.includes(date), ko.text);
  assert.match(ko.text, /예약을 취소/);
  assert.match(ko.text, /환불이 없습니다/);
});

test("it uses the billing welcome email's shell, so it reads like the receipt", () => {
  const welcome = buildBillingWelcomeEmail({ plan: "Max", language: "en" });
  const upgraded = render("upgraded", "en");
  const shellStart = welcome.html.slice(0, welcome.html.indexOf("<h1"));
  assert.ok(upgraded.html.startsWith(shellStart));
  assert.ok(upgraded.html.includes("border:1px solid #dbeafe"));
});

test("an upgrade with no known renewal date leaves that row out", () => {
  const email = render("upgraded", "en", { effectiveAt: null });
  assert.doesNotMatch(email.text, /Current billing period ends/);
  assert.doesNotMatch(email.html, /Current billing period ends/);
  assert.doesNotMatch(email.text, /Not available/);
});

test("plan names are escaped in the HTML part", () => {
  const email = render("downgrade_scheduled", "en", { fromPlan: "<b>Max</b>" });
  assert.doesNotMatch(email.html, /<b>Max<\/b>/);
  assert.match(email.html, /&lt;b&gt;Max&lt;\/b&gt;/);
});

test("rendering is deterministic, which the idempotency key depends on", () => {
  for (const phase of PHASES) {
    assert.deepEqual(render(phase, "en"), render(phase, "en"));
  }
});

test("both templates are transactional billing mail with no unsubscribe link", () => {
  for (const key of [PLAN_CHANGE_UPGRADED_TEMPLATE, PLAN_CHANGE_DOWNGRADE_SCHEDULED_TEMPLATE]) {
    const definition = emailTemplateDefinition(key);
    assert.equal(definition.senderRole, "billing", key);
    assert.equal(definition.classification, "transactional", key);
    assert.equal(definition.purpose, null, key);
    assert.equal(definition.requiresUnsubscribe, false, key);
    assert.deepEqual(templateDefinitionProblems(definition), [], key);
    assert.ok(definition.render(definition.placeholderPayload, "en").subject.length > 0, key);
  }
});

test("each confirmation has exactly one place that queues it", () => {
  // A count, not a position: the standard lane does not dedupe by reference,
  // so a second call site would be a second email for one change. Where each
  // one sits (after the conditional update that moved the row) is described
  // in docs/policy/plan-change.md section 9.
  const source = readFileSync("lib/planChangeService.ts", "utf8");
  const count = (needle) => source.split(needle).length - 1;
  assert.equal(count("await enqueuePlanChangeConfirmation({"), 2);
  assert.equal(count("templateKey: PLAN_CHANGE_UPGRADED_TEMPLATE,"), 1);
  assert.equal(count("templateKey: PLAN_CHANGE_DOWNGRADE_SCHEDULED_TEMPLATE,"), 1);
  // Both are gated on a conditional update having matched.
  assert.equal(count("if (moved.count !== 1)"), 1);
  assert.equal(count("if (applied.count > 0) {"), 1);
});
