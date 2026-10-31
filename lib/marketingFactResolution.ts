/**
 * Resolving the facts a draft is judged against.
 *
 * Contract: docs/policy/marketing-automation.md §7.2. The one file allowed to
 * call `sealMarketingFacts()`, which is checked by
 * `scripts/check-protected-table-writers.mjs` the way the template seal is --
 * a `WeakSet` says an object came from that function and says nothing about
 * who called it.
 *
 * What it does is read the registries this file does not own
 * (`lib/marketingClaims.ts`, `lib/marketingAssets.ts`) and ask them, rather
 * than letting a caller assert the answers. The Guard used to take `known`,
 * `featurePublic` and `priceSourcesAllStored` from whoever called it, so a
 * claim id that is in no registry at all could be declared true and carried to
 * `autonomous_eligible`.
 *
 * **Usage is a database fact.** Whether an account has published a claim
 * before is read from `MarketingPost` for the named account. A caller names
 * the account and locale whose question is being asked; it never supplies the
 * answer.
 *
 * **One client, one clock, rows held** (S3 plan, S3a2). Every database read
 * here -- the gates, the plans, the catalogue's provenance, the model rows and
 * the usage -- goes through the client the caller passes, which for a write is
 * its transaction, and "today" is the database's clock read through the same
 * client. The rows read become the post's fact snapshot, so what a decision
 * rested on is recorded with it rather than re-read later.
 *
 * A transaction at READ COMMITTED -- the intake's, deliberately, because its
 * read-back and its ledger writes must see what committed while it waited for
 * the audit chain lock -- gives each statement its own snapshot. So the rows a
 * price or model fact rests on are locked FOR SHARE before they are read, and
 * **only a row the lock actually took counts.** A locked row cannot change or
 * go until the caller commits; a row that was not there when the lock ran was
 * not locked, so if a later read sees it -- inserted in between -- it is
 * treated as still absent, which is the refusing answer (no plan row is a
 * compiled default, no catalogue row is not stored, no model row is no model).
 * The facts are therefore the held rows as they all stood at the last lock: one
 * moment that existed. Usage is read once and can only make a post less
 * eligible for autonomy, which a generated draft is refused anyway.
 */

import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Prisma } from "@prisma/client";

import {
  getBillingPlansWithFieldSources,
  type BillingPlanWithFieldSources,
} from "@/lib/billingConfig";
import {
  BILLING_PRICE_CATALOG_KEY,
  readBillingPriceCatalogSource,
  type BillingPriceCatalogSource,
} from "@/lib/billingPriceCatalog";
import {
  loadMarketingAssetRegistry,
  MARKETING_ASSET_REGISTRY_PATH,
  marketingAssetRegistrySchema,
  resolveMarketingAsset,
  type LoadedAssetRegistry,
} from "@/lib/marketingAssets";
import { readApprovedMarketingAssetRows } from "@/lib/marketingAssetStore";
import { resolveMarketingClaimGate } from "@/lib/marketingClaimGates";
import type {
  MarketingGuardAssetFact,
  MarketingGuardClaimFact,
  MarketingGuardFacts,
} from "@/lib/marketingFacts";
import { sealMarketingFacts } from "@/lib/marketingGuardCore";
import {
  MARKETING_CLAIM_REGISTRY_VERSION,
  marketingClaimById,
  resolveMarketingClaim,
} from "@/lib/marketingClaims";
import {
  MARKETING_LOCALES,
  type MarketingFactSnapshot,
  type MarketingLocale,
} from "@/lib/marketingAutomationSchema";
import { resolveMarketingPageEvidence } from "@/lib/marketingEvidencePages";
import {
  catalogueClaimSourceDecision,
  modelClaimDecision,
  priceClaimSourceDecision,
} from "@/lib/marketingFactSources";
import { registryRowToModel } from "@/lib/modelRegistry";

/**
 * Whether a string is one of the four locales this system knows.
 *
 * Small enough to inline, kept as a named predicate because the call site is
 * the difference between checking a value and asserting it away.
 */
const isMarketingLocale = (value: string): value is MarketingLocale =>
  (MARKETING_LOCALES as readonly string[]).includes(value);

/** Everything this file reads, through one client: the caller's transaction. */
export type MarketingFactDatabase = Pick<
  Prisma.TransactionClient,
  "marketingPost" | "billingPlan" | "appSetting" | "modelRegistryEntry" | "$queryRaw"
