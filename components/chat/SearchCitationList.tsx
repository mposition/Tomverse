import type { WebSearchCitation } from "@/lib/webSearchCitations";

export function SearchCitationList({ citations, label }: { citations: WebSearchCitation[]; label: string }) {
  if (citations.length === 0) return null;
  return (
    <div
      data-testid="search-citation-list"
      className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-700/60"
    >
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <ul className="space-y-2">
        {citations.map((citation, citationIndex) => (
          <li
            key={`${citation.url}-${citationIndex}`}
            data-testid="search-citation-item"
            data-reference-number={citation.referenceNumber ?? ""}
            className="flex items-baseline gap-1.5"
          >
            {/*
              The number the answer text already used, shown
              as the provider numbered it. Providers that
              publish no citation order (OpenAI, Anthropic,
              Google inline annotations) leave it undefined
              and the row renders without one -- a made-up
              sequence would point at the wrong source.
            */}
            {citation.referenceNumber !== undefined && (
              <span className="shrink-0 text-xs font-bold tabular-nums text-zinc-400 dark:text-zinc-500">
                [{citation.referenceNumber}]
              </span>
            )}
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              title={citation.url}
              className="truncate py-0.5 text-sm leading-6 font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
            >
              {citation.title || citation.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
