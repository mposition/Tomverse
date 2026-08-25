import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { directProviderKeyReads } from "../lib/emailProviderPortCore.ts";
import {
  SENDER_ROLES,
  SENDER_ROLE_SPECS,
  SENDING_IDENTITY_ENV_KEYS,
  parseFromAddress,
  replyToForSenderRole,
  resolveSenderIdentity,
  sendCallsMissingSenderRole,
  senderRoleAllowedOnStream,
  senderRoleProblems,
  senderRolesForStream,
  sendingIdentityReadiness,
  sendingSubdomainAddresses,
  streamForSenderRole,
} from "../lib/emailSendingIdentityCore.ts";
import { allTemplateDefinitions } from "../lib/emailTemplateDefinitions.ts";
import { NOTIFICATION_SENDER_ROLE } from "../lib/notificationDeliveries.ts";

// Who a message is from, as a decision separate from which domain carries it.
// Contract: docs/policy/email-notifications.md §14.1a.

/** The production shape, so the expectations below are the real addresses. */
const PRODUCTION_ENV = {
  TRANSACTIONAL_EMAIL_FROM: "Tomverse Review <hello@mail.tomverse.app>",
};

const from = (role, env = PRODUCTION_ENV) => {
  const resolved = resolveSenderIdentity(streamForSenderRole(role), role, env);
  assert.equal(resolved.ok, true, `${role} did not resolve`);
  return resolved.from;
};

// ---------------------------------------------------------------------------
// The addresses themselves
// ---------------------------------------------------------------------------

test("each role resolves to the address the migration promised", () => {
  // The completion criteria, written as the values an operator can check in a
  // received message rather than as a shape.
  assert.equal(from("general"), "Tomverse Review <hello@mail.tomverse.app>");
  assert.equal(from("security"), "Tomverse Security <security@mail.tomverse.app>");
  assert.equal(from("billing"), "Tomverse Billing <billing@mail.tomverse.app>");
  assert.equal(from("support"), "Tomverse Support <support@mail.tomverse.app>");
  assert.equal(from("operations"), "Tomverse Operations <alerts@mail.tomverse.app>");
});

test("general is the configured identity verbatim, not a rebuild of it", () => {
  // The one address that already exists in DNS and in people's filters. A
  // resolver that recomposed it from its parts would drop a display name the
  // operator chose, or normalise a mailbox nobody asked it to touch.
  for (const configured of [
    "Tomverse Review <hello@mail.tomverse.app>",
    '"Tomverse, Inc." <no-reply-legacy@mail.tomverse.app>',
    "hello@mail.tomverse.app",
  ]) {
    assert.equal(from("general", { TRANSACTIONAL_EMAIL_FROM: configured }), configured);
  }
});

test("display name and local part are both what the role table says", () => {
  for (const role of senderRolesForStream("transactional")) {
    const resolved = resolveSenderIdentity("transactional", role, PRODUCTION_ENV);
    assert.equal(resolved.ok, true);
    const spec = SENDER_ROLE_SPECS[role];
    if (spec.localPart === null) continue;
    assert.equal(resolved.localPart, spec.localPart, `${role} local part`);
    assert.equal(resolved.displayName, spec.displayName, `${role} display name`);
    const parsed = parseFromAddress(resolved.from);
    assert.equal(parsed.displayName, spec.displayName);
    assert.equal(parsed.address, `${spec.localPart}@mail.tomverse.app`);
  }
});

test("every transactional role sends from the authenticated domain", () => {
  // The property that makes a role safe to add without a DNS change: the domain
  // is read from the configured transactional address, never named. A role on a
  // domain we hold no DKIM key for would arrive unsigned.
  for (const configured of [
    "Tomverse Review <hello@mail.tomverse.app>",
    "Tomverse <hello@sending.example.net>",
    "hello@tomverse.app",
  ]) {
    const env = { TRANSACTIONAL_EMAIL_FROM: configured };
    const expected = parseFromAddress(configured).domain;
    for (const role of senderRolesForStream("transactional")) {
      const resolved = resolveSenderIdentity("transactional", role, env);
      assert.equal(resolved.ok, true, `${role} on ${configured}`);
      assert.equal(resolved.domain, expected, `${role} on ${configured}`);
    }
  }
});

