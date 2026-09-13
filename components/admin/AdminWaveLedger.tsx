"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import { adminEmailCampaignDetailMessages } from "@/lib/adminMessages/emailCampaignDetail";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  AdminAddressRevealProvider,
  AdminRevealableAddress,
  AdminRevealAddressesButton,
} from "@/components/admin/AdminAddressReveal";

/**
 * The people in one wave's expansion ledger.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §44 (the
 * ledger) and .github/audits/model-lifecycle-email-2026-08-22.md §21
 * (D10 — what may be shown of it), decided 2026-08-24.
 *
 * ## Why this was counts until now
 *
 * The seventh slice reported totals and said on screen why: each row holds the
 * address it was written to, and whether an operator may see one was an open
 * question. D10 answered it, so the list exists under the same rule as
 * `/admin/email-delivery` — masked in the response, revealed by an audited act.
 *
 * ## One wave at a time, so "the screen" means something
 *
 * D10 made the screen the unit of a reveal. A campaign has several waves, and a
 * page rendering all of their ledgers at once would have no single answer to
 * "which screen" — the reveal would either exceed its cap or quietly cover part
 * of what is displayed. Opening one wave at a time makes the list on screen and
 * the list one reveal covers the same list, and the page size is the reveal cap
 * for the same reason.
 *
 * ## Paging closes the reveal
 *
 * The next page is a different set of rows, so the addresses from the last one
 * are dropped and the button comes back. Carrying them forward would let one
 * audited call cover a ledger of any size, one page at a time, and the record
 * would still say "a hundred".
 */

type LedgerRow = {
  id: string;
  emailAddressMasked: string | null;
  language: string | null;
  jurisdictionCountry: string | null;
  eligibilityReason: string | null;
  excludedReason: string | null;
  hasDelivery: boolean;
  malformed: boolean;
  createdAt: string;
};

type LedgerPage = {
  rows: LedgerRow[];
  nextCursor: string | null;
  limit: number;
};

const labelFor = (labels: object, key: string): string | undefined =>
  Object.hasOwn(labels, key)
    ? (labels as Record<string, string>)[key]
    : undefined;

export function AdminWaveLedger({
  campaignId,
  waveId,
  dryRun,
  mayRevealAddresses,
}: {
  campaignId: string;
  waveId: string;
  dryRun: boolean;
  mayRevealAddresses: boolean;
}) {
  const messages = useAdminMessages(adminEmailCampaignDetailMessages);
  const m = messages.ledger;
  // Read through a ref so a language switch does not re-run `load`: a reload
  // is a new page, and a new page drops the addresses already revealed.
  const loadFailedMessage = useRef(m.loadFailed);
  useEffect(() => {
    loadFailedMessage.current = m.loadFailed;
  }, [m.loadFailed]);
  const [page, setPage] = useState<LedgerPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  // Every page is its own reveal scope. Remounting the provider is what drops
  // the addresses: see the note above on why they must not travel between
  // pages.
  const [pageEpoch, setPageEpoch] = useState(0);

  const load = useCallback(
    async (nextCursor: string | null) => {
      setLoading(true);
      try {
        const url = new URL(
          `/api/admin/email-campaigns/${encodeURIComponent(campaignId)}/recipients`,
          window.location.origin
        );
        url.searchParams.set("waveId", waveId);
        if (nextCursor) url.searchParams.set("cursor", nextCursor);

        const response = await fetch(url, { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as
          | LedgerPage
          | { error?: string }
          | null;
        if (!response.ok || !payload || !("rows" in payload)) {
          throw new Error(
            payload && "error" in payload && payload.error
              ? payload.error
              : loadFailedMessage.current
          );
        }
        setPage(payload);
        setPageEpoch((value) => value + 1);
      } catch (error) {
        dispatchAppToast(
          error instanceof Error
            ? error.message
            : loadFailedMessage.current,
          "error"
        );
      } finally {
        setLoading(false);
      }
    },
    [campaignId, waveId]
  );

  useEffect(() => {
    // Queued rather than called straight from the effect body, which is the
    // shape every other admin panel here uses: `load` sets its busy state
    // first, and setting state synchronously inside an effect cascades a
    // render.
    queueMicrotask(() => {
      void load(cursor);
    });
  }, [cursor, load]);

  if (loading && !page) {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {m.loading}
      </p>
    );
  }

  if (!page) return null;

  if (page.rows.length === 0) {
    return (
      <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
        {m.empty}
      </p>
    );
  }

  return (
    <AdminAddressRevealProvider key={pageEpoch}>
      <div className="mt-3" data-testid="admin-wave-ledger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Says what is on screen and what it is a page of. A list that
              silently stops at its limit reads as the whole ledger. */}
          <p className="text-xs text-zinc-500">
            {m.showing(page.rows.length, Boolean(page.nextCursor), page.limit)}
          </p>
          <AdminRevealAddressesButton
            kind="campaign_recipient"
            rowIds={page.rows.map((row) => row.id)}
            allowed={mayRevealAddresses}
          />
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th scope="col" className="py-2 pr-3 font-bold">{m.columns.address}</th>
                <th scope="col" className="py-2 pr-3 font-bold">{m.columns.why}</th>
                <th scope="col" className="py-2 pr-3 font-bold">{m.columns.outcome}</th>
                <th scope="col" className="py-2 pr-3 font-bold">{m.columns.locale}</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {page.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-zinc-900 align-top"
                  data-testid="admin-wave-ledger-row"
                >
                  <td className="py-2 pr-3">
                    <AdminRevealableAddress
                      rowId={row.id}
                      masked={row.emailAddressMasked}
                    />
                    {row.malformed ? (
                      <span
                        className="ml-2 rounded-md border border-amber-800 px-1.5 py-0.5 text-[11px] font-bold text-amber-200"
                        data-testid="admin-wave-ledger-malformed"
                      >
                        {m.malformed}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-zinc-400">
                    {row.eligibilityReason
                      ? (labelFor(messages.cohort, row.eligibilityReason) ??
                        row.eligibilityReason)
                      : m.noLongerInCohort}
                  </td>
                  <td className="py-2 pr-3">
                    {row.excludedReason ? (
                      <span className="text-amber-200">
                        {labelFor(messages.excluded, row.excludedReason) ??
                          row.excludedReason}
                      </span>
                    ) : (
                      // "Written", never "sent". On a dry run the delivery was
                      // written `skipped` and nothing left the building.
                      <span className="text-zinc-300">
                        {row.hasDelivery
                          ? dryRun
                            ? m.writtenDryRun
                            : m.written
                          : m.noDelivery}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-zinc-500">
                    {row.language ?? "—"}
                    {row.jurisdictionCountry
                      ? ` · ${row.jurisdictionCountry}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {page.nextCursor || cursor ? (
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setCursor(null)}
              disabled={loading || !cursor}
              className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-bold text-zinc-300 disabled:opacity-50"
            >
              {m.firstPage}
            </button>
            <button
              type="button"
              onClick={() => setCursor(page.nextCursor)}
              disabled={loading || !page.nextCursor}
              className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-bold text-zinc-300 disabled:opacity-50"
              data-testid="admin-wave-ledger-next"
            >
              {m.nextPage}
            </button>
            <p className="text-xs text-zinc-500">
              {m.pagingNote}
            </p>
          </div>
        ) : null}
      </div>
    </AdminAddressRevealProvider>
  );
}
