import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  ACCOUNT_WELCOME_TEMPLATE,
  MODEL_LAUNCH_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import {
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_MARKETING_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import {
  isEmailCampaignsEnabled,
  isEmailConsentReconfirmEnabled,
  isEmailMarketingEnabled,
} from "@/lib/appSettings";
import {
  CampaignsDisabledError,
  createCampaignDraft,
  runDueCampaignWaves,
} from "@/lib/emailCampaignService";
import { expandEmailEvent } from "@/lib/emailAudienceExpansion";
import { enqueueRefused, enqueueStandardEmail } from "@/lib/standardEmailLane";
import { prisma } from "@/lib/prisma";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// The three ADR flags, against the database that actually holds them (EM-05).
//
// Contract: docs/policy/email-notifications.md §15.2.
//
// What needs a database: the flags are `AppSetting` rows, the accessors read
// them, and the acceptance criterion is about a row *not* being created — which
// only the table can confirm. The pure rules are next door.

const PAYLOAD = { modelName: "Test", modelSummary: "s", ctaUrl: "https://x.test" };

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignRecipient", "EmailCampaignWave", "EmailCampaign",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "AppSetting", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
});

after(async () => {
  await prisma.$disconnect();
});

test("all three flags read as off when nobody has written a row", async () => {
  // The state this repository is actually in, and the state §15.2 asks for.
  assert.equal(await isEmailMarketingEnabled(), false);
  assert.equal(await isEmailCampaignsEnabled(), false);
  assert.equal(await isEmailConsentReconfirmEnabled(), false);
});

test("a value that is not exactly true reads as off", async () => {
  await prisma.appSetting.create({
    data: { key: EMAIL_MARKETING_FLAG_KEY, value: "TRUE" },
  });
  // A row exists and says something affirmative-looking. It is still off:
  // the direction that fails safely is the one where marketing does not send.
  assert.equal(await isEmailMarketingEnabled(), false);
});

test("EM-05's acceptance criterion: a refused marketing enqueue writes no row and says why", async () => {
  const result = await enqueueStandardEmail({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    emailAddress: "person@example.test",
    language: "en",
    payload: PAYLOAD,
  });

  assert.ok(enqueueRefused(result));
  assert.equal(result.refused, "marketing_disabled");
  assert.ok(result.message.length > 0);

  // Nothing at all, not even a skipped row: a message written now would sit in
  // the outbox waiting for a decision nobody has made.
  assert.equal(await prisma.emailDelivery.count(), 0);
  assert.equal(await prisma.emailEvent.count(), 0);
});

test("the refusal happens before the template is registered", async () => {
  await enqueueStandardEmail({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    emailAddress: "person@example.test",
    language: "en",
    payload: PAYLOAD,
  });

  // Order is flag, then template, then identity. A refusal that registered the
  // template first would leave a row describing copy nobody may send.
  assert.equal(
    await prisma.emailTemplate.count({ where: { key: MODEL_LAUNCH_TEMPLATE } }),
    0
  );
});

test("a non-marketing message is untouched by the marketing flag", async () => {
  const result = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: "person@example.test",
    language: "en",
    payload: { name: "A", ctaUrl: "https://x.test" },
  });

  // The flag is off and this still queues. A switch that could reach
  // transactional mail would be a second route to login codes not arriving.
  assert.ok(!enqueueRefused(result));
  assert.equal(await prisma.emailDelivery.count(), 1);
});

test("turning the flag on lets the same message through", async () => {
  await setEmailFeatureFlag(EMAIL_MARKETING_FLAG_KEY, true);

  const result = await enqueueStandardEmail({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    emailAddress: "person@example.test",
    language: "en",
    payload: PAYLOAD,
  });

  // The switch an operator would flip is the switch the code obeys. Sending is
  // still refused further down — no `MARKETING_EMAIL_FROM` — which is the
  // structural block this flag was added in front of, not in place of.
  assert.ok(!enqueueRefused(result));
  assert.equal(await prisma.emailDelivery.count(), 1);
});

test("the campaign fan-out is gated too, or the flag would be a lie", async () => {
  await setEmailFeatureFlag(EMAIL_MARKETING_FLAG_KEY, true);
  const queued = await enqueueStandardEmail({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    emailAddress: "person@example.test",
    language: "en",
    payload: PAYLOAD,
  });
  assert.ok(!enqueueRefused(queued));

  const user = await prisma.user.create({
    data: { email: "member@example.test" },
    select: { id: true },
  });
  const event = await prisma.emailEvent.create({
    data: {
      templateId: (
        await prisma.emailTemplate.findUniqueOrThrow({
          where: { key: MODEL_LAUNCH_TEMPLATE },
          select: { id: true },
        })
      ).id,
      kind: MODEL_LAUNCH_TEMPLATE,
      audienceKind: "user_segment",
      audienceSpec: { userIds: [user.id] },
      status: "pending",
      payload: PAYLOAD,
    },
    select: { id: true },
  });

  // A fan-out writes its delivery rows directly and never calls
  // `enqueueStandardEmail`, so a flag that only guarded that function would
  // leave this as an unguarded second route to the sends it was meant to stop.
  await setEmailFeatureFlag(EMAIL_MARKETING_FLAG_KEY, false);
  const outcome = await expandEmailEvent({ eventId: event.id });
  assert.ok("refused" in outcome);
  assert.equal(outcome.refused, "marketing_disabled");

  // Refused before the event moved, so nothing is left mid-expansion.
  const row = await prisma.emailEvent.findUniqueOrThrow({
    where: { id: event.id },
    select: { status: true },
  });
  assert.equal(row.status, "pending");
});

test("campaign actions are refused while the campaign feature is off", async () => {
  await assert.rejects(
    () =>
      createCampaignDraft({
        category: "model_retirement",
        templateKey: MODEL_LAUNCH_TEMPLATE,
        locales: ["en"],
        audienceSpec: {},
        createdByEmail: "owner@example.test",
      }),
    (error: unknown) => error instanceof CampaignsDisabledError
  );
  assert.equal(await prisma.emailCampaign.count(), 0);
});

test("the scheduler returns nothing rather than throwing when campaigns are off", async () => {
  // It rides the fifteen-minute cron beside unrelated work. An exception would
  // take that whole pass down over a switch being off, which is a normal state
  // and not a fault.
  assert.deepEqual(await runDueCampaignWaves(), []);
});

test("turning the campaign flag on lets a draft be created", async () => {
  await setEmailFeatureFlag(EMAIL_CAMPAIGNS_FLAG_KEY, true);
  const draft = await createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: {},
    createdByEmail: "owner@example.test",
  });
  assert.equal(draft.status, "draft");
});

test("the two flags are independent", async () => {
  await setEmailFeatureFlag(EMAIL_CAMPAIGNS_FLAG_KEY, true);

  // Campaigns on, marketing off: a model retirement notice is `service` and
  // goes out through the same waves, so the campaign machinery has to work
  // while marketing does not. One flag for both would either stop retirement
  // notices with marketing or start marketing with them.
  assert.equal(await isEmailCampaignsEnabled(), true);
  assert.equal(await isEmailMarketingEnabled(), false);

  const refused = await enqueueStandardEmail({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    emailAddress: "person@example.test",
    language: "en",
    payload: PAYLOAD,
  });
  assert.ok(enqueueRefused(refused));
  assert.equal(refused.refused, "marketing_disabled");
});
