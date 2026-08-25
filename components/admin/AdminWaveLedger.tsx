"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import {
  AdminAddressRevealProvider,
  AdminRevealableAddress,
  AdminRevealAddressesButton,
} from "@/components/admin/AdminAddressReveal";

/**
 * The people in one wave's expansion ledger.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §44 (the
 * ledger), §21 D10 (what may be shown of it), decided 2026-08-24.
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

const EXCLUDED_LABEL: Record<string, string> = {
  no_email: "No address on the account",
  account_inactive: "Account inactive",
  suppressed: "Address suppressed",
  no_consent: "No consent for this purpose",
  plan_incompatible: "Replacement not available on their plan",
  already_changed: "No longer in any cohort",
};

const COHORT_LABEL: Record<string, string> = {
  default_model: "Their default model",
  new_conversation_lead: "Lead of their new-conversation set",
  conversation_selection: "Selected in a conversation",
};

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
              : "Could not read this wave's ledger."
          );
        }
        setPage(payload);
        setPageEpoch((value) => value + 1);
      } catch (error) {
        dispatchAppToast(
          error instanceof Error
            ? error.message
            : "Could not read this wave's ledger.",
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
        Reading the ledger…
      </p>
    );
  }

  if (!page) return null;

  if (page.rows.length === 0) {
    return (
      <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
        This wave has no ledger rows, so nobody has been considered for it yet.
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
            Showing {page.rows.length}
            {page.nextCursor ? " of more" : ""} — up to {page.limit} at a time,
            which is what one reveal covers.
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
                <th scope="col" className="py-2 pr-3 font-bold">Address</th>
                <th scope="col" className="py-2 pr-3 font-bold">Why they were in</th>
                <th scope="col" className="py-2 pr-3 font-bold">Outcome</th>
                <th scope="col" className="py-2 pr-3 font-bold">Locale</th>
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
                        unreadable stored value
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-zinc-400">
                    {row.eligibilityReason
                      ? (COHORT_LABEL[row.eligibilityReason] ??
                        row.eligibilityReason)
                      : "No longer in any cohort"}
                  </td>
                  <td className="py-2 pr-3">
                    {row.excludedReason ? (
                      <span className="text-amber-200">
                        {EXCLUDED_LABEL[row.excludedReason] ??
                          row.excludedReason}
                      </span>
                    ) : (
                      // "Written", never "sent". On a dry run the delivery was
                      // written `skipped` and nothing left the building.
                      <span className="text-zinc-300">
                        {row.hasDelivery
                          ? dryRun
                            ? "A delivery row was written and skipped — dry run"
                            : "A delivery row was written"
                          : "No delivery row"}
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
              First page
            </button>
            <button
              type="button"
              onClick={() => setCursor(page.nextCursor)}
              disabled={loading || !page.nextCursor}
              className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-bold text-zinc-300 disabled:opacity-50"
              data-testid="admin-wave-ledger-next"
            >
              Next page
            </button>
            <p className="text-xs text-zinc-500">
              A new page is a new set of rows, so any addresses shown here are
              dropped and revealing them again is a new entry in the log.
            </p>
          </div>
        ) : null}
      </div>
    </AdminAddressRevealProvider>
  );
}
