"use client";

import { useCallback, useEffect, useState } from "react";

import {
  MARKETING_CHECKED,
  MarketingActionRail,
  type MarketingAction,
} from "@/components/admin/MarketingActions";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The production webhook configuration (S2f): what a production signature
 * would bind, read now; signing a generation over a signed verification
 * record; and setting or emptying the apply scope.
 *
 * Drawn only where the server says the deployment is labelled production --
 * everywhere else the signing route refuses, so a control there would only
 * ever answer 409. Every value a write sends is the one this screen read from
 * the server, and the server recomputes each of them before it writes.
 */

type Pair = { eventType: string; channelId: string };

export type MarketingWebhookProductionLive = Live;

type Live = {
  environment: string;
  deployCommitSha: string | null;
  pipelineFingerprint: string;
  productionConfigSnapshotDigest: string;
  stored:
    | { status: "absent" }
    | { status: "invalid" }
    | {
        status: "valid";
        value: { generation: number; recordId: string; signatureAuditLogId: string };
      };
  nextGeneration: number | null;
  applyScope: (
    | { status: "absent" }
    | { status: "invalid" }
    | { status: "valid"; value: { recordId: string; productionConfigGeneration: number; scope: Pair[] } }
  ) & { storedDigest: string };
  record: {
    recordId: string;
    status: "found" | "not_found" | "invalid";
    recordDigest: string | null;
    pipelineFingerprint: string | null;
    observedScope: Pair[];
    verificationSignatureAuditLogId: string | null;
  } | null;
};

const short = (value: string) => `${value.slice(0, 12)}…`;
const pairKey = (pair: Pair) => JSON.stringify([pair.eventType, pair.channelId]);

