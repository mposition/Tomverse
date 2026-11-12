"use client";
import { useState } from "react";
import { useAdminMessages } from "./AdminLocaleProvider";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import type { ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";

export function ScoutMemoryComparison({
  comparison,
}: {
  comparison: NonNullable<ScoutConsoleView["memoryComparison"]>;
}) {
  const m = useAdminMessages(adminProductResearchScoutMessages);
  const [view, setView] = useState<"daily" | "benchmark">(
    comparison.daily.rows.some((r) => r.observed) ? "daily" : "benchmark",
  );
  const [language, setLanguage] = useState("all");
  const data = comparison[view];
  const visible = data.rows.filter(row => language==="all" || row.locale===language);
  const ratio = (n: number, d: number) =>
    d ? `${Math.round((n * 100) / d)}% (${n}/${d})` : "—";
  return (
    <section
      className="rounded-xl border border-zinc-800 p-4"
      data-testid="scout-memory-comparison"
    >
      <h3 className="font-semibold">{m.experimentTitle}</h3>
      <div className="my-2 flex flex-wrap items-center gap-2">
        {(["daily", "benchmark"] as const).map((v) => (
          <button
            type="button"
            key={v}
            aria-pressed={v === view}
            className="rounded border px-2 py-1 text-sm aria-pressed:border-blue-400"
            onClick={() => setView(v)}
          >
            {m.experimentViews[v]}
          </button>
        ))}
        <select aria-label={m.experimentColumns[0]} className="rounded border bg-zinc-900 px-2 py-1 text-sm" value={language} onChange={e=>setLanguage(e.target.value)}>
          <option value="all">{m.experimentAllLanguages}</option>
          {data.rows.map(r=><option value={r.locale} key={r.locale}>{m.languages[r.locale]}</option>)}
        </select>
      </div>
      <p className="text-sm">
        {data.model ?? "—"} · {data.day}
        {view === "daily" && !comparison.enabled && " · " + m.memoryOff}
      </p>
      <p className="my-2 text-xs text-zinc-400">{m.experimentNote}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {m.experimentColumns.map((h) => (
                <th scope="col" key={h} className="p-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          {visible.map(row => <tbody key={row.locale}>
              {row.arms.map((a, i) => (
                <tr
                  key={row.locale + a.arm}
                  className="border-t border-zinc-800"
                >
                  {i === 0 && (
                    <th
                      scope="rowgroup"
                      rowSpan={row.arms.length}
                      className="p-2 align-top"
                    >
                      {m.languages[row.locale]}
                      <small className="block font-normal">
                        {row.pairs} {m.experimentPairs} · {row.observed}{" "}
                        {m.experimentAnswers}
                      </small>
                    </th>
                  )}
                  <th scope="row" className="p-2 font-normal">
                    {m.experimentArms[a.arm]}
                  </th>
                  <td>{ratio(a.retrieved, a.sources)}</td>
                  <td>{ratio(a.decision, a.sources)}</td>
                  <td>{ratio(a.exceptions, a.sources)}</td>
                  <td>{ratio(a.exact, a.sources)}</td>
                  <td>{ratio(a.abstained, a.controls)}</td>
                  <td>
                    {a.elapsedMs === null
                      ? "—"
                      : Math.round(a.elapsedMs) + " ms"}
                  </td>
                  <td>
                    {a.meanMicroUsd === null
                      ? "—"
                      : "$" + (a.meanMicroUsd / 1e6).toFixed(6)}
                  </td>
                </tr>
              ))}
          </tbody>)}
        </table>
      </div>
    </section>
  );
}