test("a role is not an environment variable", () => {
  // No new required configuration: the five transactional roles all resolve
  // from the one variable that already exists, so a deployment that sets
  // nothing else is complete. Six variables, one per role, would be six chances
  // for a cutover to move five of them.
  assert.deepEqual(SENDING_IDENTITY_ENV_KEYS, {
    transactional: ["TRANSACTIONAL_EMAIL_FROM", "EMAIL_FROM"],
    marketing: ["MARKETING_EMAIL_FROM"],
  });
  const spec = JSON.stringify(SENDER_ROLE_SPECS);
  assert.equal(
    /[A-Z][A-Z0-9_]{4,}/.test(spec),
    false,
    `the role table names something variable-shaped: ${spec}`
  );
});

// ---------------------------------------------------------------------------
// Stream and role are separate axes
// ---------------------------------------------------------------------------

test("each role belongs to exactly one stream", () => {
  assert.deepEqual(senderRolesForStream("marketing"), ["marketing"]);
  assert.deepEqual(senderRolesForStream("transactional"), [
    "general",
    "security",
    "billing",
    "support",
    "operations",
  ]);
  assert.equal(
    senderRolesForStream("transactional").length +
      senderRolesForStream("marketing").length,
    SENDER_ROLES.length,
    "a role on no stream, or on two, cannot be resolved"
  );
});

test("a role on the wrong stream is refused, never quietly moved", () => {
  // Fail-closed at the send, like the stream refusal it sits beside. A
  // marketing message accepted onto the transactional stream arrives, looks
  // right, and puts a promotion's complaints on the domain that carries login
  // codes -- with no symptom until the login codes stop arriving.
  const marketingEnv = {
    ...PRODUCTION_ENV,
    MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>",
  };
  const onTransactional = resolveSenderIdentity(
    "transactional",
    "marketing",
    marketingEnv
  );
  assert.equal(onTransactional.ok, false);
  assert.equal(onTransactional.code, "SENDER_ROLE_NOT_ON_STREAM");

  for (const role of senderRolesForStream("transactional")) {
    const onMarketing = resolveSenderIdentity("marketing", role, marketingEnv);
    assert.equal(onMarketing.ok, false, `${role} was accepted on marketing`);
    assert.equal(onMarketing.code, "SENDER_ROLE_NOT_ON_STREAM");
    assert.equal(senderRoleAllowedOnStream("marketing", role), false);
  }
});

test("an unknown role is refused rather than defaulted", () => {
  const resolved = resolveSenderIdentity("transactional", "finance", PRODUCTION_ENV);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "SENDER_ROLE_UNKNOWN");
});

test("marketing keeps its own identity and still refuses to borrow", () => {
  // The existing prohibition, re-asserted through the role resolver: adding an
  // axis must not open a second way to send a promotion from the transactional
  // domain.
  const missing = resolveSenderIdentity("marketing", "marketing", PRODUCTION_ENV);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "MARKETING_FROM_MISSING");

  const shared = resolveSenderIdentity("marketing", "marketing", {
    ...PRODUCTION_ENV,
    MARKETING_EMAIL_FROM: "Tomverse <news@mail.tomverse.app>",
  });
  assert.equal(shared.ok, false);
  assert.equal(shared.code, "STREAMS_SHARE_A_DOMAIN");

  const separate = resolveSenderIdentity("marketing", "marketing", {
    ...PRODUCTION_ENV,
    MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>",
  });
  assert.equal(separate.ok, true);
  assert.equal(separate.from, "Tomverse <news@news.tomverse.app>");
});

// ---------------------------------------------------------------------------
// Configuration that cannot produce an address
// ---------------------------------------------------------------------------

test("an unreadable or missing transactional address refuses every role", () => {
  for (const configured of ["Tomverse <hello@${DOMAIN}>", "hello", "hello@"]) {
    for (const role of senderRolesForStream("transactional")) {
      const resolved = resolveSenderIdentity("transactional", role, {
        TRANSACTIONAL_EMAIL_FROM: configured,
      });
      assert.equal(resolved.ok, false, `${role} on ${configured}`);
      assert.equal(resolved.code, "TRANSACTIONAL_FROM_UNPARSEABLE");
    }
  }
});