export function MarketingWebhookProduction({ section }: { section: string }) {
  const m = useAdminMessages(adminMarketingMessages);
  const [live, setLive] = useState<Live | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [recordId, setRecordId] = useState("");
  const [loading, setLoading] = useState(false);

  // The form sets "loading"; the mount effect does not, so nothing is set
  // before this request answers.
  const load = useCallback(async (id: string | null) => {
    try {
      const query = id ? `?recordId=${encodeURIComponent(id)}` : "";
      const response = await adminFetch(
        `/api/admin/marketing/webhook/production-config/live${query}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        await discardResponseBody(response);
        setUnreadable(true);
        return;
      }
      setLive((await response.json()) as Live);
      setUnreadable(false);
    } catch {
      setUnreadable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // From a microtask, as the other admin panels do: the load sets state only
    // after its request answers, never inside the effect body itself.
    void Promise.resolve().then(() => load(null));
  }, [load]);

  if (unreadable) {
    return (
      <div data-testid="marketing-webhook-production" className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3">
        <p className="text-xs text-amber-300">{m.prodUnreadable}</p>
      </div>
    );
  }
  // Nothing until the server says this is production: not a disabled teaser.
  if (!live || live.environment !== "production") return null;

  return (
    <MarketingWebhookProductionView
      live={live}
      m={m}
      section={section}
      recordId={recordId}
      onRecordIdChange={setRecordId}
      loading={loading}
      onLoadRecord={(id) => {
        setLoading(true);
        void load(id);
      }}
      onReload={(id) => load(id)}
    />
  );
}

/**
 * The block itself, with no state and no hooks: every value comes in as a
 * prop, so the render test can call it and read the actions it hands each rail.
 */
export function MarketingWebhookProductionView({
  live,
  m,
  section,
  recordId,
  onRecordIdChange,
  loading,
  onLoadRecord,
  onReload,
}: {
  live: Live;
  m: Record<string, string>;
  section: string;
  recordId: string;
  onRecordIdChange: (value: string) => void;
  loading: boolean;
  onLoadRecord: (id: string) => void;
  onReload: (id: string | null) => Promise<void> | void;
}) {
  const record = live.record;
  const reloadRecord = () => void onReload(record?.recordId ?? (recordId.trim() || null));
  const signed = live.stored.status === "valid" ? live.stored.value : null;
  const scope = live.applyScope;

  const generationLine =
    live.stored.status === "valid"
      ? m.prodGenerationSigned
          .replace("{generation}", String(live.stored.value.generation))
          .replace("{recordId}", live.stored.value.recordId)
      : live.stored.status === "invalid"
        ? m.prodGenerationInvalid
        : m.prodNone;
  const scopeLine =
    scope.status === "valid"
      ? scope.value.scope.length === 0
        ? m.prodScopeEmpty
        : m.prodScopePairs
            .replace("{count}", String(scope.value.scope.length))
            .replace("{generation}", String(scope.value.productionConfigGeneration))
      : scope.status === "invalid"
        ? m.prodScopeInvalid
        : m.prodNone;

  const recordLine = !record
    ? null
    : record.status === "not_found"
      ? m.prodRecordNotFound
      : record.status === "invalid"
        ? m.prodRecordInvalid
        : record.pipelineFingerprint !== live.pipelineFingerprint
          ? m.prodRecordStale
          : record.verificationSignatureAuditLogId === null
            ? m.prodRecordUnsigned
            : m.prodRecordReady
                .replace("{recordId}", record.recordId)
                .replace("{digest}", short(record.recordDigest ?? ""))
                .replace("{auditLogId}", record.verificationSignatureAuditLogId)
                .replace("{count}", String(record.observedScope.length));

  const recordReady =
    record !== null &&
    record.status === "found" &&
    record.recordDigest !== null &&
    record.pipelineFingerprint === live.pipelineFingerprint &&
    record.verificationSignatureAuditLogId !== null;

  const signAction: MarketingAction[] =
    recordReady && live.deployCommitSha !== null && live.nextGeneration !== null
      ? [
          {
            id: "webhook-production-config-sign",
            label: m.prodSignAction,
            path: "/api/admin/marketing/webhook/production-config",
            confirm: m.prodSignConfirm.replace("{generation}", String(live.nextGeneration)),
            describe: (result) => {
              const generation = (result as { generation?: unknown } | null)?.generation;
              return typeof generation === "number"
                ? m.prodSignDone.replace("{generation}", String(generation))
                : null;
            },
            body: () => ({
              generation: live.nextGeneration,
              recordId: record!.recordId,
              recordDigest: record!.recordDigest,
              verificationSignatureAuditLogId: record!.verificationSignatureAuditLogId,
              deployCommitSha: live.deployCommitSha,
              pipelineFingerprint: live.pipelineFingerprint,
              productionConfigSnapshotDigest: live.productionConfigSnapshotDigest,
            }),
          },
        ]
      : [];

  // The scope is chosen from what the signed generation's record observed, so
  // only pairs the server can accept are offered.
  const current = new Set(scope.status === "valid" ? scope.value.scope.map(pairKey) : []);
  const scopeAction: MarketingAction[] =
    signed && recordReady && record!.recordId === signed.recordId && record!.observedScope.length > 0
      ? [
          {
            id: "webhook-production-apply-scope",
            label: m.prodScopeAction,
            path: "/api/admin/marketing/webhook/apply-scope",
            method: "PATCH",
            confirm: m.prodScopeConfirm,
            fields: record!.observedScope.map((pair, index) => ({
              name: `pair${index}`,
              label: m.prodPairLabel.replace("{eventType}", pair.eventType).replace("{channelId}", pair.channelId),
              kind: "checkbox" as const,
              initial: current.has(pairKey(pair)) ? MARKETING_CHECKED : "",
            })),
            describe: (result) => {
              const saved = (result as { scope?: unknown } | null)?.scope;
              return Array.isArray(saved) ? m.prodScopeDone.replace("{count}", String(saved.length)) : null;
            },
            body: (values) => ({
              recordId: signed.recordId,
              productionConfigGeneration: signed.generation,
              scope: record!.observedScope.filter((_, index) => values[`pair${index}`] === MARKETING_CHECKED),
              expectedStoredDigest: scope.storedDigest,
            }),
          },
        ]
      : [];

  // Emptying is a stop: offered whenever something is applied, with nothing else required.
  const stopAction: MarketingAction[] =
    scope.status === "valid" && scope.value.scope.length > 0
      ? [
          {
            id: "webhook-production-apply-scope-stop",
            label: m.prodScopeStop,
            path: "/api/admin/marketing/webhook/apply-scope",
            method: "PATCH",
            danger: true,
            confirm: m.prodScopeStopConfirm,
            body: () => ({
              recordId: scope.value.recordId,
              productionConfigGeneration: scope.value.productionConfigGeneration,
              scope: [],
              expectedStoredDigest: scope.storedDigest,
            }),
          },
        ]
      : [];

  const rows: Array<[string, string]> = [
    [m.prodLabelEnvironment, live.environment],
    [m.prodLabelDeployCommit, live.deployCommitSha ? short(live.deployCommitSha) : m.prodDeployUnknown],
    [m.prodLabelFingerprint, short(live.pipelineFingerprint)],
    [m.prodLabelConfigDigest, short(live.productionConfigSnapshotDigest)],
    [m.prodLabelGeneration, generationLine],
    [m.prodLabelScope, scopeLine],
  ];

  return (
    <div
      data-testid="marketing-webhook-production"
      className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3"
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{m.prodTitle}</p>
      <p className="mt-1 text-xs text-zinc-500">{m.prodNote}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt className="text-xs text-zinc-400">{label}</dt>
            <dd className="break-all text-right font-mono text-xs text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>

      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (recordId.trim()) onLoadRecord(recordId.trim());
        }}
      >
        <label className="grid gap-1 text-xs text-zinc-400">
          {m.fieldRecordId}
          <input
            data-testid="marketing-webhook-production-record-id"
            value={recordId}
            onChange={(event) => onRecordIdChange(event.target.value)}
            placeholder={signed?.recordId ?? ""}
            className="min-h-11 w-80 max-w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"
          />
        </label>
        <button
          type="submit"
          disabled={loading || !recordId.trim()}
          className="min-h-11 rounded-xl border border-zinc-700 px-3 text-sm text-zinc-200 disabled:opacity-50"
        >
          {loading ? m.prodRecordLoading : m.prodRecordLoad}
        </button>
      </form>
      {recordLine ? (
        <p data-testid="marketing-webhook-production-record" className="mt-2 text-xs text-zinc-300">
          {recordLine}
        </p>
      ) : null}

      <MarketingActionRail actions={signAction} section={section} onDone={reloadRecord} m={m} />
      <MarketingActionRail actions={scopeAction} section={section} onDone={reloadRecord} m={m} />
      <MarketingActionRail actions={stopAction} section={section} onDone={reloadRecord} m={m} />
    </div>
  );
}