>;

/**
 * What a caller may say: which ids, and which post they are for.
 *
 * Not the answers. The first version took `on`, `gates`, `claimsUsedBefore`
 * and the rest from whoever called it, which meant an expired claim could be
 * resolved on a date it was still valid, a gated one on a gate somebody said
 * was open, and a first use on a history somebody said had happened. A caller
 * naming the scope is naming the question; a caller naming the gate is
 * answering it.
 */
export type MarketingFactRequest = {
  readonly claimIds: readonly string[];
  readonly assetIds: readonly string[];
  /** The account the post is for, which is whose history "used before" is. */
  readonly channelId: string;
  /** The platform whose asset allowlist and disclosure rules apply. */
  readonly channel: string;
  readonly locale: string;
  /** The digest of the fact snapshot the post will store, or `null`. */
  readonly factSnapshotDigest: string | null;
};

/**
 * What a claim's gate is, from its production reader rather than a caller.
 *
 * One at a time: a transaction runs one statement at a time anyway, and a
 * fixed order makes the statement count the tests measure the same every run.
 */
async function readGates(
  database: MarketingFactDatabase,
  gateKeys: readonly string[],
): Promise<Map<string, boolean | null>> {
  const gates = new Map<string, boolean | null>();
  for (const key of [...new Set(gateKeys)].sort()) {
    gates.set(key, await resolveMarketingClaimGate(key, database));
  }
  return gates;
}

/** Which rows a hold took: only these may answer a fact. */
export type HeldMarketingFactRows = {
  readonly planIds: ReadonlySet<string>;
  readonly catalogue: boolean;
  readonly modelIds: ReadonlySet<string>;
};

/**
 * Lock the rows a fact is about to be read from, until the caller commits, and
 * say which rows were there to lock.
 *
 * FOR SHARE: other readers go on, a writer waits. Outside a transaction (a
 * caller passing the client itself) the lock lasts one statement and holds
 * nothing, which is what such a caller asked for.
 */
export async function holdMarketingFactRows(
  database: MarketingFactDatabase,
  rows: { readonly plans: boolean; readonly catalogue: boolean; readonly modelIds: readonly string[] },
): Promise<HeldMarketingFactRows> {
  const planIds = rows.plans
    ? (await database.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BillingPlan" ORDER BY "id" FOR SHARE`).map(
        (row) => row.id,
      )
    : [];
  const catalogue = rows.catalogue
    ? (
        await database.$queryRaw<Array<{ key: string }>>`SELECT "key" FROM "AppSetting" WHERE "key" = ${BILLING_PRICE_CATALOG_KEY} FOR SHARE`
      ).length === 1
    : false;
  const modelIds =
    rows.modelIds.length > 0
      ? (
          await database.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ModelRegistryEntry" WHERE "id" = ANY(${[...rows.modelIds]}::text[]) ORDER BY "id" FOR SHARE`
        ).map((row) => row.id)
      : [];
  return { planIds: new Set(planIds), catalogue, modelIds: new Set(modelIds) };
}

/** The database's "now", read through the same client as the facts. */
async function readDatabaseClock(database: MarketingFactDatabase): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The database clock did not return a timestamp");
  }
  return now;
}

type ModelRow = { readonly model: ReturnType<typeof registryRowToModel>; readonly updatedAt: string };

/**
 * The registry row a model claim is about, or `null` when there is none.
 *
 * Read by id through the caller's client. The runtime reader the chat uses
 * seeds missing rows and reads the whole table on its own connection, neither
 * of which a fact read inside a write may do; a row this cannot parse is no
 * model, which the claim decision already refuses.
 */
async function readModelRow(database: MarketingFactDatabase, modelId: string): Promise<ModelRow | null> {
  const row = await database.modelRegistryEntry.findUnique({ where: { id: modelId } });
  if (!row) return null;
  try {
    return { model: registryRowToModel(row), updatedAt: row.updatedAt.toISOString() };
  } catch {
    return null;
  }
}

/**
 * The store's digest of a fact snapshot: keys sorted at every level, SHA-256.
 * Takes the stored JSON as it is, so a post's snapshot is digested exactly as
 * the store digests it when it checks a decision against the row.
 */
