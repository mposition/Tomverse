import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  listWaveRecipients,
  WAVE_RECIPIENT_PAGE_MAX,
} from "@/lib/adminEmailCampaigns";
import { revealEmailAddresses } from "@/lib/adminEmailAddressReveal";
import { ADDRESS_REVEAL_MAX_IDS, MASK_CHARACTER } from "@/lib/emailAddressMaskingCore";
import { prisma } from "@/lib/prisma";

// The people behind the expansion ledger's counts, under D10's rule.
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21 (D10)
// and .github/audits/model-lifecycle-email-2026-08-22.md §44 (the ledger).
//
// What needs a database: the masking has to happen on the way *out of the
// query*, not at the edge, and the only way to show that is to write a row with
// a real address and read it back through the function a route would call.
// Paging and the campaign/wave scoping are likewise properties of the query.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignRecipient", "EmailCampaignWave", "EmailCampaign",
      "EmailDelivery", "EmailEvent", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
});

after(async () => {
  await prisma.$disconnect();
});

const campaignWithWave = async (input?: { dryRun?: boolean }) => {
  const campaign = await prisma.emailCampaign.create({
    data: {
      category: "model_retirement",
      templateKey: "model_launch",
      locales: ["en"],
      audienceSpec: {},
      createdByEmail: "owner@example.test",
    },
    select: { id: true },
  });
  const wave = await prisma.emailCampaignWave.create({
    data: {
      campaignId: campaign.id,
      kind: "launch",
      sequence: 1,
      dryRun: input?.dryRun ?? false,
    },
    select: { id: true },
  });
  return { campaignId: campaign.id, waveId: wave.id };
};

let seq = 0;
const ledgerRow = async (input: {
  campaignId: string;
  waveId: string;
  address?: string | null;
  excludedReason?: string | null;
  eligibilityReason?: string | null;
  malformed?: boolean;
  withDelivery?: boolean;
}) => {
  seq += 1;
  const address =
    "address" in input ? input.address : `person-${seq}@example.test`;
  const user = await prisma.user.create({
    data: { email: `account-${seq}@example.test` },
    select: { id: true },
  });
  return prisma.emailCampaignRecipient.create({
    data: {
      campaignId: input.campaignId,
      waveId: input.waveId,
      userId: user.id,
      emailAddress: address ?? null,
      language: "en",
      excludedReason: input.excludedReason ?? null,
      eligibilityReason:
        "eligibilityReason" in input ? input.eligibilityReason : "default_model",
      malformed: input.malformed ?? false,
    },
    select: { id: true },
  });
};

test("the address is masked before it leaves the query", async () => {
  const { campaignId, waveId } = await campaignWithWave();
  await ledgerRow({ campaignId, waveId, address: "confidential@example.test" });

  const page = await listWaveRecipients({ campaignId, waveId });
  assert.equal(page.rows.length, 1);
  const [row] = page.rows;

  // The identifying half is gone and the operational half is kept.
  assert.equal(row.emailAddressMasked, `c${MASK_CHARACTER.repeat(3)}l@example.test`);
  // And the raw value is not reachable through the row at all: the field is
  // absent from the type, so this is the runtime half of that guarantee.
  assert.ok(!("emailAddress" in row));
  assert.ok(!JSON.stringify(page).includes("confidential"));
});

test("a ledger row with no address reports null rather than dots", async () => {
  // `no_email` is why somebody was excluded. Rendering a mask for them would
  // say an address is being withheld from the operator when there is none.
  const { campaignId, waveId } = await campaignWithWave();
  await ledgerRow({
    campaignId,
    waveId,
    address: null,
    excludedReason: "no_email",
  });

  const [row] = (await listWaveRecipients({ campaignId, waveId })).rows;
  assert.equal(row.emailAddressMasked, null);
  assert.equal(row.excludedReason, "no_email");
});

