export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  codingSettingsSchema,
  fillLinkCapabilities,
  linkAllChatModels,
  linkChatModel,
  saveCodingSettings,
  unlinkCodingModel,
} from "@/lib/codingCatalogAdmin";
import {
  codingCreditFloor,
  judgeCoding,
  latestCodingSnapshot,
  loadChatModelFacts,
  loadCodingCatalog,
  loadCodingProviderTerms,
  parseSnapshotRows,
  publishCodingSnapshot,
  servableCodingRows,
} from "@/lib/modelCatalog";
import { codingApiCreditView } from "@/lib/codingRowRuntime";
import { CatalogRefusal } from "@/lib/modelCatalogAdmin";
import {
  CODING_CATALOG_EXTERNAL_CHANNELS_ENV,
  catalogContentHash,
  codingCandidateExclusion,
  codingCatalogExternalChannelsEnabled,
  codingProfileSchema,
  DEFAULT_CODING_CAPABILITY_SOURCES,
  defaultPriceSources,
  MODEL_ID_PATTERN,
  OFFICIAL_SOURCE_HOSTS,
  snapshotIsCurrent,
  snapshotPendingChanges,
} from "@/lib/modelCatalogCore";
import { MODEL_CATALOG_BENCHMARK_SEARCH_MODEL_ENV, MODEL_CATALOG_DRAFT_LLM_MODEL_ENV } from "@/lib/modelCatalogDraftLlm";
import { AI_PROVIDERS } from "@/lib/modelRegistryShared";

// The coding catalogue's own surface (Admin > Models > Coding catalog): chat
// links (one, or all candidates at once, with no LLM call) and the Code
// snapshot. Turning a model on or holding it, and a dedicated model's
// whole-profile draft, stay on /api/admin/model-catalog so one writer judges
// every activation.

const refusalResponse = (error: unknown) => {
  if (error instanceof CatalogRefusal) {
    return NextResponse.json({ error: error.code, reasons: error.reasons }, { status: error.status });
  }
  return apiSecurityResponse(error);
};

/** Providers a draft can read: known to the code, with official documentation hosts. */
const DRAFT_PROVIDERS = AI_PROVIDERS.filter((provider) => Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider));

const adminSession = async (write: boolean) => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "Not found." }, { status: 404 }) } as const;
  }
  if (write && !hasAdminPermission(session, "ops:write")) {
    return { response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) } as const;
  }
  return { session } as const;
};

/** A stored dedicated draft's floor and what the judge would say at its values, or null when it does not parse. */
const reviewCodingDraft = (draft: unknown) => {
  const parsed = codingProfileSchema.safeParse(draft);
  if (!parsed.success) return null;
  const admission = judgeCoding(parsed.data);
  return { floor: codingCreditFloor(parsed.data), reasons: admission.admitted ? [] : [...admission.reasons] };
};

