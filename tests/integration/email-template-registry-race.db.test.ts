import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  ACCOUNT_WELCOME_TEMPLATE,
  AUTH_LOGIN_CODE_TEMPLATE,
  MODEL_LAUNCH_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";
import { prisma } from "@/lib/prisma";

// Two callers ensuring the same template at the same moment.
//
// Contract: docs/policy/email-notifications.md §10.2.
//
// `prisma.upsert` on a row that does not exist yet is a read then an insert, so
// two concurrent callers both read "absent" and both insert; the unique index
// lets one through and the other gets P2002. The module already handled that
// for `TemplateVersion` one statement further down and did not handle it for
// the two upserts above.
//
// The gap was not theoretical. It surfaced as a campaign detail page that could
// not load: the route asks the send gate and the content digest in parallel and
// both ensure the same template. The same race on the credential lane is two
// people signing in for the first time after a copy change, where losing it
// means one of them never receives their code -- which is why this is checked
// against a real database rather than a mock that cannot race.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
});

after(async () => {
  await prisma.$disconnect();
});

test("two callers ensuring the same template at once both get the same row", async () => {
  const [first, second] = await Promise.all([
    ensureTemplateVersion({
      templateKey: MODEL_LAUNCH_TEMPLATE,
      language: "en",
    }),
    ensureTemplateVersion({
      templateKey: MODEL_LAUNCH_TEMPLATE,
      language: "en",
    }),
  ]);

  assert.equal(first.templateId, second.templateId);
  assert.equal(first.templateVersionId, second.templateVersionId);

  // One row, not two and not a failure.
  assert.equal(
    await prisma.emailTemplate.count({
      where: { key: MODEL_LAUNCH_TEMPLATE },
    }),
    1
  );
});

test("many concurrent callers still produce one template and one version", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      ensureTemplateVersion({
        templateKey: AUTH_LOGIN_CODE_TEMPLATE,
        language: "ko",
      })
    )
  );

  const templateIds = new Set(results.map((result) => result.templateId));
  const versionIds = new Set(results.map((result) => result.templateVersionId));
  assert.equal(templateIds.size, 1);
  assert.equal(versionIds.size, 1);

  assert.equal(
    await prisma.templateVersion.count({
      where: { language: "ko", status: "published" },
    }),
    1
  );
});

test("different languages of one template race on the template row, not the version", async () => {
  const [en, ko] = await Promise.all([
    ensureTemplateVersion({
      templateKey: ACCOUNT_WELCOME_TEMPLATE,
      language: "en",
    }),
    ensureTemplateVersion({
      templateKey: ACCOUNT_WELCOME_TEMPLATE,
      language: "ko",
    }),
  ]);

  // One template, because the key is the same...
  assert.equal(en.templateId, ko.templateId);
  // ...and two versions, because the copy differs per language. A fix that
  // collapsed the race by collapsing the versions would break the thing the
  // registry exists for.
  assert.notEqual(en.templateVersionId, ko.templateVersionId);
});

test("two callers bootstrapping the policy version at once both get the same row", async () => {
  const [first, second] = await Promise.all([
    ensureBootstrapPolicyVersion(),
    ensureBootstrapPolicyVersion(),
  ]);

  assert.equal(first, second);
  assert.equal(await prisma.emailPolicyVersion.count(), 1);
});

test("a genuine failure is not swallowed by the race handling", async () => {
  // The read-back only answers when the row the winner wrote is the row this
  // caller wanted. An unknown template key never reaches the upsert at all --
  // it is refused while resolving the definition -- so the recovery path has no
  // way to turn a real error into a silent success.
  await assert.rejects(
    () =>
      ensureTemplateVersion({
        templateKey: "no_such_template_key",
        language: "en",
      }),
    /no_such_template_key|template/i
  );

  assert.equal(await prisma.emailTemplate.count(), 0);
});