test("the ledger says whether a delivery row exists, never which one", async () => {
  const { campaignId, waveId } = await campaignWithWave();
  await ledgerRow({ campaignId, waveId });

  const [row] = (await listWaveRecipients({ campaignId, waveId })).rows;
  // Nothing wrote a delivery for this row, so the answer is false rather than
  // absent.
  assert.equal(row.hasDelivery, false);
  assert.ok(!("deliveryId" in row));
});

test("rows are scoped to their own campaign and wave", async () => {
  const first = await campaignWithWave();
  const second = await campaignWithWave();
  await ledgerRow({ ...first, address: "mine@example.test" });
  await ledgerRow({ ...second, address: "theirs@example.test" });

  // Asking with one campaign's id and the other's wave must be empty, not a
  // refusal: there is no branch that could tell the two apart, which is the
  // same reason the reveal scopes by id and the route decides who may call it.
  const crossed = await listWaveRecipients({
    campaignId: first.campaignId,
    waveId: second.waveId,
  });
  assert.deepEqual(crossed.rows, []);

  const mine = await listWaveRecipients(first);
  assert.equal(mine.rows.length, 1);
  assert.ok(mine.rows[0].emailAddressMasked?.endsWith("@example.test"));
});

test("a page stops at its limit and hands back a cursor", async () => {
  const { campaignId, waveId } = await campaignWithWave();
  for (let index = 0; index < 5; index += 1) {
    await ledgerRow({ campaignId, waveId });
  }

  const first = await listWaveRecipients({ campaignId, waveId, limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.equal(first.limit, 2);
  assert.ok(first.nextCursor);

  const second = await listWaveRecipients({
    campaignId,
    waveId,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.rows.length, 2);
  // The cursor row itself is skipped, so the pages do not overlap. An overlap
  // would make a reveal cover a row twice and the audit count wrong.
  const ids = new Set([...first.rows, ...second.rows].map((row) => row.id));
  assert.equal(ids.size, 4);

  const last = await listWaveRecipients({
    campaignId,
    waveId,
    limit: 2,
    cursor: second.nextCursor,
  });
  assert.equal(last.rows.length, 1);
  assert.equal(last.nextCursor, null, "the final page must not offer another");
});

test("a page can never be larger than one reveal covers", async () => {
  // The two numbers are one number on purpose: a screen holding more rows than
  // a reveal covers offers a button that fails on an ordinary-looking page.
  assert.equal(WAVE_RECIPIENT_PAGE_MAX, ADDRESS_REVEAL_MAX_IDS);

  const { campaignId, waveId } = await campaignWithWave();
  await ledgerRow({ campaignId, waveId });
  const page = await listWaveRecipients({
    campaignId,
    waveId,
    limit: ADDRESS_REVEAL_MAX_IDS + 50,
  });
  assert.equal(page.limit, ADDRESS_REVEAL_MAX_IDS);
});

test("the reveal reads the campaign ledger's own table", async () => {
  const { campaignId, waveId } = await campaignWithWave();
  const row = await ledgerRow({
    campaignId,
    waveId,
    address: "revealed@example.test",
  });

  const addresses = await revealEmailAddresses({
    kind: "campaign_recipient",
    ids: [row.id],
  });
  assert.deepEqual(addresses, { [row.id]: "revealed@example.test" });

  // An id from this table is not an id in the other two. A kind that read the
  // wrong table would return nothing and look like a permission problem.
  assert.deepEqual(
    await revealEmailAddresses({ kind: "delivery", ids: [row.id] }),
    {}
  );
});

test("the reveal never returns more than its cap, whatever it is asked for", async () => {
  const { campaignId, waveId } = await campaignWithWave();
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push((await ledgerRow({ campaignId, waveId })).id);
  }

  // Duplicates collapse before the cap applies, so a caller cannot spend its
  // budget on the same row and make the audit count meaningless.
  const addresses = await revealEmailAddresses({
    kind: "campaign_recipient",
    ids: [...ids, ...ids],
  });
  assert.equal(Object.keys(addresses).length, 5);
});