test("an empty environment still resolves, because login codes have to send", () => {
  // The compiled fallback, unchanged: a deployment that forgot the variable
  // sends from the documented default rather than stopping. Every role follows
  // it, which is the point of deriving the domain rather than naming it.
  for (const role of senderRolesForStream("transactional")) {
    const resolved = resolveSenderIdentity("transactional", role, {});
    assert.equal(resolved.ok, true, role);
    assert.equal(resolved.domain, "tomverse.app");
  }
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test("readiness reports every role, not only the stream", () => {
  // What /api/ready gains: the stream check alone cannot tell whether the five
  // derived senders exist, and they are what most of the mail now goes out as.
  assert.deepEqual(
    senderRoleProblems({
      transactionalFrom: PRODUCTION_ENV.TRANSACTIONAL_EMAIL_FROM,
      marketingFrom: null,
    }),
    []
  );
  assert.equal(
    sendingIdentityReadiness({
      transactionalFrom: PRODUCTION_ENV.TRANSACTIONAL_EMAIL_FROM,
      marketingFrom: null,
      nodeEnv: "production",
    }).ready,
    true
  );
});

test("a broken transactional address is reported once, not once per role", () => {
  // Five copies of one fault is a list nobody reads, and the rest of the
  // findings are what get buried under it.
  const problems = sendingIdentityReadiness({
    transactionalFrom: "hello",
    marketingFrom: null,
  });
  assert.deepEqual(
    problems.errors.map((problem) => problem.code),
    ["TRANSACTIONAL_FROM_UNPARSEABLE"]
  );
});

test("readiness stays green on the deployment that exists today", () => {
  // The pre-cutover state: transactional still on the registrable domain. It is
  // a warning and must stay one -- gating on it would refuse readiness in
  // production to announce a planned migration.
  const readiness = sendingIdentityReadiness({
    transactionalFrom: "Tomverse Review <hello@tomverse.app>",
    marketingFrom: null,
    nodeEnv: "production",
  });
  assert.equal(readiness.ready, true);
  assert.deepEqual(
    readiness.warnings.map((problem) => problem.code),
    ["TRANSACTIONAL_ON_ROOT_DOMAIN"]
  );
});

// ---------------------------------------------------------------------------
// Reply-To
// ---------------------------------------------------------------------------

test("a reply goes to a mailbox the repository says is read", () => {
  // From and mailbox are different things. `EMAIL_BUSINESS_CONTACT_EMAIL` is
  // the address a recipient may contact about the message
  // (docs/ops/email-business-identity.md); the sending identities are not
  // documented as receiving anything.
  const env = { EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app" };
  for (const role of ["general", "security", "billing", "support"]) {
    assert.equal(replyToForSenderRole(role, env), "support@tomverse.app");
  }
  // Operator alerts already land where the team reads, and a reply about an
  // incident does not belong in the support queue.
  assert.equal(replyToForSenderRole("operations", env), null);
  assert.equal(replyToForSenderRole("marketing", env), null);
});

test("an unset or unreadable contact address sends no Reply-To at all", () => {
  // The behaviour that existed before roles. A Reply-To pointing at a mailbox
  // nobody reads is worse than none: the reply is accepted and then lost.
  assert.equal(replyToForSenderRole("security", {}), null);
  assert.equal(replyToForSenderRole("security", { EMAIL_BUSINESS_CONTACT_EMAIL: "  " }), null);
  assert.equal(
    replyToForSenderRole("security", { EMAIL_BUSINESS_CONTACT_EMAIL: "support@" }),
    null
  );
});

// ---------------------------------------------------------------------------
// Every message names a role
// ---------------------------------------------------------------------------

test("every template definition declares a role its classification allows", () => {
  for (const definition of allTemplateDefinitions()) {
    assert.ok(
      SENDER_ROLES.includes(definition.senderRole),
      `${definition.key} names no sender role`
    );
    const stream =
      definition.classification === "marketing" ? "marketing" : "transactional";
    assert.equal(
      senderRoleAllowedOnStream(stream, definition.senderRole),
      true,
      `${definition.key} is ${definition.classification} mail sent as ${definition.senderRole}`
    );
  }
});

test("the templates that had to move are the ones that moved", () => {
  const roleOf = (key) => {
    const definition = allTemplateDefinitions().find((entry) => entry.key === key);
    assert.ok(definition, `${key} is not a registered template`);
    return definition.senderRole;
  };

  // A login code is the message a recipient most needs to recognise, and the
  // address it arrives from is most of that recognition.
  assert.equal(roleOf("auth_login_code"), "security");
  assert.equal(roleOf("account_deletion_scheduled"), "security");
  assert.equal(roleOf("account_restored"), "security");

  // Money. These belong beside the receipts, wherever the recipient files them.
  for (const key of [
    "billing_welcome",
    "founding_tester_pass_started",
    "founding_tester_pass_reminder",
    "founding_tester_pass_ended",
    "admin_plan_changed",
  ]) {
    assert.equal(roleOf(key), "billing", key);
  }

  // The operator report, and the one product announcement.
  assert.equal(roleOf("ops_model_lifecycle_daily"), "operations");
  assert.equal(roleOf("model_launch"), "marketing");

  // And the one that keeps the historical identity: a welcome from the product.
  assert.equal(roleOf("account_welcome"), "general");
});

test("the login-code sender is named identically wherever it is written", () => {
  // lib/emailLoginEmails.ts names the role rather than importing it, because
  // lib/emailTemplateDefinitions.ts imports *it* for the renderer and a cycle
  // for one string is the worse trade. This is what stops the two drifting.
  const definition = allTemplateDefinitions().find(
    (entry) => entry.key === "auth_login_code"
  );
  const source = readFileSync("lib/emailLoginEmails.ts", "utf8");
  const declared = [...source.matchAll(/senderRole:\s*"([a-z]+)"/g)].map(
    (match) => match[1]
  );
  assert.ok(declared.length > 0, "the login emails name no sender role");
  for (const role of declared) {
    assert.equal(role, definition.senderRole);
  }
});

test("every notification kind names a sender, and the right one", () => {
  // Keyed on `kind`, which is a stored column, so the inline first attempt and
  // every retry resolve the same sender.
  assert.deepEqual(NOTIFICATION_SENDER_ROLE, {
    // To the team, about somebody else's report.
    support_feedback: "operations",
    // Money.
    refund_request_received: "billing",
    refund_request_approved: "billing",
    refund_request_rejected: "billing",
    // To the person who filed it.
    feedback_user_received: "support",
    feedback_user_reviewing: "support",
    feedback_user_completed: "support",
  });
  for (const role of Object.values(NOTIFICATION_SENDER_ROLE)) {
    assert.equal(senderRoleAllowedOnStream("transactional", role), true);
  }
});

test("both lanes log the sender they used, with no credential and no recipient", () => {
  // The lanes record an outcome on a row; the wire call logs nothing. Before
  // this a message that left as the wrong sender left no trace of having done
  // so, which is the question this whole axis exists to make answerable.
  for (const [file, event] of [
    ["lib/standardEmailLane.ts", "standard_email_sent"],
    ["lib/credentialEmailLane.ts", "credential_email_sent"],
  ]) {
    const source = readFileSync(file, "utf8");
    const block = source.slice(
      source.indexOf(`event: "${event}"`),
      source.indexOf(`event: "${event}"`) + 700
    );
    assert.ok(block.length > 0, `${file} logs no ${event}`);
    assert.match(block, /stream:/, `${event} names no stream`);
    assert.match(block, /senderRole:/, `${event} names no sender role`);
    // Neither the address it went to nor anything rendered. On the credential
    // lane the rendered body *is* the secret.
    assert.doesNotMatch(block, /\bto:/, `${event} logs a recipient`);
    assert.doesNotMatch(block, /\b(html|text|code|subject):/, `${event} logs content`);
  }
});

test("the operator alert paths and the audit report all send as operations", () => {
  // Three senders that each held their own From variable before 2026-08-21, so
  // three that a role change is most likely to leave behind. Read from the
  // source, because none of them is reachable without a provider.
  for (const file of ["lib/operationalMonitoring.ts", "lib/providerMonitoring.ts"]) {
    const source = readFileSync(file, "utf8");
    const roles = [...source.matchAll(/senderRole:\s*"([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(roles.length > 0, `${file} sends without naming a role`);
    for (const role of roles) assert.equal(role, "operations", file);
  }

  const audit = readFileSync("scripts/send-security-audit-report.mjs", "utf8");
  assert.match(
    audit,
    /resolveSenderIdentity\(\s*"transactional",\s*"operations",\s*process\.env\s*\)/,
    "the GitHub Actions security report must resolve its sender centrally"
  );
});

// ---------------------------------------------------------------------------
// The static checks that keep the resolver the only way in
// ---------------------------------------------------------------------------

test("an address on a sending subdomain is found wherever it is written", () => {
  // The shape a role bypass takes. None of these sits in a `from` position, so
  // `hardCodedSenders` -- which matches the From header shape -- sees none of
  // them.
  for (const source of [
    'const ALERTS = "alerts@mail.tomverse.app";',
    "const security = `security@mail.tomverse.app`;",
    "send({ to: 'billing@mail.tomverse.app' });",
  ]) {
    assert.equal(sendingSubdomainAddresses(source).length, 1, source);
  }
});

test("the published contact address is not mistaken for a sender", () => {
  // It appears in seven locales of legal copy and on every support screen.
  // Flagging it would train people to add exceptions rather than read findings,
  // and the exception list is where a real bypass would hide.
  for (const source of [
    'const SUPPORT = "support@tomverse.app";',
    '<a href="mailto:support@tomverse.app">Contact</a>',
    'await signIn({ email: "qa@tomverse.app" });',
  ]) {
    assert.deepEqual(sendingSubdomainAddresses(source), [], source);
  }
});

test("a send written without a role is found", () => {
  assert.deepEqual(
    sendCallsMissingSenderRole('await sendTransactionalEmail({ to, subject, text, html });'),
    [{ line: 1, call: "sendTransactionalEmail" }]
  );
  assert.deepEqual(
    sendCallsMissingSenderRole(
      "await deliverEmailOnce({\n  to,\n  subject,\n  senderRole: role,\n});"
    ),
    []
  );
  // A nested object or call must not end the scan early and report a call that
  // names its role three lines further down.
  assert.deepEqual(
    sendCallsMissingSenderRole(
      "deliverEmailOnce({\n  to,\n  headers: build({ a: 1 }),\n  senderRole: 'security',\n});"
    ),
    []
  );
  // The declaration of one of them is not a call to it.
  assert.deepEqual(
    sendCallsMissingSenderRole("export async function deliverEmailOnce(input) {}"),
    []
  );
});

test("a provider key read straight off an environment is found", () => {
  // The sender rule applied to the credential. Four files read `RESEND_API_KEY`
  // directly while `providerApiKeyFor()` prefers `TRANSACTIONAL_RESEND_API_KEY`,
  // so a deployment setting the specific name sent with one key and reported
  // with another -- and the domain report's 401 then looked like a finding
  // about the sending domains rather than a permission error on one credential.
  for (const source of [
    "const key = process.env.RESEND_API_KEY;",
    'const key = env["TRANSACTIONAL_RESEND_API_KEY"];',
    "if (process.env.MARKETING_RESEND_API_KEY) send();",
  ]) {
    assert.equal(directProviderKeyReads(source).length, 1, source);
  }

  // A name is not a read. The admin environment screen prints the variable as a
  // label and says in prose that the stream-specific name satisfies it, and a
  // comment may explain the rule without breaking it.
  for (const source of [
    '  name: "RESEND_API_KEY",',
    '  description: "Required for email. TRANSACTIONAL_RESEND_API_KEY satisfies it too.",',
    "// never read RESEND_API_KEY directly",
    "const key = providerApiKeyFor('transactional', env);",
  ]) {
    assert.deepEqual(directProviderKeyReads(source), [], source);
  }
});

test("the tree contains no bypass of the resolver", () => {
  // The check the PR gate runs, executed here too so a failure names the file
  // rather than only the gate.
  const tracked = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.startsWith("tests/"));

  const findings = [];
  for (const file of tracked) {
    // The core owns the fallback and describes the check; lib/email.ts forwards
    // an already-typed input by spread. Both are exempt in the gate too.
    if (file === "lib/emailSendingIdentityCore.ts") continue;
    const source = readFileSync(file, "utf8");
    for (const found of sendingSubdomainAddresses(source)) {
      findings.push(`${file}:${found.line}: ${found.literal}`);
    }
    // The core owns the key precedence table and the rule itself.
    if (file !== "lib/emailProviderPortCore.ts") {
      for (const found of directProviderKeyReads(source)) {
        findings.push(`${file}:${found.line}: reads ${found.text} directly`);
      }
    }
    if (file === "lib/email.ts") continue;
    for (const found of sendCallsMissingSenderRole(source)) {
      findings.push(`${file}:${found.line}: ${found.call}() names no senderRole`);
    }
  }
  assert.deepEqual(findings, []);
});
