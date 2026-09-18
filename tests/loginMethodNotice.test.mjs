import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildLoginMethodLinkedEmail,
  buildLoginMethodUnlinkedEmail,
} from "../lib/emailLoginEmails.ts";
import {
  emailTemplateDefinition,
  LOGIN_METHOD_LINKED_TEMPLATE,
  LOGIN_METHOD_UNLINKED_TEMPLATE,
} from "../lib/emailTemplateDefinitions.ts";

/**
 * The notice that a login method changed.
 *
 * Contract: docs/policy/email-notifications.md v23, section 9.8.
 *
 * It used to be sent after the response, and a failure left an incident and a
 * person who had been signed out of every device and told nothing. These pin
 * the two things that stopped that: the message is a queued template, and the
 * row is written in the same transaction as the change.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

test("the two notices are separate templates, not one with a branch", () => {
  // The registry hashes a single `placeholderPayload` per template, so a
  // template rendering two subjects would have one artifact matching neither.
  const linked = emailTemplateDefinition(LOGIN_METHOD_LINKED_TEMPLATE);
  const unlinked = emailTemplateDefinition(LOGIN_METHOD_UNLINKED_TEMPLATE);
  assert.notEqual(linked.key, unlinked.key);
  assert.notEqual(
    linked.render({ method: "google" }, "en").subject,
    unlinked.render({ method: "google" }, "en").subject
  );
});

test("both are security transactional mail with no purpose to switch off", () => {
  for (const key of [LOGIN_METHOD_LINKED_TEMPLATE, LOGIN_METHOD_UNLINKED_TEMPLATE]) {
    const definition = emailTemplateDefinition(key);
    assert.equal(definition.senderRole, "security", key);
    assert.equal(definition.classification, "transactional", key);
    assert.equal(definition.purpose, null, key);
    assert.equal(definition.requiresUnsubscribe, false, key);
  }
});

test("the unlink notice says the other devices were signed out", () => {
  // That sentence is the whole reason the message is urgent: it is what tells
  // somebody whose account was taken that it was taken.
  const message = buildLoginMethodUnlinkedEmail({ method: "google" }, "en");
  assert.match(message.text, /signed out/i);
  assert.match(message.text, /support@tomverse\.app/);
  const linked = buildLoginMethodLinkedEmail({ method: "google" }, "en");
  assert.doesNotMatch(linked.text, /signed out/i);
  assert.match(linked.text, /support@tomverse\.app/);
});

test("the method reaches the copy, in every language it renders", () => {
  for (const language of ["en", "ko"]) {
    const message = buildLoginMethodLinkedEmail({ method: "azure-ad" }, language);
    assert.match(message.text, /Microsoft/, language);
    assert.ok(message.html.includes("Microsoft"), language);
  }
});

test("the change and the notice commit together", () => {
  // The queue row is written with the caller's transaction client. Without
  // that, a change that rolled back could still have queued the notice -- and
  // worse, a change that committed could have lost it.
  //
  // This reads the source because a route cannot be driven against a database.
  // The behaviour itself is proved in tests/integration/login-methods.db.test.ts,
  // for both of the two paths that have a testable entry point: the removal and
  // the email verification. The OAuth link is only covered here, because
  // `completeOAuthLink` talks to a provider before it writes anything.
  const notice = read("lib/loginMethodNotice.ts");
  assert.match(notice, /enqueueStandardEmail\(\{\s*\n\s*tx,/);
  for (const caller of ["lib/loginMethodsCore.ts", "lib/oauthLink.ts"]) {
    assert.match(read(caller), /enqueueLoginMethodNotice\(tx, \{/, caller);
  }
});

test("the version that was prepared is the version the row asks for", () => {
  // The language used to be read twice -- once to prepare the template version
  // and again inside the transaction. Somebody changing it in between would
  // leave the enqueue needing a version nobody prepared, and
  // `enqueueStandardEmail` would register one inside the login-method
  // transaction, which is what preparing it beforehand exists to avoid
  // (independent review, 2026-09-18).
  const notice = read("lib/loginMethodNotice.ts");
  // The enqueue takes the language rather than reading it.
  assert.match(notice, /language: string \| null;/);
  assert.match(notice, /language: input\.language,/);
  assert.doesNotMatch(notice, /settings: \{ select: \{ language/);
  for (const caller of ["lib/loginMethodsCore.ts", "lib/oauthLink.ts"]) {
    const source = read(caller);
    assert.match(source, /const language = await loginMethodNoticeLanguage\(/, caller);
    assert.match(
      source,
      /prepareLoginMethodNotice\(\{ action: "[a-z]+", language \}\)/,
      caller
    );
  }
});

test("no login-method route sends after the response any more", () => {
  for (const route of [
    "app/api/user/login-methods/route.ts",
    "app/api/user/login-methods/email/verify/route.ts",
    "app/api/user/login-methods/oauth/callback/route.ts",
  ]) {
    const source = read(route);
    assert.doesNotMatch(source, /sendLoginMethodChangedEmail/, route);
    assert.doesNotMatch(source, /LOGIN_METHOD_NOTIFICATION_FAILED/, route);
  }
});

test("the OAuth callback no longer announces a link that did not happen", () => {
  // `completeOAuthLink` returns early when the account is already linked to
  // this same user. The route used to send regardless, so a replayed callback
  // said "a login method was added" about nothing.
  const link = read("lib/oauthLink.ts");
  const earlyReturn = link.indexOf("return; // already linked to this same user");
  // The call, not the import at the top of the file.
  const enqueue = link.indexOf("await enqueueLoginMethodNotice(tx");
  assert.ok(earlyReturn > 0 && enqueue > earlyReturn, "the notice is after the early return");
});
