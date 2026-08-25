import type { AdminSuppressionRow } from "@/lib/adminEmailDeliveries";
import {
  AdminRevealableAddress,
  AdminRevealAddressesButton,
} from "@/components/admin/AdminAddressReveal";

/**
 * Addresses we will not mail, and why.
 *
 * Contract: docs/policy/email-notifications.md §13.3, §13.7, §5.3.1.
 *
 * A read view. Adding and lifting go through
 * `POST /api/admin/email-suppressions`, which audits both and requires a reason
 * on removal (§13.7) — the asymmetry being that adding one stops mail while
 * removing one starts mail to an address that a provider, or the person,
 * previously said to stop mailing.
 *
 * The notice about the provider's own list is on screen rather than in a
 * comment. Resend's suppression is account- and region-wide (§5.3.1), so an
 * operator who lifts an entry here and expects mail to flow is an operator who
 * will conclude the lift did not work.
 */

const REASON_TONE: Record<string, string> = {
  hard_bounce: "border-red-800 bg-red-950/50 text-red-200",
  complaint: "border-red-800 bg-red-950/50 text-red-200",
  privacy_request: "border-purple-800 bg-purple-950/40 text-purple-200",
  manual: "border-amber-800 bg-amber-950/50 text-amber-200",
  unsubscribe: "border-zinc-700 bg-zinc-900 text-zinc-300",
  soft_bounce: "border-zinc-700 bg-zinc-900 text-zinc-300",
};

const when = (value: Date | null) =>
  value ? value.toISOString().replace("T", " ").slice(0, 19) : "—";

export function AdminEmailSuppressionsPanel({
  rows,
  mayRevealAddresses,
}: {
  rows: AdminSuppressionRow[];
  /** D10: `owner` and `ops`. Resolved on the server. */
  mayRevealAddresses: boolean;
}) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Email
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Suppressions</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        Addresses this system will not send to. A hard bounce or a complaint has
        no expiry; a soft bounce holds for a day. Lifting one is audited and
        needs a written reason, and lifting a hard bounce or a complaint needs a
        second administrator.
      </p>

      {/* D10: masked by default, revealed by a deliberate audited act. The
          sentence is on screen rather than in a comment -- an operator who sees
          dots and no explanation concludes the data is missing. */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <AdminRevealAddressesButton
          kind="suppression"
          rowIds={rows.map((row) => row.id)}
          allowed={mayRevealAddresses}
        />
      </div>

      <p
        data-testid="email-suppression-provider-notice"
        className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-xs leading-5 text-zinc-400"
      >
        This is our list, not the provider&apos;s. Resend keeps its own
        suppression list across the whole account and region, so an address
        removed here can still be refused there — and a promotion&apos;s
        complaint can refuse a login code no matter what this table says.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-2 pr-4 font-semibold">Address</th>
              <th className="py-2 pr-4 font-semibold">Reason</th>
              <th className="py-2 pr-4 font-semibold">Scope</th>
              <th className="py-2 pr-4 font-semibold">Source</th>
              <th className="py-2 pr-4 font-semibold">Occurred</th>
              <th className="py-2 pr-4 font-semibold">Expires</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  data-testid="email-suppression-empty"
                  className="py-6 text-sm text-zinc-500"
                >
                  No addresses are suppressed.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr
                key={row.id}
                data-testid="email-suppression-row"
                className="border-t border-zinc-900 align-top"
              >
                <td className="py-3 pr-4 font-mono text-xs">
                  <AdminRevealableAddress
                    rowId={row.id}
                    masked={row.emailAddressMasked}
                  />
                </td>
                <td className="py-3 pr-4">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                      REASON_TONE[row.reason] ??
                      "border-zinc-700 bg-zinc-900 text-zinc-300"
                    }`}
                  >
                    {row.reason}
                  </span>
                </td>
                <td className="py-3 pr-4 font-mono text-xs text-zinc-400">
                  {row.scope === "global" ? "all mail" : row.purposeKey}
                </td>
                <td className="py-3 pr-4 font-mono text-xs text-zinc-400">
                  {row.source}
                  {row.sourceClassification ? (
                    <span className="mt-1 block text-[11px] text-zinc-500">
                      {row.sourceClassification}
                    </span>
                  ) : null}
                </td>
                <td className="py-3 pr-4 font-mono text-[11px] text-zinc-500">
                  {when(row.occurredAt)}
                </td>
                <td className="py-3 pr-4 font-mono text-[11px] text-zinc-500">
                  {row.expiresAt ? when(row.expiresAt) : "never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
