import { PackageOpen } from "lucide-react";

import type { PackageImportMetrics } from "@/lib/assistantPackageImportMetricsCore";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminPackageImportMessages } from "@/lib/adminMessages/packageImport";

/**
 * What the package import's telemetry adds up to (Slice 7).
 *
 * docs/policy/assistant-package-import.md §9.
 *
 * A server component with no fetch of its own: the page reads the metrics and
 * hands them over, which is what the admin console's own contract asks for.
 *
 * Everything rendered is a count or a closed enum label. There is nothing here
 * that could be an instruction, a filename or a digest, because the events
 * carry no field any of those could travel in.
 */
export async function AdminPackageImportPanel({
    metrics,
}: {
    metrics: PackageImportMetrics;
}) {
    const m = await getAdminMessages(adminPackageImportMessages);
    const totalEntered = metrics.steps.reduce((sum, step) => sum + step.entered, 0);

    return (
        <section
            className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
            data-testid="admin-package-import"
        >
            <h2 className="flex items-center gap-2 text-sm font-semibold">
                <PackageOpen className="h-4 w-4" aria-hidden="true" />
                {m.title}
                <span className="font-normal text-zinc-500">
                    {m.window(metrics.windowDays)}
                </span>
            </h2>

            {totalEntered === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">
                    {m.empty}
                </p>
            ) : null}

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {m.steps}
            </h3>
            {/*
              Every step, in wizard order, including the ones nobody reached. A
              step missing from this table would read as a step that does not
              exist, and the number worth having is the drop between two
              consecutive rows.
            */}
            <table className="mt-1 w-full text-sm">
                <thead className="text-left text-xs text-zinc-500">
                    <tr>
                        <th className="py-1 font-medium">{m.columns.step}</th>
                        <th className="py-1 text-right font-medium">{m.columns.entered}</th>
                        <th className="py-1 text-right font-medium">{m.columns.leftDeliberately}</th>
                    </tr>
                </thead>
                <tbody>
                    {metrics.steps.map((step) => (
                        <tr key={step.step} className="border-t border-zinc-100 dark:border-zinc-900">
                            <td className="py-1">{step.step}</td>
                            <td className="py-1 text-right tabular-nums">{step.entered}</td>
                            <td className="py-1 text-right tabular-nums">{step.abandoned}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-1 text-xs text-zinc-500">
                {m.stepsNote}
            </p>

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {m.warnings}
            </h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
                {metrics.warnings.map((warning) => (
                    <li key={warning.kind} className="flex justify-between gap-4">
                        <span>{warning.kind}</span>
                        <span className="tabular-nums">{warning.count}</span>
                    </li>
                ))}
            </ul>

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {m.completed}
            </h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
                {metrics.completed.map((entry) => (
                    <li key={entry.source} className="flex justify-between gap-4">
                        <span>{entry.source}</span>
                        <span className="tabular-nums">{entry.count}</span>
                    </li>
                ))}
                <li className="flex justify-between gap-4 border-t border-zinc-100 pt-1 font-semibold dark:border-zinc-900">
                    <span>{m.total}</span>
                    <span className="tabular-nums">{metrics.completedTotal}</span>
                </li>
            </ul>
            <p className="mt-1 text-xs text-zinc-500">
                {m.completedNote}
            </p>
        </section>
    );
}
