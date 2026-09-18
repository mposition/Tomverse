import assert from "node:assert/strict";

import {
  SEND_ALLOWLIST,
  sendEntryPointViolations,
} from "../scripts/check-send-entry-points-core.mjs";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  buildAdminPlanChangedEmail,
  buildFoundingTesterPassEmail,
} from "../lib/billingEmails.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import {
  ADMIN_PLAN_CHANGED_TEMPLATE,
  FOUNDING_TESTER_PASS_ENDED_TEMPLATE,
  FOUNDING_TESTER_PASS_REMINDER_TEMPLATE,
  FOUNDING_TESTER_PASS_STARTED_TEMPLATE,
  emailTemplateDefinition,
  templateDefinitionProblems,
} from "../lib/emailTemplateDefinitions.ts";

// The four sends that ADR §2.4 listed and M1 never finished moving onto the
// queue.
//
// Contract: docs/policy/email-notifications.md §2.4, §3, §9.3,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-07.

const PASS_PHASES = ["started", "reminder", "ended"];
const PERIOD_END = "2026-10-21T00:00:00.000Z";

test("each pass notice renders in all seven languages with a distinct subject", () => {
  for (const phase of PASS_PHASES) {
    const subjects = new Set();
    for (const language of SUPPORTED_LANGUAGES) {
      const email = buildFoundingTesterPassEmail(phase, {
        periodEnd: PERIOD_END,
        language,
      });
      assert.ok(email.subject.length > 0, `${phase}/${language} has no subject`);
      subjects.add(email.subject);
    }
    // A language that fell back silently would collapse the set, which is the
    // failure a per-language assertion cannot see.
    assert.equal(
      subjects.size,
      SUPPORTED_LANGUAGES.length,
      `${phase}: languages share a subject, so one is falling back`
    );
  }
});

test("the three phases are three different messages", () => {
  const subjects = PASS_PHASES.map(
    (phase) =>
      buildFoundingTesterPassEmail(phase, {
        periodEnd: PERIOD_END,
        language: "en",
      }).subject
  );
  assert.equal(new Set(subjects).size, 3);
});

test("the started and reminder notices quote the date they are about", () => {
  for (const phase of ["started", "reminder"]) {
    for (const language of SUPPORTED_LANGUAGES) {
      const { text } = buildFoundingTesterPassEmail(phase, {
        periodEnd: PERIOD_END,
        language,
      });
      // Not the formatted string, which differs per locale: the year is the
      // part that must survive every one of them.
      assert.match(
        text,
        /2026/,
        `${phase}/${language} dropped the period end`
      );
    }
  }
});

test("a missing period end renders the locale's own placeholder, not a crash", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const { text, subject } = buildFoundingTesterPassEmail("reminder", {
      periodEnd: null,
      language,
    });
    assert.ok(subject.length > 0);
    assert.doesNotMatch(text, /Invalid Date|NaN|null|undefined/);
  }
});

test("rendering is deterministic, which the idempotency key depends on", () => {
  const once = buildFoundingTesterPassEmail("ended", {
    periodEnd: PERIOD_END,
    language: "ko",
  });
  const twice = buildFoundingTesterPassEmail("ended", {
    periodEnd: PERIOD_END,
    language: "ko",
  });
  assert.deepEqual(once, twice);

  const plan = { plan: "Pro", billingInterval: "monthly", periodEnd: PERIOD_END, reason: null };
  assert.deepEqual(
    buildAdminPlanChangedEmail(plan),
    buildAdminPlanChangedEmail(plan)
  );
});

test("the plan-change notice names the plan and keeps the reason optional", () => {
  const withReason = buildAdminPlanChangedEmail({
    plan: "Max",
    billingInterval: "annual",
    periodEnd: PERIOD_END,
    reason: "Migrated from the legacy tier",
  });
  assert.match(withReason.subject, /Max/);
  assert.match(withReason.text, /Migrated from the legacy tier/);

  const withoutReason = buildAdminPlanChangedEmail({
    plan: "Max",
    billingInterval: "annual",
    periodEnd: PERIOD_END,
    reason: null,
  });
  assert.doesNotMatch(withoutReason.text, /Reason:/);
});

test("the four templates are transactional and carry no unsubscribe link", () => {
  const keys = [
    FOUNDING_TESTER_PASS_STARTED_TEMPLATE,
    FOUNDING_TESTER_PASS_REMINDER_TEMPLATE,
    FOUNDING_TESTER_PASS_ENDED_TEMPLATE,
    ADMIN_PLAN_CHANGED_TEMPLATE,
  ];
  assert.equal(new Set(keys).size, 4, "two templates share a key");
  for (const key of keys) {
    const definition = emailTemplateDefinition(key);
    assert.equal(definition.classification, "transactional", key);
    assert.equal(definition.purpose, null, key);
    assert.equal(definition.requiresUnsubscribe, false, key);
    assert.deepEqual(templateDefinitionProblems(definition), [], key);
    // The placeholder is what registers the TemplateVersion, so it has to
    // render without the real values present.
    assert.ok(
      definition.render(definition.placeholderPayload, "en").subject.length > 0,
      key
    );
  }
});

// The acceptance criterion, as a check rather than a state somebody observed
// once: no user-facing path may call the provider directly again.
//
// The list of who may lives in one place now --
// `scripts/check-send-entry-points-core.mjs`, enforced by
// `npm run check:send-entry-points` in PR Fast Gate. This test used to carry a
// second copy, and two lists of the same rule drift: the copy here still
// exempted the credential lane's old sender months after the lane stopped
// using it (docs/policy/email-notifications.md v23).
//
// What is asserted here is the part that check cannot see: that the exemptions
// are the ones the contract names, and that each says why.
test("the files allowed to send directly are the ones the contract names", () => {
  assert.deepEqual(Object.keys(SEND_ALLOWLIST).sort(), [
    "app/api/admin/test-email/route.ts",
    "lib/email.ts",
    "lib/emailSendLock.ts",
    "lib/operationalMonitoring.ts",
    "lib/operatorNotificationSend.ts",
    "lib/providerMonitoring.ts",
  ]);
  // The queue is the one that must not be here: it carries customer notices
  // and operator alerts in one file, so allowing it would allow a customer
  // send in it to skip the address lock (section 7.4, C41).
  assert.equal(Object.hasOwn(SEND_ALLOWLIST, "lib/notificationDeliveries.ts"), false);
});

test("no user-facing path sends transactional email directly", () => {
  const tracked = execFileSyncLines("git", [
    "ls-files",
    "app",
    "lib",
    "scripts",
  ]).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

  const violations = sendEntryPointViolations(
    tracked.map((file) => ({ path: file, source: readFileSync(file, "utf8") }))
  );

  assert.deepEqual(
    violations.map((violation) => violation.path),
    [],
    "these reach the provider without the address lock; a customer send belongs " +
      "in sendWithAddressLock(), an operator alert in an allowlisted module"
  );
});

function execFileSyncLines(command, args) {
  return execFileSync(command, args, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}
