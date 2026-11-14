"use client";

import type { ContinuationReceipt as Receipt } from "@/lib/continuationReceipt";

/** Runtime metadata only: no claims about model understanding or answer success. */
export function ContinuationReceipt({ receipt, t }: { receipt: Receipt; t: (key: string) => string }) {
    const key = receipt.status === "unknown" ? "journey.receiptUnknown"
        : receipt.status === "not_sent" ? "journey.receiptNotSent" : "journey.receiptSent";
    const text = t(key).replaceAll("{selected}", String(receipt.selectedCount))
        .replaceAll("{recent}", String(receipt.recentCount)).replaceAll("{unique}", String(receipt.uniqueMessageCount));
    return <p data-testid="continuation-receipt" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400" role="status">
        {text}{receipt.status === "dispatched" && receipt.partial ? ` · ${t("journey.receiptPartial")}` : ""}
        {receipt.status === "dispatched" && receipt.omitted ? ` · ${t("journey.receiptOmitted")}` : ""}
        {receipt.status === "not_sent" && ["locked", "source_deleted", "empty_selection", "flag_off", "flag_off_stale_cache", "unsupported"].includes(receipt.outcome)
            ? ` · ${t(`journey.receiptReason_${receipt.outcome === "flag_off_stale_cache" ? "flag_off" : receipt.outcome}`)}` : ""}
    </p>;
}
