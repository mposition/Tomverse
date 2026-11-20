export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  applyProviderTermsDraft,
  chatLinkRefusal,
  codingSettingsSchema,
  discardProviderTermsDraft,
  linkChatModel,
  saveCodingSettings,
  storeProviderTermsDraft,
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
import { CatalogRefusal } from "@/lib/modelCatalogAdmin";
import {
  CODING_CATALOG_EXTERNAL_CHANNELS_ENV,
  catalogContentHash,
  codingCandidateExclusion,
  codingCatalogExternalChannelsEnabled,
  codingProfileSchema,
  codingProviderTermsSchema,
  defaultPriceSources,
  MODEL_ID_PATTERN,
  OFFICIAL_SOURCE_HOSTS,
  providerTermsDueOn,
  providerTermsExpired,
  snapshotIsCurrent,
  snapshotPendingChanges,
} from "@/lib/modelCatalogCore";
import {
  catalogDraftLlmFromEnv,
  DraftRefusal,
  fetchOfficialPage,
  MAX_DRAFT_SOURCES,
  MODEL_CATALOG_DRAFT_LLM_MODEL_ENV,
} from "@/lib/modelCatalogDraftLlm";
import { AI_PROVIDERS } from "@/lib/modelRegistryShared";

// The coding catalogue's own surface (Admin > Models > Coding catalog): chat
// links, provider conditions and the Code snapshot. Turning a model on or
// holding it, and a dedicated model's whole-profile draft, stay on
// /api/admin/model-catalog so one writer judges every activation.

const refusalResponse = (error: unknown) => {
  if (error instanceof CatalogRefusal) {
    return NextResponse.json({ error: error.code, reasons: error.reasons }, { status: error.status });
  }
  if (error instanceof DraftRefusal) {
    return NextResponse.json({ error: error.code, detail: error.detail }, { status: 422 });
  }
  return apiSecurityResponse(error);
};

/** Providers a draft can read: known to the code, with official documentation hosts. */
const DRAFT_PROVIDERS = AI_PROVIDERS.filter((provider) => Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider));
const isDraftProvider = (provider: string) => (DRAFT_PROVIDERS as readonly string[]).includes(provider);

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

type TermsState = "confirmed" | "expired" | "missing" | "invalid";

export async function GET(req: Request) {
  try {
    const auth = await adminSession(false);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog", { minute: 30, day: 1_000 });

    const now = new Date();
    const [chat, providerTerms, snapshot] = await Promise.all([loadChatModelFacts(), loadCodingProviderTerms(), latestCodingSnapshot()]);
    const entries = await loadCodingCatalog(undefined, { now, context: { chat, providerTerms } });
    const chatById = new Map(chat.map((facts) => [facts.id, facts]));
    const termsByProvider = new Map(providerTerms.map((record) => [record.provider, record]));
    const termsState = (provider: string): { state: TermsState; checkedAt: string | null; dueOn: string | null } => {
      const record = termsByProvider.get(provider);
      if (!record?.terms) return { state: record?.invalid ? "invalid" : "missing", checkedAt: null, dueOn: null };
      return {
        state: providerTermsExpired(record.terms.checkedAt, now) ? "expired" : "confirmed",
        checkedAt: record.terms.checkedAt,
        dueOn: providerTermsDueOn(record.terms.checkedAt),
      };
    };

    const codingIds = new Set(entries.map((entry) => entry.modelId));
    const eligible: typeof chat = [];
    const excluded: { id: string; name: string; provider: string; reason: string }[] = [];
    for (const facts of chat) {
      const reason = codingCandidateExclusion(facts, codingIds);
      if (reason === null) eligible.push(facts);
      // A deleted model or one already linked is not worth listing as "left out".
      else if (reason !== "already_in_catalog" && reason !== "deleted") excluded.push({ id: facts.id, name: facts.name, provider: facts.provider, reason });
    }

    const providerOf = (entry: (typeof entries)[number]) => entry.profile?.provider ?? null;
    const providers = [
      ...new Set([
        ...entries.flatMap((entry) => (providerOf(entry) ? [providerOf(entry) as string] : [])),
        ...eligible.map((facts) => facts.provider),
        ...providerTerms.map((record) => record.provider),
      ]),
    ].sort();

    const current = servableCodingRows(entries);
    const published = snapshot ? parseSnapshotRows(snapshot.models) : [];

    return NextResponse.json({
      models: entries.map((entry) => {
        const linked = entry.source === "chat" ? (entry.stored as { registryModelId?: string } | null)?.registryModelId : undefined;
        return {
          ...entry,
          // The floor the judge holds the credit weight to, at the resolved prices.
          floor: entry.profile ? codingCreditFloor(entry.profile) : null,
          draftReview: reviewCodingDraft(entry.draft),
          chat: linked ? (chatById.get(linked) ?? null) : null,
        };
      }),
      candidates: {
        eligible: eligible.map((facts) => ({ ...facts, terms: termsState(facts.provider) })),
        excluded,
      },
      providers: providers.map((provider) => {
        const record = termsByProvider.get(provider);
        const draft = record?.draft ? codingProviderTermsSchema.safeParse(record.draft) : null;
        return {
          provider,
          terms: record?.terms ?? null,
          ...termsState(provider),
          draft: draft?.success ? draft.data : null,
          draftCreatedAt: record?.draftCreatedAt ?? null,
          updatedByEmail: record?.updatedByEmail ?? null,
          modelCount: entries.filter((entry) => providerOf(entry) === provider).length,
          candidateCount: eligible.filter((facts) => facts.provider === provider).length,
          // Rows that still read their own terms because this provider has no record.
          legacyTermsCount: entries.filter((entry) => providerOf(entry) === provider && entry.termsSource === "model").length,
          draftable: isDraftProvider(provider),
          hosts: OFFICIAL_SOURCE_HOSTS[provider] ?? [],
        };
      }),
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
      // What the dedicated add form offers (a draft reads price, terms and retention pages).
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

const sourceUrls = z.array(z.string().url()).max(MAX_DRAFT_SOURCES);
const providerName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

const postBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("link"),
    registryModelId: z.string().regex(MODEL_ID_PATTERN),
    // Empty means the provider's default documentation pages.
    sourceUrls: sourceUrls.default([]),
  }),
  z.object({ action: z.literal("settings"), modelId: z.string().regex(MODEL_ID_PATTERN), settings: codingSettingsSchema }),
  z.object({ action: z.literal("unlink"), modelId: z.string().regex(MODEL_ID_PATTERN) }),
  z.object({
    action: z.literal("provider_terms_draft"),
    provider: providerName,
    // Empty means the pages the applied record cites (a re-check).
    sourceUrls: sourceUrls.default([]),
  }),
  z.object({ action: z.literal("provider_terms_apply"), provider: providerName }),
  z.object({ action: z.literal("provider_terms_discard"), provider: providerName }),
  z.object({ action: z.literal("publish_snapshot") }),
]);

