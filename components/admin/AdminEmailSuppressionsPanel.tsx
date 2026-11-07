import {
  AdminRevealableAddress,
  AdminRevealAddressesButton,
} from "@/components/admin/AdminAddressReveal";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import type { AdminSuppressionRow } from "@/lib/adminEmailDeliveries";
import { adminMessagesFor } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminEmailDeliveryMessages } from "@/lib/adminMessages/emailDelivery";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import type { EmailDeliveryMessages } from "@/components/admin/AdminEmailDeliveriesPanel";

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
 *
 * **One row is one selector, not one cause.** An address can be blocked by a
 * hard bounce and a complaint and an unsubscribe at once, and the block is
 * their sum -- so the row shows every active reason, and lifting acts on all of
 * them. Showing a row per cause would repeat the address and invite somebody to
 * lift a third of a block
 * (docs/policy/email-product-news-redesign-draft.md, section 7.4). Each cause
 * keeps its own source and date beside its reason, in one list, so they cannot
 * drift apart the way parallel columns do.
 */

const REASON_TONE: Record<string, AdminTone> = {
  hard_bounce: "bad",
  complaint: "bad",
  privacy_request: "info",
  manual: "warn",
  unsubscribe: "idle",
  soft_bounce: "idle",
};

const when = (value: Date | null) => formatAestDateTime(value, { seconds: true }) ?? "—";

export function AdminEmailSuppressionsView({
  m: messages,
  rows,
  mayRevealAddresses,
}: {
  m: EmailDeliveryMessages;
  /** `null` when the read failed: shown as an error, never as an empty list. */
  rows: AdminSuppressionRow[] | null;
  /** D10: `owner` and `ops`. Resolved on the server. */
  mayRevealAddresses: boolean;
}) {
  const m = messages.suppressions;

  const reasons = (row: AdminSuppressionRow) => (
    <ul className="flex flex-col gap-2">
      {row.causes.map((cause) => (
        <li key={cause.id} className="flex flex-col gap-0.5">
          <span>
            <span data-testid="email-suppression-reason" className="inline-flex">
              <AdminStatusChip tone={REASON_TONE[cause.reason] ?? "idle"}>
                {m.reasons[cause.reason] ?? cause.reason}
              </AdminStatusChip>
            </span>
          </span>
          <span className="font-mono text-xs text-zinc-500">
            {m.source(cause.source)}
            {cause.sourceClassification ? ` (${cause.sourceClassification})` : ""} ·{" "}
            {m.occurred(when(cause.occurredAt))} ·{" "}
            {cause.expiresAt ? m.expires(when(cause.expiresAt)) : m.never}
          </span>
        </li>
      ))}
    </ul>
  );

  const columns: AdminDataColumn<AdminSuppressionRow>[] = [
    {
      key: "address",
      header: m.columns.address,
      render: (row) => (
        <span data-testid="email-suppression-row" className="block font-mono text-xs">
          <AdminRevealableAddress rowId={row.id} masked={row.emailAddressMasked} />
        </span>
      ),
    },
    { key: "reasons", header: m.columns.reason, render: reasons },
    {
      key: "scope",
      header: m.columns.scope,
      render: (row) => (
        <span className="font-mono text-xs text-zinc-400">
          {row.scope === "global" ? m.allMail : row.purposeKey}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile
        title={m.title}
        description={m.intro}
        action={
          rows ? (
            // D10: masked by default, revealed by a deliberate audited act. The
            // sentence is on screen rather than in a comment -- an operator who
            // sees dots and no explanation concludes the data is missing.
            <AdminRevealAddressesButton
              kind="suppression"
              rowIds={rows.map((row) => row.id)}
              allowed={mayRevealAddresses}
            />
          ) : null
        }
      >
        <p
          data-testid="email-suppression-provider-notice"
          className="rounded-xl bg-blue-500/10 px-4 py-3 text-xs leading-5 text-blue-200"
        >
          {m.providerNotice}
        </p>
        {rows ? <p className="text-xs text-zinc-500">{m.count(rows.length)}</p> : null}
      </AdminTile>

      {rows === null ? (
        <AdminStateBlock kind="error" title={messages.deliveries.loadFailed} />
      ) : (
        <AdminDataTable
          caption={m.title}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          cardTitle={(row) => (
            <AdminRevealableAddress rowId={row.id} masked={row.emailAddressMasked} />
          )}
          cardMeta={(row) => (
            <span className="mt-1 block font-normal">
              {row.causes.map((cause) => m.reasons[cause.reason] ?? cause.reason).join(", ")} ·{" "}
              {row.scope === "global" ? m.allMail : row.purposeKey}
            </span>
          )}
          emptyState={
            <div data-testid="email-suppression-empty">
              <AdminStateBlock kind="empty" title={m.empty} />
            </div>
          }
        />
      )}
    </div>
  );
}

export async function AdminEmailSuppressionsPanel(
  props: Omit<Parameters<typeof AdminEmailSuppressionsView>[0], "m">
) {
  const m = adminMessagesFor(adminEmailDeliveryMessages, await getAdminLocale());
  return <AdminEmailSuppressionsView m={m} {...props} />;
}