export function marketingFactSnapshotDigest(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(snapshot)), "utf8").digest("hex");
}

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

const byRowId = (left: { rowId: string }, right: { rowId: string }) =>
  left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0;

/**
 * The asset registry in force, or `null` when it is missing or invalid.
 *
 * The hand-kept file, and -- given the caller's client -- the images and
 * videos a person approved in Admin (lib/marketingAssetStore.ts, operator
 * decision 2026-10-31), held FOR SHARE so a retirement waits for a decision read
 * against them. An id in both is the file's. The version is the file's plus
 * the store's, each only ever rising, so a post records a version that moves
 * whenever either list does.
 *
 * Shared with the generator's context, which lists the assets a draft may
 * name from the same registry the Guard judges them against.
 */
export const readMarketingAssetRegistry = async (
  db?: Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<LoadedAssetRegistry | null> => {
  try {
    const raw = JSON.parse(
      await readFile(resolve(process.cwd(), MARKETING_ASSET_REGISTRY_PATH), "utf8"),
    ) as unknown;
    if (!db) return loadMarketingAssetRegistry(raw);
    const file = marketingAssetRegistrySchema.parse(raw);
    const stored = await readApprovedMarketingAssetRows(db);
    const fileIds = new Set(file.assets.map((asset) => asset.id));
    return loadMarketingAssetRegistry({
      version: file.version + stored.version,
      assets: [...file.assets, ...stored.assets.filter((asset) => !fileIds.has(asset.id))],
    });
  } catch {
    // A missing, unreadable or invalid registry makes every asset unknown.
    return null;
  }
};

/**
 * Which of these claims and assets this account has published before.
 *
 * Read from the posts table, because that is where it is. A caller that could
 * say "used before" could turn every first use into a repeat and skip the
 * approval §7.4 asks for.
 */
async function readUsage(
  database: MarketingFactDatabase,
  channelId: string,
): Promise<{ claims: Set<string>; assets: Set<string> }> {
  const rows = await database.marketingPost.findMany({
    where: { channelId, status: { in: ["published", "verified"] } },
    select: { claimIds: true, assetIds: true },
  });
  const claims = new Set<string>();
  const assets = new Set<string>();
  for (const row of rows) {
    for (const id of row.claimIds) claims.add(id);
    for (const id of row.assetIds) assets.add(id);
  }
  return { claims, assets };
}

type ResolvedMarketingFacts = {
  readonly request: MarketingFactRequest;
  readonly claims: readonly MarketingGuardClaimFact[];
  readonly assets: readonly MarketingGuardAssetFact[];
  readonly assetRegistryVersion: number;
  readonly factSnapshot: MarketingFactSnapshot;
};

/**
 * Ask the registries and the database, and seal the answer against the
 * snapshot the post already stores.
 *
 * For re-judging a post that exists -- an edit keeps the post's snapshot,
 * because the store's edit writer records new words, not new evidence. A new
 * draft uses `resolveMarketingFactsWithSnapshot()`, which records the rows it
 * read.
 *
 * A claim the registry does not have resolves to `known: false`, which the
 * Guard refuses -- rather than being absent, which it would not notice.
 */
export async function resolveMarketingFacts(
  database: MarketingFactDatabase,
  rawRequest: MarketingFactRequest,
): Promise<MarketingGuardFacts> {
  const resolved = await readMarketingFacts(database, rawRequest);
  return seal(resolved, resolved.request.factSnapshotDigest);
}

/**
 * Ask the registries and the database, record which rows answered, and seal
 * the answer against that record.
 *
 * The snapshot is what the post stores: the plan rows a price claim rested on,
 * the catalogue's provenance, the model rows, and a digest of each page
 * statement used as evidence. Its digest is the one the Guard's decision is
 * bound to, so the store refuses to record this decision with any other
 * snapshot.
 */
export async function resolveMarketingFactsWithSnapshot(
  database: MarketingFactDatabase,
  rawRequest: Omit<MarketingFactRequest, "factSnapshotDigest">,
): Promise<{ readonly facts: MarketingGuardFacts; readonly factSnapshot: MarketingFactSnapshot }> {
  const resolved = await readMarketingFacts(database, { ...rawRequest, factSnapshotDigest: null });
  return {
    facts: seal(resolved, marketingFactSnapshotDigest(resolved.factSnapshot)),
    factSnapshot: resolved.factSnapshot,
  };
}

function seal(resolved: ResolvedMarketingFacts, factSnapshotDigest: string | null): MarketingGuardFacts {
  return sealMarketingFacts({
    channelId: resolved.request.channelId,
    channel: resolved.request.channel,
    locale: resolved.request.locale,
    claims: resolved.claims,
    assets: resolved.assets,
    claimRegistryVersion: MARKETING_CLAIM_REGISTRY_VERSION,
    assetRegistryVersion: resolved.assetRegistryVersion,
    factSnapshotDigest,
  });
}

async function readMarketingFacts(
  database: MarketingFactDatabase,
  rawRequest: MarketingFactRequest,
): Promise<ResolvedMarketingFacts> {
  // The ids name the lookups and the scope names where those answers apply.
  // Snapshot both before the first await so an accessor cannot make the
  // resolver read channel A and then seal the answers as channel B.
  const request: MarketingFactRequest = {
    claimIds: [...rawRequest.claimIds].map(String),
    assetIds: [...rawRequest.assetIds].map(String),
    channelId: String(rawRequest.channelId),
    channel: String(rawRequest.channel),
    locale: String(rawRequest.locale),
    factSnapshotDigest:
      rawRequest.factSnapshotDigest === null
        ? null
        : String(rawRequest.factSnapshotDigest),
  };
  const on = await readDatabaseClock(database);
  const registryClaims = request.claimIds.map((id) => marketingClaimById(id));
  const gateKeys = registryClaims
    .map((claim) => claim?.gate)
    .filter((gate): gate is string => typeof gate === "string");

  const needsPlans = registryClaims.some(
    (claim) => claim?.factSource?.kind === "billing_plan",
  );
  const needsCatalogue = registryClaims.some(
    (claim) => claim?.factSource?.kind === "localized_catalogue",
  );

  const modelIds = [
    ...new Set(
      registryClaims.flatMap((claim) =>
        claim?.factSource?.kind === "model_registry" ? [claim.factSource.modelId] : [],
      ),
    ),
  ].sort();

  // In a fixed order, through the one client: the rows held first, then read.
  const held = await holdMarketingFactRows(database, { plans: needsPlans, catalogue: needsCatalogue, modelIds });
  const gates = await readGates(database, gateKeys);
  const usage = await readUsage(database, request.channelId);
  const plans: BillingPlanWithFieldSources[] = needsPlans
    ? await getBillingPlansWithFieldSources(database)
    : [];
  // A catalogue row the hold did not take is not read: absent then, absent now.
  const catalogue: { source: BillingPriceCatalogSource; updatedAt: string | null } | null = !needsCatalogue
    ? null
    : held.catalogue
      ? await readBillingPriceCatalogSource(database)
      : { source: "default_row_missing", updatedAt: null };
  const modelRows = new Map<string, ModelRow | null>();
  for (const modelId of modelIds) {
    modelRows.set(modelId, held.modelIds.has(modelId) ? await readModelRow(database, modelId) : null);
  }
  // Always: the registry version a post records is the one in force, whether
  // or not this draft names an asset, and the table refuses a version of 0.
  const assetRegistry = await readMarketingAssetRegistry(database);

  // What the decision rested on, collected as each claim is resolved.
  const priceRows = new Map<string, string>();
  const modelRegistryRows = new Map<string, string>();
  const evidenceDigests = new Set<string>();
  let catalogueUsed = false;

  const claims = request.claimIds.map((claimId) => {
    const registryClaim = marketingClaimById(claimId);
    const resolution = resolveMarketingClaim({
      id: claimId,
      locale: request.locale,
      on,
      gateEnabled: registryClaim?.gate
        ? (gates.get(registryClaim.gate) ?? null)
        : undefined,
    });

    if (!resolution.ok) {
      return {
        claimId,
        type: "unknown",
        known: false,
        usedBefore: usage.claims.has(claimId),
      };
    }

    const claim = resolution.claim;
    const fact = {
      claimId,
      type: claim.type,
      known: true,
      statesCreditAllowance: claim.planMeaning === "credit_allowance",
      usedBefore: usage.claims.has(claimId),
    };

    if (claim.type === "pricing" || claim.type === "plan") {
      const factSource = claim.factSource;
      if (factSource?.kind === "billing_plan") {
        const found = plans.find((entry) => entry.plan.id === factSource.planId);
        // A plan row the hold did not take -- inserted after it -- is no row.
        const plan = found?.row && held.planIds.has(found.row.id) ? found : undefined;
        if (plan?.row) priceRows.set(plan.row.id, plan.row.updatedAt);
        const decision = plan
          ? priceClaimSourceDecision(
              factSource.fields.map((field) => ({
                field,
                source: plan.sources[field],
              })),
            )
          : { ok: false as const };
        return {
          ...fact,
          priceSourcesAllStored: decision.ok,
          currency: plan?.plan.currency,
          targetsAustralia: factSource.targetsAustralia,
        };
      }
      if (factSource?.kind === "localized_catalogue") {
        catalogueUsed = true;
        const decision = catalogue
          ? catalogueClaimSourceDecision(catalogue.source)
          : { ok: false as const };
        return {
          ...fact,
          priceSourcesAllStored: decision.ok,
          currency: factSource.currency,
          targetsAustralia: factSource.targetsAustralia,
        };
      }
      return { ...fact, priceSourcesAllStored: false };
    }

    if (claim.type === "model") {
      const factSource = claim.factSource;
      if (factSource?.kind !== "model_registry") {
        return { ...fact, modelMatches: false };
      }
      const row = modelRows.get(factSource.modelId) ?? null;
      if (row) modelRegistryRows.set(factSource.modelId, row.updatedAt);
      const model = row?.model ?? null;
      return {
        ...fact,
        modelMatches: modelClaimDecision({
          model,
          claimedMinimumPlan: factSource.minimumPlan ?? undefined,
        }).ok,
      };
    }

    if (claim.type === "feature" || claim.type === "availability") {
      if (claim.evidence?.kind !== "page") {
        return { ...fact, featurePublic: false };
      }
      // Checked rather than asserted. `request.locale` is a `string` by
      // construction (`String(rawRequest.locale)`), and the resolver wants one
      // of the four. A locale outside them has no page to be evidence, which
      // is the answer below; `as never` reached the same place by telling the
      // compiler not to look.
      if (!isMarketingLocale(request.locale)) {
        return { ...fact, featurePublic: false };
      }
      const evidence = resolveMarketingPageEvidence({
        pageRoute: claim.evidence.pageRoute,
        localeKey: claim.evidence.localeKey,
        locale: request.locale,
      });
      if (!evidence.ok) return { ...fact, featurePublic: false };
      evidenceDigests.add(createHash("sha256").update(evidence.text, "utf8").digest("hex"));
      return { ...fact, featurePublic: true, evidenceStatement: evidence.text };
    }

    if (claim.type === "comparison") {
      return {
        ...fact,
        comparisonEvidence:
          claim.evidence?.kind === "external" &&
          claim.evidence.url.length > 0 &&
          claim.evidence.scope.length > 0,
      };
    }

    return fact;
  });

  const assets = request.assetIds.map((assetId) => {
    const resolution = assetRegistry
      ? resolveMarketingAsset({
          id: assetId,
          channel: request.channel,
          locale: request.locale,
          on,
          registry: assetRegistry,
        })
      : { ok: false as const };
    return {
      assetId,
      known: resolution.ok,
      usedBefore: usage.assets.has(assetId),
    };
  });

  const factSnapshot: MarketingFactSnapshot = {
    priceRows: [...priceRows].map(([rowId, updatedAt]) => ({ rowId, updatedAt })).sort(byRowId),
    // No row is nothing to point at, and the claim that asked is refused for
    // resting on the compiled default; a timestamp made up for it would say a
    // row was read. A row that exists but does not parse is recorded as the
    // compiled default it serves, with that row's own updatedAt -- the same
    // pairing the billing reader reports.
    catalogue:
      catalogueUsed && catalogue?.updatedAt
        ? {
            source: catalogue.source === "stored" ? "stored_row" : "compiled_default",
            updatedAt: catalogue.updatedAt,
          }
        : null,
    modelRegistryRows: [...modelRegistryRows]
      .map(([rowId, updatedAt]) => ({ rowId, updatedAt }))
      .sort(byRowId),
    evidenceDigests: [...evidenceDigests].sort(),
  };

  return {
    request,
    claims,
    assets,
    assetRegistryVersion: assetRegistry?.version ?? 0,
    factSnapshot,
  };
}