export async function GET(req: Request) {
  try {
    const auth = await adminSession(false);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog", { minute: 30, day: 1_000 });

    const now = new Date();
    const [chat, providerTerms, snapshot] = await Promise.all([loadChatModelFacts(), loadCodingProviderTerms(), latestCodingSnapshot()]);
    const entries = await loadCodingCatalog(undefined, { context: { chat, providerTerms } });
    const chatById = new Map(chat.map((facts) => [facts.id, facts]));

    const codingIds = new Set(entries.map((entry) => entry.modelId));
    const eligible: typeof chat = [];
    const excluded: { id: string; name: string; provider: string; reason: string }[] = [];
    for (const facts of chat) {
      const reason = codingCandidateExclusion(facts, codingIds);
      if (reason === null) eligible.push(facts);
      // A deleted model or one already linked is not worth listing as "left out".
      else if (reason !== "already_in_catalog" && reason !== "deleted") excluded.push({ id: facts.id, name: facts.name, provider: facts.provider, reason });
    }

    const current = servableCodingRows(entries);
    const published = snapshot ? parseSnapshotRows(snapshot.models) : [];

    return NextResponse.json({
      models: entries.map((entry) => {
        const linked = entry.source === "chat" ? (entry.stored as { registryModelId?: string } | null)?.registryModelId : undefined;
        return {
          ...entry,
          // The floor the judge holds the credit weight to, at the resolved prices.
          floor: entry.profile ? codingCreditFloor(entry.profile) : null,
          // A dedicated row's coding API credits: the chat rule's minimum or its override, as a request is charged.
          apiCredit: entry.source === "dedicated" && entry.profile ? codingApiCreditView(entry.profile) : null,
          draftReview: reviewCodingDraft(entry.draft),
          chat: linked ? (chatById.get(linked) ?? null) : null,
        };
      }),
      candidates: { eligible, excluded },
      snapshot: snapshot
        ? {
            version: snapshot.version,
            contentHash: snapshot.contentHash,
            coverageUntil: snapshot.coverageUntil,
            publishedAt: snapshot.publishedAt,
            modelCount: snapshot.models.length,
            current: snapshotIsCurrent(snapshot.coverageUntil, now),
            pendingChanges: snapshotPendingChanges(published, current),
            // The scheduled renewal extends only identical content: a snapshot
            // published before rows named their source and channels hashes
            // differently even when nothing else changed.
            contentHashMatches: catalogContentHash(current) === snapshot.contentHash,
          }
        : null,
      servableCount: current.length,
      externalChannels: {
        enabled: codingCatalogExternalChannelsEnabled(process.env),
        env: CODING_CATALOG_EXTERNAL_CHANNELS_ENV,
      },
      draftLlm: {
        configured: Boolean(process.env[MODEL_CATALOG_DRAFT_LLM_MODEL_ENV]?.trim()),
        env: MODEL_CATALOG_DRAFT_LLM_MODEL_ENV,
      },
      // "Fill capabilities with the LLM" (one paid call per row): needs the draft model, and pages for the provider.
      capabilityFill: {
        configured: Boolean(process.env[MODEL_CATALOG_DRAFT_LLM_MODEL_ENV]?.trim()),
        env: MODEL_CATALOG_DRAFT_LLM_MODEL_ENV,
        providers: Object.keys(DEFAULT_CODING_CAPABILITY_SOURCES),
        // One search call more per fill for the provider's benchmark pages (off unless a Perplexity model is named).
        benchmarkSearch: {
          configured: Boolean(process.env[MODEL_CATALOG_BENCHMARK_SEARCH_MODEL_ENV]?.trim()),
          env: MODEL_CATALOG_BENCHMARK_SEARCH_MODEL_ENV,
        },
      },
      // What the dedicated add form offers (a draft reads the price page).
      draftProviders: DRAFT_PROVIDERS.map((provider) => ({
        provider,
        defaultSources: defaultPriceSources(provider),
        hosts: OFFICIAL_SOURCE_HOSTS[provider] ?? [],
      })),
    });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog read failed." }, { status: 500 });
  }
}

const postBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), registryModelId: z.string().regex(MODEL_ID_PATTERN) }),
  z.object({ action: z.literal("link_all") }),
  // One row, one LLM call. A screen with many rows sends one request each.
  z.object({ action: z.literal("fill_capabilities"), modelId: z.string().regex(MODEL_ID_PATTERN) }),
  z.object({ action: z.literal("settings"), modelId: z.string().regex(MODEL_ID_PATTERN), settings: codingSettingsSchema }),
  z.object({ action: z.literal("unlink"), modelId: z.string().regex(MODEL_ID_PATTERN) }),
  z.object({ action: z.literal("publish_snapshot") }),
]);

export async function POST(req: Request) {
  try {
    const auth = await adminSession(true);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog-write", { minute: 20, day: 300 });
    const body = await readLimitedJson(req, 32 * 1024, postBodySchema);
    const session = auth.session;

    if (body.action === "settings") {
      const result = await saveCodingSettings({ modelId: body.modelId, settings: body.settings, session, request: req });
      return NextResponse.json({ ok: true, changes: result.changes });
    }
    if (body.action === "unlink") {
      await unlinkCodingModel({ modelId: body.modelId, session, request: req });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "publish_snapshot") {
      const result = await publishCodingSnapshot({ session, request: req });
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.action === "fill_capabilities") {
      const result = await fillLinkCapabilities({ modelId: body.modelId, session, request: req });
      return NextResponse.json({ ok: true, changes: result.changes, draft: result.draft });
    }
    if (body.action === "link_all") {
      return NextResponse.json({ ok: true, ...(await linkAllChatModels({ session, request: req })) });
    }

    // link: nothing is read or called; the registry already has what a link needs.
    await linkChatModel({ registryModelId: body.registryModelId, session, request: req });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog action failed." }, { status: 500 });
  }
}
