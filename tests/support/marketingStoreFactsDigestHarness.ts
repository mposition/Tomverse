import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  guardDraft,
  sealMarketingFacts,
  sealMarketingGuardContext,
} from "@/lib/marketingGuardCore";
import {
  createMarketingPost,
  marketingEnvelopeDigest,
} from "@/lib/marketingStore";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
};

const factSnapshot = {
  priceRows: [],
  catalogue: null,
  modelRegistryRows: [],
  evidenceDigests: [],
};
const factSnapshotDigest = createHash("sha256")
  .update(JSON.stringify(canonical(factSnapshot)), "utf8")
  .digest("hex");
const postEnvelope = {
  channel: "linkedin" as const,
  accountSlug: "linkedin-1",
  locale: "en" as const,
  renderedText: "One view of the workspace.",
  claimIds: [],
  assets: [{ assetId: "asset.hero", altKey: "asset.hero.alt" }],
  finalUrl: null,
  scheduledAt: null,
  disclosureFlags: ["advertising" as const],
};
const context = sealMarketingGuardContext({
  priceFallbackAlertReady: false,
  incidentOrSecurity: "unreadable",
  testimonial: "unreadable",
  legalOrPolicy: "unreadable",
});
const decision = (known: boolean) =>
  guardDraft({
    draft: {
      renderedText: postEnvelope.renderedText,
      locale: "en",
      channel: "linkedin",
      channelId: "channel-1",
      claimIds: [],
      assetIds: ["asset.hero"],
    },
    facts: sealMarketingFacts({
      channelId: "channel-1",
      channel: "linkedin",
      locale: "en",
      claims: [],
      assets: [{ assetId: "asset.hero", known, usedBefore: true }],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshotDigest,
    }),
    templates: [],
    context,
  });

const writes: Array<Record<string, unknown>> = [];
const database = {
  marketingChannel: {
    findUnique: async () => ({
      accountSlug: "linkedin-1",
      channel: "linkedin",
    }),
  },
  marketingPost: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      return data;
    },
  },
};
const envelopeDigest = marketingEnvelopeDigest(postEnvelope);
const write = (guardDecision: ReturnType<typeof decision>, suffix: string) =>
  createMarketingPost(database as never, {
    channelId: "channel-1",
    locale: "en",
    kind: "social",
    logicalKey: `post-${suffix}`,
    envelope: postEnvelope,
    envelopeDigest,
    rendererVersion: "r1",
    templateId: null,
    templateDigest: null,
    claimIds: [],
    assetIds: ["asset.hero"],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshot,
    decision: guardDecision,
    draftedAt: new Date("2026-09-21T01:00:00.000Z"),
  });

async function main() {
  const unknown = decision(false);
  const known = decision(true);
  await write(unknown, "unknown");
  await write(known, "known");

  assert.notEqual(unknown.factsDigest, known.factsDigest);
  assert.equal(writes[0]?.factsDigest, unknown.factsDigest);
  assert.equal(writes[1]?.factsDigest, known.factsDigest);
  process.stdout.write("MARKETING_STORE_FACTS_DIGEST_OK\n");
}

void main();
