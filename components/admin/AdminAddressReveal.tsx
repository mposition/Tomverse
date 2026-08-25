"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Eye, Loader2 } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import type { AddressRevealKind } from "@/lib/emailAddressMaskingCore";

/**
 * The reveal, and the cells that answer to it.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21 (D10),
 * decided 2026-08-24.
 *
 * ## The revealed addresses live here and nowhere else
 *
 * Not in the URL, not in `localStorage`, not on the server-rendered page. They
 * arrive from one audited call and are held in this component's state, so
 * leaving the screen or reloading it puts them back. That is what makes
 * exposure an event rather than a state: there is nothing to bookmark and
 * nothing that keeps being true.
 *
 * ## One call for the screen
 *
 * D10 chose the screen as the unit, so the button asks for every row currently
 * listed in one request and one audit entry. Revealing row by row would write
 * an entry per click, and a hundred entries that each say "one address" are
 * harder to read than one that says "a hundred".
 */

type RevealState = {
  addresses: Record<string, string | null>;
  revealed: boolean;
};

const RevealContext = createContext<RevealState>({
  addresses: {},
  revealed: false,
});

export function AdminAddressRevealProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, setState] = useState<RevealState>({
    addresses: {},
    revealed: false,
  });
  return (
    <RevealContext.Provider value={state}>
      <RevealSetter.Provider value={setState}>{children}</RevealSetter.Provider>
    </RevealContext.Provider>
  );
}

const RevealSetter = createContext<
  ((next: RevealState) => void) | ((updater: (prev: RevealState) => RevealState) => void)
>(() => undefined);

/**
 * One address cell.
 *
 * Renders the mask the server computed until a reveal has happened, and the
 * real address after. It never receives the address as a prop -- the masked
 * value is all the page's HTML ever contains -- so an operator who does not
 * press the button never had the address in their browser at all.
 */
export function AdminRevealableAddress({
  rowId,
  masked,
}: {
  rowId: string;
  masked: string | null;
}) {
  const { addresses, revealed } = useContext(RevealContext);
  if (!revealed) {
    return <span className="font-mono text-xs">{masked ?? "—"}</span>;
  }
  const address = addresses[rowId];
  return (
    <span className="font-mono text-xs" data-testid="admin-address-revealed">
      {address ?? masked ?? "—"}
    </span>
  );
}

export function AdminRevealAddressesButton({
  kind,
  rowIds,
  /**
   * Whether this administrator may reveal at all (D10: `owner` and `ops`).
   *
   * Resolved on the server and passed in. The control renders either way and
   * says which it is: a button that vanishes for some administrators is
   * indistinguishable from a screen that has no such feature, and the next
   * question is asked of whoever built it rather than answered on the page.
   */
  allowed,
}: {
  kind: AddressRevealKind;
  rowIds: string[];
  allowed: boolean;
}) {
  const setState = useContext(RevealSetter) as (next: RevealState) => void;
  const { revealed } = useContext(RevealContext);
  const [busy, setBusy] = useState(false);
  const ids = useMemo(() => rowIds, [rowIds]);

  const reveal = useCallback(async () => {
    if (busy || revealed) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/email-deliveries/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ids }),
      });
      const payload = (await response.json().catch(() => null)) as {
        addresses?: Record<string, string | null>;
        error?: string;
      } | null;
      if (!response.ok || !payload?.addresses) {
        throw new Error(payload?.error || "Could not show the addresses.");
      }
      setState({ addresses: payload.addresses, revealed: true });
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not show the addresses.",
        "error"
      );
    } finally {
      setBusy(false);
    }
  }, [busy, ids, kind, revealed, setState]);

  if (!allowed) {
    return (
      <p className="text-xs text-zinc-500" data-testid="admin-reveal-not-permitted">
        Addresses are shown masked. Revealing them is an owner or ops action.
      </p>
    );
  }

  if (revealed) {
    return (
      <p className="text-xs text-zinc-400" data-testid="admin-reveal-done">
        Addresses shown, and recorded in the audit log. Reloading this page masks
        them again.
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void reveal()}
      disabled={busy || ids.length === 0}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 hover:border-zinc-700 disabled:opacity-60"
      data-testid="admin-reveal-addresses"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Eye className="h-4 w-4" aria-hidden />
      )}
      Show addresses ({ids.length})
    </button>
  );
}