const llmOrRefusal = async () => {
  const llm = await catalogDraftLlmFromEnv();
  if (!llm) {
    return {
      response: NextResponse.json({ error: "draft_llm_not_configured", env: MODEL_CATALOG_DRAFT_LLM_MODEL_ENV }, { status: 409 }),
    } as const;
  }
  return { llm } as const;
};

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
    if (body.action === "provider_terms_apply") {
      const terms = await applyProviderTermsDraft({ provider: body.provider, session, request: req });
      return NextResponse.json({ ok: true, terms });
    }
    if (body.action === "provider_terms_discard") {
      await discardProviderTermsDraft({ provider: body.provider, session, request: req });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "publish_snapshot") {
      const result = await publishCodingSnapshot({ session, request: req });
      return NextResponse.json({ ok: true, ...result });
    }

    if (body.action === "link") {
      // Refused for free before the paid draft call; checked again in the write.
      const refusal = await chatLinkRefusal(body.registryModelId);
      if (refusal) return NextResponse.json({ error: refusal.code, reasons: refusal.reasons }, { status: 409 });
      const facts = (await loadChatModelFacts()).find((model) => model.id === body.registryModelId);
      if (!facts || !isDraftProvider(facts.provider)) {
        return NextResponse.json({ error: "no_default_source", detail: facts?.provider ?? null }, { status: 422 });
      }
      const urls = body.sourceUrls.length > 0 ? body.sourceUrls : defaultPriceSources(facts.provider);
      if (urls.length === 0) return NextResponse.json({ error: "no_default_source", detail: facts.provider }, { status: 422 });
      const draftLlm = await llmOrRefusal();
      if ("response" in draftLlm) return draftLlm.response;
      const pages = [];
      for (const url of urls) pages.push(await fetchOfficialPage(facts.provider, url));
      const draft = await draftLlm.llm.draftCodingCapabilities({ provider: facts.provider, apiModelId: facts.apiModelId, pages });
      await linkChatModel({ registryModelId: body.registryModelId, draft, session, request: req });
      return NextResponse.json({ ok: true, draft });
    }

    // provider_terms_draft: one LLM call over the provider's own pages.
    if (!isDraftProvider(body.provider)) return NextResponse.json({ error: "unknown_provider", detail: body.provider }, { status: 400 });
    let urls = body.sourceUrls;
    if (urls.length === 0) {
      const current = (await loadCodingProviderTerms()).find((record) => record.provider === body.provider)?.terms;
      urls = current ? [...new Set([current.termsUrl, current.retentionUrl])] : [];
    }
    if (urls.length === 0) return NextResponse.json({ error: "no_terms_source", detail: body.provider }, { status: 422 });
    const draftLlm = await llmOrRefusal();
    if ("response" in draftLlm) return draftLlm.response;
    const pages = [];
    for (const url of urls) pages.push(await fetchOfficialPage(body.provider, url));
    const draft = await draftLlm.llm.draftProviderTerms({ provider: body.provider, pages });
    await storeProviderTermsDraft({ provider: body.provider, draft, session, request: req });
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog action failed." }, { status: 500 });
  }
}
