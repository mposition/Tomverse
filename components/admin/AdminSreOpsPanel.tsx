"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminSreOpsMessages } from "@/lib/adminMessages/sreOps";
import { type GenesisOutcome, genesisOutcome } from "@/lib/adminSreOpsGenesisOutcome";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { OpsObserverAdminView } from "@/lib/opsObserverStore";
import { genesisOffer } from "@/scripts/ops-observer/genesis-core.mjs";

const PAGE_PATH = "/admin/sre-ops";
const GENESIS_ROUTE = "/api/admin/agents/sre-ops/genesis";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

type Notice = { tone: "ok" | "error"; text: string } | null;

/**
 * The sre-ops chain and the owner's genesis (docs/policy/sre-ops.md §8). The
 * screen shows the head and trust verdict it was rendered with, and a genesis
 * request names exactly those back, so the store refuses (`stale`) if either
 * moved since. The one genesis offered follows genesisOffer(); the owner is
 * the only viewer offered the button, the route checks again, and a stale
 * sign-in is answered with the way back.
 */
export function AdminSreOpsPanel({ view, canApprove }: { view: OpsObserverAdminView | null; canApprove: boolean }) {
  const m = useAdminMessages(adminSreOpsMessages);
  if (!view) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="sre-ops-read-failed">
        {m.readFailed}
      </p>
    );
  }
  return <AdminSreOpsChain view={view} canApprove={canApprove} />;
}

function AdminSreOpsChain({ view, canApprove }: { view: OpsObserverAdminView; canApprove: boolean }) {
  const m = useAdminMessages(adminSreOpsMessages);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const offer = genesisOffer(view) as { reason: "initial" | "recovery" | "activation"; mode: string } | null;
  const tooSoon = !view.genesisAllowedNow;

  const offerLabel = offer
    ? offer.reason === "recovery"
      ? fill(m.reason_recovery, { mode: offer.mode })
      : offer.reason === "activation"
        ? m.reason_activation
        : m.reason_initial
    : null;

  const show = (outcome: GenesisOutcome) => {
    if (outcome.kind === "requiresReauthentication") {
      setReauthenticationRequired(true);
    } else if (outcome.kind === "refused") {
      setNotice({ tone: "error", text: fill(m.refused, { code: outcome.code }) });
    } else if (outcome.kind === "created") {
      setNotice({ tone: "ok", text: fill(m.created, { id: outcome.genesisId }) });
      router.refresh();
    } else {
      // Not known whether it committed: say so and re-read, never "not approved".
      setNotice({ tone: "error", text: m.outcomeUnknown });
      router.refresh();
    }
  };

  const approve = async () => {
    if (!offer || !window.confirm(m.confirmApprove)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(GENESIS_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: offer.reason,
          mode: offer.mode,
          expectedGenesisId: view.head?.genesisId ?? null,
          expectedGeneration: view.head?.generation ?? null,
          expectedMode: view.head?.mode ?? null,
          trustReason: view.trustReason,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        result?: { genesisId?: unknown };
      };
      show(genesisOutcome({ status: response.status, payload }));
    } catch {
      // A timeout or a lost response: the genesis may have committed after the
      // request was abandoned. The re-read shows which; a repeat of the same
      // approval is refused as stale if it did.
      show(genesisOutcome("no_answer"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
        {m.readNote}
      </p>

      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.chainTitle}</h2>
        {view.head ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="sre-ops-chain">
            <dt className="text-zinc-600 dark:text-zinc-400">{m.genesisId}</dt>
            <dd className="break-all font-mono text-xs">{view.head.genesisId}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.generation}</dt>
            <dd>{view.head.generation ?? m.generationMissing}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.mode}</dt>
            <dd>{view.head.mode}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.approvedAt}</dt>
            <dd>{view.head.createdAt}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.trust}</dt>
            <dd data-testid="sre-ops-trust">
              {view.trustReason === "trusted" ? m.trusted : fill(m.untrusted, { reason: view.trustReason })}
            </dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.nextGenesisAt}</dt>
            <dd>{view.nextGenesisAt}</dd>
          </dl>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="sre-ops-chain">
            {m.noHead}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.genesisTitle}</h2>
        {!offer ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.noOffer}</p>
        ) : !canApprove ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.ownerOnly}</p>
        ) : (
          <>
            <p className="text-sm text-zinc-800 dark:text-zinc-200" data-testid="sre-ops-offer">
              {offerLabel}
            </p>
            {tooSoon ? (
              <p className="text-sm text-amber-800 dark:text-amber-300">{fill(m.tooSoon, { at: view.nextGenesisAt ?? "" })}</p>
            ) : null}
            {reauthenticationRequired ? (
              <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
                {m.reauthenticationRequired}
                <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
                  {m.signInAgain}
                </a>
              </p>
            ) : null}
            {notice ? (
              <p
                role="status"
                className={
                  notice.tone === "ok" ? "text-sm text-zinc-700 dark:text-zinc-300" : "text-sm text-red-700 dark:text-red-300"
                }
              >
                {notice.text}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void approve()}
              disabled={busy || tooSoon}
              data-testid="sre-ops-approve"
              className="min-h-11 self-start rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {m.approve}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
